export async function onRequestPost({ request, env }) {
  if (!env?.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY missing in runtime env" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const marketplace = String(body.marketplace || "").trim();
  const brandVoice = String(body.brand_voice || "").trim();
  const brandName = String(body.brand_name || "").trim();
  const usp = String(body.usp || "").trim();
  const userPrompt = String(body.user_prompt || "").trim();

  const variantsRaw = Number(body.variants || 1);
  const variants = variantsRaw === 3 ? 3 : 1;

  if (!marketplace) return json({ error: "Missing marketplace" }, 400);
  if (!brandName) return json({ error: "Missing brand_name" }, 400);
  if (!userPrompt) return json({ error: "Missing user_prompt" }, 400);

  const langMap = {
    "amazon.de": "German (DE)",
    "amazon.fr": "French (FR)",
    "amazon.it": "Italian (IT)",
    "amazon.es": "Spanish (ES)",
    "amazon.nl": "Dutch (NL)",
    "amazon.pl": "Polish (PL)",
    "amazon.se": "Swedish (SE)",
    "amazon.co.uk": "English (UK)",
  };
  const outLang = langMap[marketplace] || "English";

  // HARD LIMITS per your master prompt
  const CFG = {
    TITLE_MIN: 180,
    TITLE_MAX: 195,
    TITLE_HARD_MAX: 200,
    BULLET_COUNT: 5,
    BULLET_MIN: 220,
    BULLET_MAX: 240,
    DESC_MIN: 3300,
    DESC_MAX: 3700,
    BACKEND_MAX_BYTES: 250,
  };

  // Enable web research via Responses hosted tool
  const tools = [{ type: "web_search" }]; // default external_web_access = true (live)
  const include = ["web_search_call.action.sources"];

  const instructions = buildMasterInstructions({ outLang, marketplace, brandName, cfg: CFG });

  const uspLine = usp ? `USPs: ${usp}` : "";
  const brandVoiceLine = brandVoice ? `Brand voice: ${brandVoice}` : "";

  const input = `Brand name: ${brandName}
Marketplace: ${marketplace}
Output language: ${outLang}
${uspLine}
${brandVoiceLine}

User product info (may include INCI / label text):
${userPrompt}

Variants requested: ${variants === 3 ? "THREE (A/B/C)" : "ONE"}

IMPORTANT:
- If info is missing, make reasonable assumptions and add exactly ONE line at the start of the final output: "Assumptions: ...".
- Do NOT put any URLs anywhere except inside Phase 1 "Източници:" line (only there).`;

  try {
    // 1) First pass
    const first = await callOpenAI(env, instructions, input, {
      max_output_tokens: variants === 3 ? 17000 : 6500,
      temperature: 0.65,
      timeoutMs: 90000,
      tools,
      include,
      reasoning: { effort: "medium" },
    });

    let output = extractText(first);
    if (!output) return json({ error: "Empty output from OpenAI", debug: first }, 500);

    // Ensure sources exist in Phase 1 (use tool sources as fallback)
    const sources = extractWebSources(first);
    output = ensurePhase1Sources(output, sources);

    // Post-process: sanitize backend to ASCII, refresh counters (Chars/Bytes)
    output = postProcessOutput(output, { brandName, cfg: CFG });

    // 2) Validate
    const v1 = validateOutput(output, { brandName, cfg: CFG, variants });
    if (v1.ok) return json({ output }, 200);

    // 3) Repair pass (full rewrite)
    const repairInstructions = `${instructions}

You MUST fix the output to satisfy ALL HARD REQUIREMENTS.
Return the same output format again. Do not add commentary.`;

    const repairInput = `${input}

CURRENT OUTPUT (violations found):
${v1.errors.join("\n")}

Rewrite everything to satisfy the constraints exactly.`;

    const repaired = await callOpenAI(env, repairInstructions, repairInput, {
      max_output_tokens: variants === 3 ? 19000 : 7200,
      temperature: 0.55,
      timeoutMs: 90000,
      tools,
      include,
      reasoning: { effort: "medium" },
    });

    output = extractText(repaired) || output;

    // Ensure sources again (from repaired tool output)
    const sources2 = extractWebSources(repaired);
    output = ensurePhase1Sources(output, sources2.length ? sources2 : sources);

    // Post-process again
    output = postProcessOutput(output, { brandName, cfg: CFG });

    // 4) Validate again
    const v2 = validateOutput(output, { brandName, cfg: CFG, variants });
    if (v2.ok) return json({ output }, 200);

    // 5) Targeted repairs (best-effort, limited calls)
    // If we cannot parse reliably, return best effort output
    const phase2 = extractPhase2(output);
    if (!phase2) return json({ output }, 200);

    let final = output;
    const flags = classifyErrors(v2.errors);

    // Fix Titles only (per variant)
    if (flags.titles) {
      final = await fixTitlesAllVariants(env, final, {
        outLang,
        marketplace,
        brandName,
        usp,
        brandVoice,
        userPrompt,
        cfg: CFG,
        variants,
      });
    }

    // Fix Bullets only (per variant)
    if (flags.bullets) {
      final = await fixBulletsAllVariants(env, final, {
        outLang,
        marketplace,
        brandName,
        usp,
        brandVoice,
        userPrompt,
        cfg: CFG,
        variants,
      });
    }

    // Fix Description only (per variant)
    if (flags.description) {
      final = await fixDescriptionAllVariants(env, final, {
        outLang,
        marketplace,
        brandName,
        usp,
        brandVoice,
        userPrompt,
        cfg: CFG,
        variants,
      });
    }

    // Fix Backend only (per variant)
    if (flags.backend) {
      final = await fixBackendAllVariants(env, final, {
        outLang,
        marketplace,
        brandName,
        usp,
        brandVoice,
        userPrompt,
        cfg: CFG,
        variants,
      });
    }

    // Final post-process + validate
    final = postProcessOutput(final, { brandName, cfg: CFG });
    const v3 = validateOutput(final, { brandName, cfg: CFG, variants });

    // Return final (even if still imperfect, this is the best effort within limited passes)
    return json({ output: final, ok: v3.ok, remaining_issues: v3.ok ? [] : v3.errors }, 200);
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Timeout while calling OpenAI. Try again."
        : String(e?.message || e || "Server error");
    return json({ error: msg }, 500);
  }
}

/* ---------------- MASTER PROMPT (embedded) ---------------- */

function buildMasterInstructions({ outLang, marketplace, brandName, cfg }) {
  return `ROLE
You are "Amazon Listing Assistant" for EU sellers. Focus on ${marketplace}. You work in 2 phases: RESEARCH → CREATION.
Write professionally, clear, factual, without exaggerated marketing. Do NOT reveal internal reasoning. Output is copy-ready.

TOOLS / BEHAVIOR
- ALWAYS do web research before writing: Amazon listings (official), brand official sites, credible ingredient references, reputable aggregators.
- You may use web search tool.
- IMPORTANT: URLs/links are allowed ONLY in Phase 1 section line "• Източници: [...] [...]". Nowhere else.

COMPLIANCE
- No medical/healing claims. No promises/guarantees. No "klinisch bewiesen/dermatologisch getestet" unless user provided proof.
- Avoid "Best Seller/Top/No.1".
- Use soft wording where needed (e.g., "optisch", "unterstützt").

LOCALIZATION / FORMAT
- Output language for client fields: ${outLang}.
- For amazon.de: capitalize German nouns, use digits (not words), put a space before units (50 ml, 200 g).
- No ALL CAPS, no emojis in client fields.
- No Cyrillic in client fields (Title, Bullets, Description, Backend, Attributes).
- Avoid repeating the same word more than 2 times in a Title.
- Do not mention competitor brands or other trademarks in Title/Bullets/Backend.

INCI
- In field "Active Ingredients (comma-separated)" put INCI exactly 1:1 from user-provided label text. If not provided, write "Not provided".

HARD LIMITS / COUNTERS
- Titles: EXACTLY 2 titles, each ${cfg.TITLE_MIN}–${cfg.TITLE_MAX} characters (hard max ${cfg.TITLE_HARD_MAX}). Show (Chars: X) after each title line.
- Bullets: EXACTLY ${cfg.BULLET_COUNT} bullets. Each bullet MUST be ${cfg.BULLET_MIN}–${cfg.BULLET_MAX} characters (including spaces).
  Each bullet must be ONE line and start with: "• **Short Label**: " (label not ALL CAPS), then text. No URLs.
- Description: MUST be ${cfg.DESC_MIN}–${cfg.DESC_MAX} characters total (including spaces). Multi-paragraph, mobile readable. No URLs.
- Backend Generic Keywords: ONE line only, space-separated only, ASCII only (ä→ae ö→oe ü→ue ß→ss). ≤ ${cfg.BACKEND_MAX_BYTES} bytes. Show (Bytes: Y).

KEYWORDS
- Derive core + long-tail keywords from competitor/bestseller research (frequency, relevance, intent).
- Include Umlaut + ae/oe/ue variants; singular/plural; bindestrich variants; avoid duplicates.

OUTPUT FORMAT (MUST match exactly; headings may be Bulgarian, but client fields must be in ${outLang} and not Cyrillic):

ФАЗА 1 · РЕСЪРЧ (резюме)
• Топ ключови думи : ...
• Title шаблони (3–5): ...
• Повтарящи ползи (5–7): ...
• Диференциатори (3–5): ...
• Източници: [link 1] [link 2] ...

ФАЗА 2 · ЛИСТИНГ
${marketplace === "amazon.de" ? "(All client fields in German.)" : "(All client fields in the output language.)"}

If 3 variants requested, output:
VARIANT A
... full Phase 2 block ...
VARIANT B
... full Phase 2 block ...
VARIANT C
... full Phase 2 block ...

Otherwise, output ONE Phase 2 block (no VARIANT lines).

Phase 2 block structure:
Titles (2 варианта):
1. ... (Chars: X)
2. ... (Chars: Y)
Bullet Points (5):
• **...**: ...
• **...**: ...
• **...**: ...
• **...**: ...
• **...**: ...
Product Description (Chars: Z)
<description text>
Backend — Generic Keywords (1 ред) (Bytes: Y):
<one-line keywords>
Active Ingredients (черта със запетайки):
<INCI or Not provided>
Compliance note (ако е нужно): ...
• Special Features – 1 ред
• Benefits – 3 на брой
• Special Ingredients – търговските наименования
• Material Features – 1 ред
• Material Type Free – 1 ред
• Active Ingredients – търговски наименования
• Recommended Uses For Product – 1 изречение (DE or local language)
• Scent – 1 ред
• Safety Warning – 1 ред
• Directions – 1 ред
Attributes (препоръка за попълване):
• Size: ...
• Skin type: ...
• Benefits: ...
• Recommended use: ...
QA & Compliance Check:
• ✅/⚠️ ... (one line per criterion)

IMPORTANT:
- Do NOT include any URLs in Phase 2 or client fields. Only Phase 1 Sources line may contain URLs.
- Keep bullets one-line each.
- Return only the formatted content, no extra commentary.`;
}

/* ---------------- VALIDATION ---------------- */

function validateOutput(text, { brandName, cfg, variants }) {
  const errors = [];
  const s = String(text || "").trim();
  if (!s) return { ok: false, errors: ["Empty output"] };

  // Phase markers (soft requirement, but helps parsing)
  if (!/ФАЗА\s*1/i.test(s) || !/ФАЗА\s*2/i.test(s)) {
    errors.push("Missing Phase 1 and/or Phase 2 headings (ФАЗА 1 / ФАЗА 2).");
  }

  // URLs must ONLY appear in Phase 1 Sources line
  const urlViolations = findUrlsOutsidePhase1Sources(s);
  if (urlViolations.length) {
    errors.push(`URLs found outside Phase 1 Sources line: ${urlViolations.slice(0, 5).join(", ")}${urlViolations.length > 5 ? "..." : ""}`);
  }

  const phase2 = extractPhase2(s);
  if (!phase2) {
    errors.push("Cannot find Phase 2 block.");
    return { ok: errors.length === 0, errors };
  }

  const vBlocks = splitVariantsPhase2(phase2, variants);
  for (const vb of vBlocks) {
    const label = vb.label || "OUTPUT";
    const block = vb.text || "";

    // Extract sections
    const titlesBlock = extractSection(block, /Titles\s*\(2/i, /Bullet\s*Points/i);
    const bulletsBlock = extractSection(block, /Bullet\s*Points\s*\(5\)\s*:/i, /Product\s*Description/i);
    const descBlock = extractSection(block, /Product\s*Description/i, /Backend/i);
    const backendBlock = extractSection(block, /Backend\s*[—-]/i, /Active\s*Ingredients/i) ||
      extractSection(block, /Backend\s*[—-]/i, /Compliance\s*note/i) ||
      extractSection(block, /Backend\s*[—-]/i, /•\s*Special\s*Features/i);

    if (!titlesBlock) errors.push(`${label}: Missing Titles section.`);
    if (!bulletsBlock) errors.push(`${label}: Missing Bullet Points section.`);
    if (!descBlock) errors.push(`${label}: Missing Product Description section.`);
    if (!backendBlock) errors.push(`${label}: Missing Backend section.`);

    // Validate titles
    const titles = parseTwoTitlesFromTitlesBlock(titlesBlock);
    if (titles.length !== 2) {
      errors.push(`${label}: titles found = ${titles.length}, expected 2`);
    } else {
      titles.forEach((t, i) => {
        const titleText = stripCounterSuffix(t);
        const len = titleText.length;
        if (len < cfg.TITLE_MIN || len > cfg.TITLE_MAX || len > cfg.TITLE_HARD_MAX) {
          errors.push(`${label}: title ${i + 1} length = ${len}, expected ${cfg.TITLE_MIN}-${cfg.TITLE_MAX} (hard ≤${cfg.TITLE_HARD_MAX})`);
        }
        if (!startsWithBrand(titleText, brandName)) {
          errors.push(`${label}: title ${i + 1} does not start with brand name.`);
        }
        if (containsCyrillic(titleText)) {
          errors.push(`${label}: title ${i + 1} contains Cyrillic (not allowed).`);
        }
        if (containsEmoji(titleText)) {
          errors.push(`${label}: title ${i + 1} contains emoji (not allowed).`);
        }
        const rep = maxWordRepetition(titleText);
        if (rep > 2) {
          errors.push(`${label}: title ${i + 1} repeats a word ${rep} times (>2).`);
        }
      });
    }

    // Validate bullets
    const bullets = parseBulletsFromBulletsBlock(bulletsBlock);
    if (bullets.length !== cfg.BULLET_COUNT) {
      errors.push(`${label}: bullets count = ${bullets.length}, expected ${cfg.BULLET_COUNT}`);
    } else {
      bullets.forEach((b, i) => {
        const bNorm = normalizeOneLine(b);
        const len = bNorm.length;
        if (len < cfg.BULLET_MIN || len > cfg.BULLET_MAX) {
          errors.push(`${label}: bullet ${i + 1} length = ${len}, expected ${cfg.BULLET_MIN}-${cfg.BULLET_MAX}`);
        }
        if (!/^•\s*\*\*.+\*\*:\s+/.test(bNorm)) {
          errors.push(`${label}: bullet ${i + 1} format must start with "• **Label**: "`);
        }
        const labelText = (bNorm.match(/^•\s*\*\*(.+?)\*\*:/) || [])[1] || "";
        if (labelText && isAllCaps(labelText)) {
          errors.push(`${label}: bullet ${i + 1} label is ALL CAPS (not allowed).`);
        }
        if (containsCyrillic(bNorm)) {
          errors.push(`${label}: bullet ${i + 1} contains Cyrillic (not allowed).`);
        }
        if (containsEmoji(bNorm)) {
          errors.push(`${label}: bullet ${i + 1} contains emoji (not allowed).`);
        }
      });
    }

    // Validate description length
    const descText = stripDescriptionHeading(descBlock);
    const descLen = descText.length;
    if (descLen < cfg.DESC_MIN || descLen > cfg.DESC_MAX) {
      errors.push(`${label}: description length = ${descLen}, expected ${cfg.DESC_MIN}-${cfg.DESC_MAX}`);
    }
    if (containsCyrillic(descText)) {
      errors.push(`${label}: description contains Cyrillic (not allowed).`);
    }
    if (containsEmoji(descText)) {
      errors.push(`${label}: description contains emoji (not allowed).`);
    }

    // Validate backend bytes, ASCII only, one line, no brand
    const backendLine = parseBackendLine(backendBlock);
    const backendAscii = asciiNormalizeBackend(backendLine);
    const bytes = byteLen(backendAscii);
    if (bytes > cfg.BACKEND_MAX_BYTES) {
      errors.push(`${label}: backend bytes = ${bytes}, expected ≤ ${cfg.BACKEND_MAX_BYTES}`);
    }
    if (backendAscii !== backendLine) {
      // Not a hard error (we post-process), but still flag if it's far off
      if (/[^\x00-\x7F]/.test(backendLine)) {
        errors.push(`${label}: backend contains non-ASCII (must be ASCII only).`);
      }
    }
    if (containsCyrillic(backendLine)) {
      errors.push(`${label}: backend contains Cyrillic (not allowed).`);
    }
    if (containsEmoji(backendLine)) {
      errors.push(`${label}: backend contains emoji (not allowed).`);
    }
    if (includesBrand(backendLine, brandName)) {
      errors.push(`${label}: backend contains brand name (not allowed).`);
    }
    if (backendLine.includes(",") || backendLine.includes(";")) {
      errors.push(`${label}: backend must be space-separated only (no commas/semicolons).`);
    }
    if (backendLine.split("\n").length > 1) {
      errors.push(`${label}: backend must be one line only.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function classifyErrors(errors) {
  const e = (errors || []).join("\n").toLowerCase();
  return {
    titles: e.includes("title"),
    bullets: e.includes("bullet"),
    description: e.includes("description"),
    backend: e.includes("backend"),
    urls: e.includes("url"),
    format: e.includes("missing") || e.includes("cannot find"),
  };
}

/* ---------------- POST-PROCESSING ---------------- */

function postProcessOutput(text, { brandName, cfg }) {
  let s = String(text || "").trim();
  if (!s) return s;

  // 1) Sanitize backend lines to ASCII and update Bytes counters
  s = sanitizeAllBackendLines(s, brandName);

  // 2) Refresh all (Chars: X) and (Bytes: Y) counters based on actual text
  s = refreshCounters(s);

  // 3) Ensure still trimmed
  return s.trim();

  function sanitizeAllBackendLines(input, bn) {
    const phase2 = extractPhase2(input);
    if (!phase2) return input;

    const before = input.slice(0, input.indexOf(phase2));
    let p2 = phase2;

    const vBlocks = splitVariantsPhase2(p2, 3); // parse any present
    const rebuilt = vBlocks.map(vb => {
      let block = vb.text;
      const backendBlock = extractSection(block, /Backend\s*[—-]/i, /Active\s*Ingredients/i) ||
        extractSection(block, /Backend\s*[—-]/i, /Compliance\s*note/i) ||
        extractSection(block, /Backend\s*[—-]/i, /•\s*Special\s*Features/i);

      if (!backendBlock) return { label: vb.label, text: block };

      const backendLine = parseBackendLine(backendBlock);
      let clean = asciiNormalizeBackend(backendLine);
      clean = removeBrandFromBackend(clean, bn);
      clean = collapseSpaces(clean);

      // Replace only the backend line (first non-empty line after backend heading)
      block = replaceBackendLineInBlock(block, clean);
      return { label: vb.label, text: block };
    });

    // Rebuild Phase 2 with variants if present
    const hasVariants = /VARIANT\s+[ABC]/i.test(p2);
    const header = extractPhase2Header(p2) || "ФАЗА 2 · ЛИСТИНГ";
    const joined = hasVariants
      ? [header, ...rebuilt.flatMap(r => [r.label, r.text].filter(Boolean))].join("\n").trim()
      : [header, rebuilt[0]?.text || p2].join("\n").trim();

    return (before + joined).trim();
  }

  function refreshCounters(input) {
    // Titles counters
    input = input.replace(/^\s*1\.\s*(.+?)(\s*\(Chars:\s*\d+\s*\))?\s*$/gim, (m, t) => {
      const title = stripCounterSuffix(String(t || "")).trim();
      return `1. ${title} (Chars: ${title.length})`;
    });
    input = input.replace(/^\s*2\.\s*(.+?)(\s*\(Chars:\s*\d+\s*\))?\s*$/gim, (m, t) => {
      const title = stripCounterSuffix(String(t || "")).trim();
      return `2. ${title} (Chars: ${title.length})`;
    });

    // Product Description counter line: "Product Description (Chars: Z)"
    input = input.replace(/^(Product\s*Description)\s*\(Chars:\s*\d+\s*\)\s*$/gim, (m, a) => {
      const block = extractSectionAround(input, /Product\s*Description/i, /Backend/i);
      if (!block) return `${a} (Chars: 0)`;
      const descText = stripDescriptionHeading(block);
      return `${a} (Chars: ${descText.length})`;
    });

    // Backend bytes counter line: "Backend — Generic Keywords ... (Bytes: Y):"
    input = input.replace(/^(Backend\s*[—-]\s*Generic\s*Keywords.*)\(Bytes:\s*\d+\s*\)(\s*:?\s*)$/gim, (m, a, b) => {
      const block = extractSectionAround(input, /Backend\s*[—-]/i, /Active\s*Ingredients/i) ||
        extractSectionAround(input, /Backend\s*[—-]/i, /Compliance\s*note/i) ||
        extractSectionAround(input, /Backend\s*[—-]/i, /•\s*Special\s*Features/i);
      if (!block) return `${a}(Bytes: 0)${b}`;
      const backendLine = parseBackendLine(block);
      const backendAscii = asciiNormalizeBackend(backendLine);
      const bytes = byteLen(backendAscii);
      return `${a}(Bytes: ${bytes})${b}`;
    });

    // If backend header is missing bytes, add it
    input = input.replace(/^(Backend\s*[—-]\s*Generic\s*Keywords\s*\(1\s*ред\))\s*:\s*$/gim, (m, a) => {
      const block = extractSectionAround(input, /Backend\s*[—-]/i, /Active\s*Ingredients/i) ||
        extractSectionAround(input, /Backend\s*[—-]/i, /Compliance\s*note/i) ||
        extractSectionAround(input, /Backend\s*[—-]/i, /•\s*Special\s*Features/i);
      const backendLine = block ? parseBackendLine(block) : "";
      const backendAscii = asciiNormalizeBackend(backendLine);
      const bytes = byteLen(backendAscii);
      return `${a} (Bytes: ${bytes}):`;
    });

    return input;
  }
}

/* ---------------- TARGETED FIXES ---------------- */

async function fixTitlesAllVariants(env, fullText, ctx) {
  const phase2 = extractPhase2(fullText);
  if (!phase2) return fullText;

  const vBlocks = splitVariantsPhase2(phase2, ctx.variants);
  const fixedBlocks = [];

  for (const vb of vBlocks) {
    const block = vb.text || "";
    const titlesBlock = extractSection(block, /Titles\s*\(2/i, /Bullet\s*Points/i);
    if (!titlesBlock) {
      fixedBlocks.push(vb);
      continue;
    }

    const instr = `You are an Amazon listing copywriter.

HARD REQUIREMENTS:
- Language: ${ctx.outLang}
- Output ONLY the Titles section content (no headings), exactly:
1. <title> (Chars: X)
2. <title> (Chars: Y)
- Each title ${ctx.cfg.TITLE_MIN}-${ctx.cfg.TITLE_MAX} chars (hard ≤${ctx.cfg.TITLE_HARD_MAX})
- Must start with brand name "${ctx.brandName}"
- No ALL CAPS, no emojis, no Cyrillic, no URLs
- Avoid repeating the same word more than 2 times in a title
- No competitor brands/trademarks`;

    const inp = `Marketplace: ${ctx.marketplace}
Brand: ${ctx.brandName}
USPs: ${ctx.usp || "(none)"}
Brand voice: ${ctx.brandVoice || "(none)"}

Product info:
${ctx.userPrompt}

Write two distinct title patterns:
1) Conservative SEO (readable)
2) More aggressive SEO (still readable, no stuffing)`;

    const data = await callOpenAI(env, instr, inp, {
      max_output_tokens: 900,
      temperature: 0.45,
      timeoutMs: 60000,
    });

    const out = extractText(data);
    const cleaned = String(out || "").trim();
    if (!cleaned) {
      fixedBlocks.push(vb);
      continue;
    }

    // Replace Titles section body (lines between "Titles..." and "Bullet Points")
    const newBlock = replaceSection(block, /Titles\s*\(2[^]*?\)\s*:\s*/i, /Bullet\s*Points/i, `Titles (2 варианта):\n${cleaned}\n`);
    fixedBlocks.push({ label: vb.label, text: newBlock });
  }

  return rebuildPhase2(fullText, fixedBlocks);
}

async function fixBulletsAllVariants(env, fullText, ctx) {
  const phase2 = extractPhase2(fullText);
  if (!phase2) return fullText;

  const vBlocks = splitVariantsPhase2(phase2, ctx.variants);
  const fixedBlocks = [];

  for (const vb of vBlocks) {
    const block = vb.text || "";
    const bulletsBlock = extractSection(block, /Bullet\s*Points\s*\(5\)\s*:/i, /Product\s*Description/i);
    if (!bulletsBlock) {
      fixedBlocks.push(vb);
      continue;
    }

    const instr = `You are an Amazon listing copywriter.

HARD REQUIREMENTS:
- Language: ${ctx.outLang}
- Output ONLY the 5 bullet lines (no headings), each on ONE line.
- EXACTLY 5 bullets.
- Each bullet MUST be ${ctx.cfg.BULLET_MIN}-${ctx.cfg.BULLET_MAX} characters (including spaces).
- Format per line: "• **Short Label**: text"
- Label must NOT be ALL CAPS. No emojis. No Cyrillic. No URLs. No medical claims.`;

    const inp = `Marketplace: ${ctx.marketplace}
Brand: ${ctx.brandName}
USPs: ${ctx.usp || "(none)"}
Brand voice: ${ctx.brandVoice || "(none)"}

Product info:
${ctx.userPrompt}

Write 5 bullets covering:
1) Strong non-medical benefit
2) Key ingredients + general effect
3) Usage/frequency/texture/convenience
4) Who it's for / scenarios
5) Differentiator vs typical competitors (without naming other brands)`;

    const data = await callOpenAI(env, instr, inp, {
      max_output_tokens: 1400,
      temperature: 0.45,
      timeoutMs: 60000,
    });

    const out = extractText(data);
    const cleaned = String(out || "").trim();
    if (!cleaned) {
      fixedBlocks.push(vb);
      continue;
    }

    const newBlock = replaceSection(block, /Bullet\s*Points\s*\(5\)\s*:\s*/i, /Product\s*Description/i, `Bullet Points (5):\n${cleaned}\n\nProduct Description`);
    fixedBlocks.push({ label: vb.label, text: newBlock });
  }

  return rebuildPhase2(fullText, fixedBlocks);
}

async function fixDescriptionAllVariants(env, fullText, ctx) {
  const phase2 = extractPhase2(fullText);
  if (!phase2) return fullText;

  const vBlocks = splitVariantsPhase2(phase2, ctx.variants);
  const fixedBlocks = [];

  for (const vb of vBlocks) {
    const block = vb.text || "";
    const descBlock = extractSection(block, /Product\s*Description/i, /Backend/i);
    if (!descBlock) {
      fixedBlocks.push(vb);
      continue;
    }

    const currentDesc = stripDescriptionHeading(descBlock);

    const instr = `You are an Amazon listing copywriter.

HARD REQUIREMENTS:
- Language: ${ctx.outLang}
- DESCRIPTION length MUST be ${ctx.cfg.DESC_MIN}-${ctx.cfg.DESC_MAX} characters (including spaces).
- Multi-paragraph, mobile readable, conversion-oriented but factual.
- No URLs, no emojis, no Cyrillic, no medical claims, no guarantees.
- Output ONLY the description text (no headings, no counters).`;

    const inp = `Marketplace: ${ctx.marketplace}
Brand: ${ctx.brandName}
USPs: ${ctx.usp || "(none)"}
Brand voice: ${ctx.brandVoice || "(none)"}

Product info:
${ctx.userPrompt}

Current description (rewrite):
${currentDesc}

Rewrite to meet length requirement and policy constraints.`;

    const data = await callOpenAI(env, instr, inp, {
      max_output_tokens: 3200,
      temperature: 0.4,
      timeoutMs: 60000,
    });

    const out = extractText(data);
    const cleaned = String(out || "").trim();
    const len = cleaned.length;

    if (len < ctx.cfg.DESC_MIN || len > ctx.cfg.DESC_MAX) {
      fixedBlocks.push(vb);
      continue;
    }

    const newBlock = replaceDescriptionInBlock(block, cleaned);
    fixedBlocks.push({ label: vb.label, text: newBlock });
  }

  return rebuildPhase2(fullText, fixedBlocks);
}

async function fixBackendAllVariants(env, fullText, ctx) {
  const phase2 = extractPhase2(fullText);
  if (!phase2) return fullText;

  const vBlocks = splitVariantsPhase2(phase2, ctx.variants);
  const fixedBlocks = [];

  for (const vb of vBlocks) {
    const block = vb.text || "";
    const backendBlock = extractSection(block, /Backend\s*[—-]/i, /Active\s*Ingredients/i) ||
      extractSection(block, /Backend\s*[—-]/i, /Compliance\s*note/i) ||
      extractSection(block, /Backend\s*[—-]/i, /•\s*Special\s*Features/i);

    if (!backendBlock) {
      fixedBlocks.push(vb);
      continue;
    }

    const instr = `You are an Amazon SEO listing specialist.

HARD REQUIREMENTS:
- Output ONLY ONE LINE of backend search terms.
- ASCII only; use ae/oe/ue, ss.
- Space-separated only (no commas, no punctuation).
- Must NOT include the brand name "${ctx.brandName}" or competitor brands.
- Must NOT duplicate obvious Title phrases verbatim.
- Must be ≤ ${ctx.cfg.BACKEND_MAX_BYTES} bytes in ASCII.
- No URLs, no emojis, no Cyrillic.`;

    const inp = `Marketplace: ${ctx.marketplace}
Language: ${ctx.outLang}
Product info:
${ctx.userPrompt}

Generate backend search terms for intent coverage (use-case, concern, format, ingredient, size, pack).
Include umlaut variants via ae/oe/ue forms (ASCII). Avoid duplicates.`;

    const data = await callOpenAI(env, instr, inp, {
      max_output_tokens: 300,
      temperature: 0.35,
      timeoutMs: 60000,
    });

    let out = extractText(data);
    out = collapseSpaces(asciiNormalizeBackend(String(out || "")));
    out = removeBrandFromBackend(out, ctx.brandName);

    if (!out) {
      fixedBlocks.push(vb);
      continue;
    }

    const bytes = byteLen(out);
    if (bytes > ctx.cfg.BACKEND_MAX_BYTES) {
      // Hard-trim by tokens (split) as last resort
      out = hardTrimBackendToBytes(out, ctx.cfg.BACKEND_MAX_BYTES);
    }

    const newBlock = replaceBackendLineInBlock(block, out);
    fixedBlocks.push({ label: vb.label, text: newBlock });
  }

  return rebuildPhase2(fullText, fixedBlocks);
}

/* ---------------- PHASE / VARIANT HELPERS ---------------- */

function extractPhase2(text) {
  const s = String(text || "");
  const m = /(ФАЗА\s*2\s*[·:\-–]\s*ЛИСТИНГ)/i.exec(s);
  if (!m) return "";
  const idx = m.index;
  return s.slice(idx).trim();
}

function extractPhase2Header(phase2) {
  const firstLine = String(phase2 || "").split("\n")[0]?.trim() || "";
  if (/ФАЗА\s*2/i.test(firstLine)) return firstLine;
  return "";
}

function splitVariantsPhase2(phase2Text, variantsExpected) {
  const s = String(phase2Text || "").trim();
  // Remove the first header line ("ФАЗА 2 · ЛИСТИНГ")
  const lines = s.split("\n");
  const header = lines[0] || "";
  const rest = lines.slice(1).join("\n").trim();

  const re = /\bVARIANT\s+[ABC]\b/gi;
  const matches = [];
  let m;
  while ((m = re.exec(rest)) !== null) {
    matches.push({ idx: m.index, label: m[0].toUpperCase() });
  }

  if (!matches.length) {
    return [{ label: "", text: rest || "" }];
  }

  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : rest.length;
    const chunk = rest.slice(start, end).trim();
    const firstLine = chunk.split("\n")[0].trim(); // "VARIANT A"
    out.push({ label: firstLine, text: chunk.slice(firstLine.length).trim() });
  }

  // If caller expected 1, still return parsed blocks
  if (variantsExpected === 1 && out.length > 1) return [out[0]];
  return out;
}

function rebuildPhase2(fullText, variantBlocks) {
  const s = String(fullText || "");
  const phase2 = extractPhase2(s);
  if (!phase2) return s;

  const before = s.slice(0, s.indexOf(phase2)).trimEnd();
  const header = extractPhase2Header(phase2) || "ФАЗА 2 · ЛИСТИНГ";

  const hadVariants = /VARIANT\s+[ABC]/i.test(phase2);
  const rebuilt = hadVariants
    ? [header, ...variantBlocks.flatMap(v => [v.label, v.text].filter(Boolean))].join("\n").trim()
    : [header, variantBlocks[0]?.text || ""].join("\n").trim();

  return (before + "\n" + rebuilt).trim();
}

/* ---------------- SECTION PARSING ---------------- */

function extractSection(text, startRe, endRe) {
  const s = String(text || "");
  const start = findRegexIndex(s, startRe);
  if (start < 0) return "";
  const from = start;
  const tail = s.slice(from);
  const end = findRegexIndex(tail, endRe);
  if (end < 0) return tail.trim();
  return tail.slice(0, end).trim();
}

function extractSectionAround(full, startRe, endRe) {
  const s = String(full || "");
  const start = findRegexIndex(s, startRe);
  if (start < 0) return "";
  const tail = s.slice(start);
  const end = findRegexIndex(tail, endRe);
  if (end < 0) return tail;
  return tail.slice(0, end);
}

function findRegexIndex(s, re) {
  const rx = re instanceof RegExp ? new RegExp(re.source, re.flags.replace("g", "")) : new RegExp(re);
  const m = rx.exec(s);
  return m ? m.index : -1;
}

function parseTwoTitlesFromTitlesBlock(titlesBlock) {
  const lines = String(titlesBlock || "").split("\n").map(l => l.trim()).filter(Boolean);
  const t1 = lines.find(l => /^1\./.test(l)) || "";
  const t2 = lines.find(l => /^2\./.test(l)) || "";
  const out = [];
  if (t1) out.push(t1.replace(/^1\.\s*/, "").trim());
  if (t2) out.push(t2.replace(/^2\.\s*/, "").trim());
  return out;
}

function parseBulletsFromBulletsBlock(bulletsBlock) {
  const lines = String(bulletsBlock || "").split("\n").map(l => l.trim()).filter(Boolean);
  // keep only bullet lines that start with "•"
  const bullets = lines.filter(l => l.startsWith("•"));
  return bullets.slice(0, 5);
}

function stripDescriptionHeading(descBlock) {
  const lines = String(descBlock || "").split("\n");
  // Remove first line containing "Product Description"
  const filtered = lines.filter((l, idx) => {
    if (idx === 0 && /Product\s*Description/i.test(l)) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

function parseBackendLine(backendBlock) {
  const lines = String(backendBlock || "").split("\n").map(l => l.trim());
  // Find first line that is not the backend heading itself
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (/^Backend\s*[—-]/i.test(l)) continue;
    if (/^\(Bytes:/i.test(l)) continue;
    // If the heading ended with ":" and keywords are on same line, handle it
    if (/:$/.test(l) && /^Backend/i.test(l)) continue;
    return l;
  }
  return "";
}

/* ---------------- REPLACERS ---------------- */

function replaceSection(block, startHeaderRe, endHeaderRe, replacementWithHeaders) {
  // Replace from after the start header match until the end header match position
  const s = String(block || "");
  const startIdx = findRegexIndex(s, startHeaderRe);
  if (startIdx < 0) return s;

  const startRx = new RegExp(startHeaderRe.source, startHeaderRe.flags.replace("g", ""));
  const startMatch = startRx.exec(s);
  if (!startMatch) return s;

  const afterStart = startMatch.index + startMatch[0].length;
  const tail = s.slice(afterStart);

  const endIdxInTail = findRegexIndex(tail, endHeaderRe);
  if (endIdxInTail < 0) {
    return s.slice(0, startMatch.index) + replacementWithHeaders;
  }

  const before = s.slice(0, startMatch.index);
  const after = tail.slice(endIdxInTail); // includes end header
  return (before + replacementWithHeaders + after).trim();
}

function replaceDescriptionInBlock(block, newDesc) {
  const s = String(block || "");
  const startIdx = findRegexIndex(s, /Product\s*Description/i);
  const endIdx = findRegexIndex(s, /Backend/i);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return s;

  const before = s.slice(0, startIdx);
  const after = s.slice(endIdx);

  // Keep the first line "Product Description (Chars: Z)" from original, but we'll refresh counters later
  const firstLineEnd = s.indexOf("\n", startIdx);
  const descHeaderLine = firstLineEnd >= 0 ? s.slice(startIdx, firstLineEnd).trim() : "Product Description (Chars: 0)";
  const rebuilt = `${before.trimEnd()}
${descHeaderLine}
${String(newDesc || "").trim()}

${after.trimStart()}`.trim();

  return rebuilt;
}

function replaceBackendLineInBlock(block, newBackendLine) {
  const s = String(block || "");
  const startIdx = findRegexIndex(s, /Backend\s*[—-]/i);
  if (startIdx < 0) return s;

  // Find the first non-empty line after backend header line
  const lines = s.split("\n");
  let backendHeaderLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Backend\s*[—-]/i.test(lines[i])) {
      backendHeaderLineIndex = i;
      break;
    }
  }
  if (backendHeaderLineIndex < 0) return s;

  // Replace the first non-empty non-heading line after header
  for (let j = backendHeaderLineIndex + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (!l) continue;
    if (/^Active\s*Ingredients/i.test(l)) break;
    if (/^Compliance\s*note/i.test(l)) break;
    if (/^•\s*Special\s*Features/i.test(l)) break;
    lines[j] = String(newBackendLine || "").trim();
    return lines.join("\n");
  }

  // If no keyword line found, insert one after header
  lines.splice(backendHeaderLineIndex + 1, 0, String(newBackendLine || "").trim());
  return lines.join("\n");
}

/* ---------------- URL RULES ---------------- */

function ensurePhase1Sources(text, urls) {
  let s = String(text || "").trim();
  if (!s) return s;

  // If there's already a Phase 1 Sources line with at least one URL, keep it
  const hasSourcesLine = /•\s*Източници\s*:\s*\[.+?\]/i.test(s);
  if (hasSourcesLine) return s;

  // Try to insert after Phase 1 block end; if not found, append near top
  const insertUrls = (urls || [])
    .map(u => String(u || "").trim())
    .filter(u => /^https?:\/\//i.test(u))
    .slice(0, 15);

  if (!insertUrls.length) {
    // add placeholder
    insertUrls.push("https://www.amazon.de/");
  }

  const sourcesLine = `• Източници: ${insertUrls.map(u => `[${u}]`).join(" ")}`;

  if (/ФАЗА\s*1/i.test(s)) {
    // Insert after the line that starts with "• Диференциатори"
    const lines = s.split("\n");
    let inserted = false;
    const out = [];
    for (const line of lines) {
      out.push(line);
      if (!inserted && /•\s*Диференциатори/i.test(line)) {
        // If next lines already contain sources, don't add
        inserted = true;
        out.push(sourcesLine);
      }
    }
    if (!inserted) out.unshift(sourcesLine);
    return out.join("\n").trim();
  }

  return `${sourcesLine}\n\n${s}`.trim();
}

function findUrlsOutsidePhase1Sources(text) {
  const s = String(text || "");
  const urls = [...s.matchAll(/https?:\/\/[^\s\]]+/gi)].map(m => m[0]);

  if (!urls.length) return [];

  // Allow URLs only on the "• Източници:" line (entire line)
  const lines = s.split("\n");
  const allowedUrls = new Set();
  for (const line of lines) {
    if (/•\s*Източници\s*:/i.test(line)) {
      const inLine = [...line.matchAll(/https?:\/\/[^\s\]]+/gi)].map(m => m[0]);
      inLine.forEach(u => allowedUrls.add(u));
    }
  }

  return urls.filter(u => !allowedUrls.has(u));
}

/* ---------------- TEXT / POLICY HELPERS ---------------- */

function stripCounterSuffix(s) {
  return String(s || "").replace(/\s*\(Chars:\s*\d+\s*\)\s*$/i, "").trim();
}

function startsWithBrand(title, brand) {
  const t = String(title || "").trim().toLowerCase();
  const b = String(brand || "").trim().toLowerCase();
  if (!b) return true;
  return t.startsWith(b);
}

function includesBrand(s, brand) {
  const t = String(s || "").toLowerCase();
  const b = String(brand || "").toLowerCase();
  if (!b) return false;
  return t.includes(b);
}

function removeBrandFromBackend(backend, brand) {
  let s = String(backend || "");
  const b = String(brand || "").trim();
  if (!b) return collapseSpaces(s);

  const tokens = s.split(/\s+/).filter(Boolean);
  const bLower = b.toLowerCase();
  const filtered = tokens.filter(tok => tok.toLowerCase() !== bLower);
  return collapseSpaces(filtered.join(" "));
}

function containsCyrillic(s) {
  return /[\u0400-\u04FF]/.test(String(s || ""));
}

// Approx emoji detection (covers most emoji blocks)
function containsEmoji(s) {
  const str = String(s || "");
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/u.test(str);
}

function isAllCaps(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  // Consider ALL CAPS if it has letters and no lowercase letters
  const hasLetter = /[A-Za-zÄÖÜß]/.test(t);
  const hasLower = /[a-zäöüß]/.test(t);
  return hasLetter && !hasLower;
}

function maxWordRepetition(title) {
  const t = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return 0;

  const words = t.split(/\s+/).filter(Boolean);
  const counts = new Map();
  for (const w of words) {
    // Ignore 1-char tokens
    if (w.length < 2) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  let max = 0;
  for (const v of counts.values()) max = Math.max(max, v);
  return max;
}

function normalizeOneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function asciiNormalizeBackend(s) {
  let x = String(s || "");
  // Replace German special chars to ASCII equivalents
  x = x
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");

  // Remove any remaining non-ASCII
  x = x.replace(/[^\x00-\x7F]/g, " ");

  // Remove punctuation that violates "space-separated only"
  x = x.replace(/[,\.;:|/\\]+/g, " ");

  return collapseSpaces(x);
}

function hardTrimBackendToBytes(backend, maxBytes) {
  const toks = collapseSpaces(backend).split(" ").filter(Boolean);
  let out = [];
  for (const tok of toks) {
    const candidate = out.length ? out.join(" ") + " " + tok : tok;
    if (byteLen(candidate) <= maxBytes) out.push(tok);
    else break;
  }
  return out.join(" ");
}

function byteLen(s) {
  const enc = new TextEncoder();
  return enc.encode(String(s || "")).length;
}

/* ---------------- WEB SOURCES EXTRACT ---------------- */

function extractWebSources(data) {
  const urls = [];
  const out = data?.output;
  if (!Array.isArray(out)) return urls;

  for (const item of out) {
    if (item?.type === "web_search_call" && item?.action?.sources && Array.isArray(item.action.sources)) {
      for (const src of item.action.sources) {
        const u = src?.url || src?.source_url || "";
        if (u && /^https?:\/\//i.test(u)) urls.push(u);
      }
    }
  }

  // de-dup
  const seen = new Set();
  const dedup = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    dedup.push(u);
  }
  return dedup;
}

/* ---------------- OpenAI call helper ---------------- */

async function callOpenAI(env, instructions, input, { max_output_tokens, temperature, timeoutMs, tools, include, reasoning }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);

  const body = {
    model: env.OPENAI_MODEL || "gpt-5.2",
    instructions,
    input,
    max_output_tokens: max_output_tokens ?? 3200,
    temperature: temperature ?? 0.7,
    text: { format: { type: "text" } },
  };

  if (tools && Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (include && Array.isArray(include) && include.length) {
    body.include = include;
  }
  if (reasoning) {
    body.reasoning = reasoning;
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).finally(() => clearTimeout(timeout));

  const contentType = resp.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await resp.json() : { raw: await resp.text() };

  if (!resp.ok) {
    const msg = data?.error?.message || data?.raw || "OpenAI error";
    throw new Error(msg);
  }
  return data;
}

function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const out = data?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
          else if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
