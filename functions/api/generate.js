export async function onRequestPost({ request, env }) {
  if (!env?.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY missing in runtime env" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

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

  const model = env.OPENAI_MODEL || "gpt-5.2-mini"; // по-бързо; override с env ако искаш gpt-5.2

  const baseContext = `Brand name: ${brandName}
Marketplace: ${marketplace}
Output language for client fields: ${outLang}
${usp ? `USPs: ${usp}` : ""}
${brandVoice ? `Brand voice: ${brandVoice}` : ""}

User product info (may include label/INCI):
${userPrompt}`.trim();

  // ---------------- Phase 1: fast web research (short) ----------------
  let phase1 = "";
  try {
    const phase1Instructions = buildPhase1Instructions({ marketplace, outLang });
    const phase1Resp = await callOpenAI(env, {
      model,
      instructions: phase1Instructions,
      input: baseContext,
      max_output_tokens: 1200,
      timeoutMs: 65000,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      reasoning: { effort: "low" },
      verbosity: "low",
    });

    phase1 = extractText(phase1Resp);
    // ако model не е сложил линкове, добавяме от tool sources
    phase1 = ensurePhase1Sources(phase1, extractWebSources(phase1Resp));
  } catch (e) {
    // fallback (без web, без чупене)
    phase1 =
      "ФАЗА 1 · РЕСЪРЧ (резюме)\n" +
      "• Топ ключови думи : (fallback) feuchtigkeit serum creme sensitive haut anti frizz scalp\n" +
      "• Title шаблони (3–5): BRAND – Produkt [VOLUMEN] | Key Ingredient | Nutzen | Differenziator\n" +
      "• Повтарящи ползи (5–7): Feuchtigkeit, geschmeidiges Gefühl, Glanz, beruhigendes Hautgefühl, Schutz vor Austrocknung, einfache Anwendung, angenehme Textur\n" +
      "• Диференциатори (3–5): milde Formel, für Alltag geeignet, schnelle Absorption, ohne klebriges Gefühl, klare Anwendung\n" +
      "• Източници: [https://www.amazon.de/]\n";
  }

  // ---------------- Phase 2: listing (no web_search to avoid timeouts) ----------------
  const phase2Instructions = buildPhase2Instructions({ marketplace, outLang, brandName, cfg: CFG, variants });

  let phase2 = "";
  try {
    const phase2Resp = await callOpenAI(env, {
      model,
      instructions: phase2Instructions,
      input: `${baseContext}\n\nResearch summary (use for keywords/themes):\n${phase1}`,
      max_output_tokens: variants === 3 ? 5200 : 2600,
      timeoutMs: variants === 3 ? 120000 : 95000,
      reasoning: { effort: "low" },
      verbosity: "medium",
    });

    phase2 = extractText(phase2Resp);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while calling OpenAI. Try again." : String(e?.message || e);
    return json({ error: msg }, 500);
  }

  // Build full output
  let output = `${phase1.trim()}\n\n${phase2.trim()}`.trim();

  // Safety: remove any URLs after Phase 2 (only Phase 1 sources line can have URLs)
  output = stripUrlsInPhase2(output);

  // Post-process backend to ASCII + refresh counters
  output = postProcessCountersAndBackend(output, { brandName, cfg: CFG });

  // Validate; if fails -> one repair pass (Phase 2 only)
  const v1 = validatePhase2(output, { brandName, cfg: CFG, variants });
  if (!v1.ok) {
    try {
      const repairInstructions = buildRepairInstructions({ marketplace, outLang, brandName, cfg: CFG, variants });
      const repairResp = await callOpenAI(env, {
        model,
        instructions: repairInstructions,
        input: `${baseContext}

Research summary:
${phase1}

CURRENT OUTPUT (violations):
${v1.errors.join("\n")}

Rewrite ONLY "ФАЗА 2 · ЛИСТИНГ" to satisfy all constraints.`,
        max_output_tokens: variants === 3 ? 5600 : 2800,
        timeoutMs: variants === 3 ? 120000 : 95000,
        reasoning: { effort: "low" },
        verbosity: "medium",
      });

      const repairedPhase2 = extractText(repairResp);
      if (repairedPhase2) {
        output = `${phase1.trim()}\n\n${repairedPhase2.trim()}`.trim();
        output = stripUrlsInPhase2(output);
        output = postProcessCountersAndBackend(output, { brandName, cfg: CFG });
      }
    } catch {
      // return best effort output
    }
  }

  return json({ output }, 200);
}

/* ---------------- PROMPTS (SHORT) ---------------- */

function buildPhase1Instructions({ marketplace, outLang }) {
  return `You are an Amazon EU listing researcher. Use web_search.
Goal: short competitor scan for ${marketplace}.

Output ONLY:
ФАЗА 1 · РЕСЪРЧ (резюме)
• Топ ключови думи : (comma-separated)
• Title шаблони (3–5): (short patterns)
• Повтарящи ползи (5–7): (short phrases)
• Диференциатори (3–5): (short phrases)
• Източници: [URL] [URL] ... (links ONLY here)

Rules:
- Keep it brief (no long paragraphs).
- Sources must be real URLs.
- Do NOT include any URLs outside the Sources line.
- Language of bullets can be Bulgarian; keywords can be ${outLang}.`;
}

function buildPhase2Instructions({ marketplace, outLang, brandName, cfg, variants }) {
  return `You are an Amazon Listing Assistant for EU sellers. Focus on ${marketplace}.
Create copy-ready listing with STRICT limits.

COMPLIANCE:
- No medical/healing claims. No guarantees. No "klinisch bewiesen/dermatologisch getestet" unless provided.
- No competitor brands. No URLs in Phase 2.

LOCALIZATION:
- Client fields in ${outLang}. No Cyrillic in client fields.
- For DE: capitalize nouns; space before units (50 ml).

HARD LIMITS:
- Exactly 2 Titles. Each ${cfg.TITLE_MIN}-${cfg.TITLE_MAX} chars (hard ≤${cfg.TITLE_HARD_MAX}). Must start with "${brandName}". Show "(Chars: X)".
- Exactly ${cfg.BULLET_COUNT} bullets. Each ${cfg.BULLET_MIN}-${cfg.BULLET_MAX} chars. One line each. Format: "• **Label**: text". Label NOT ALL CAPS. No emojis.
- Description length ${cfg.DESC_MIN}-${cfg.DESC_MAX} chars. Multi-paragraph, mobile readable. Show "Product Description (Chars: Z)".
- Backend: ONE line, space-separated, ASCII only (ä->ae ö->oe ü->ue ß->ss), no brand name, ≤${cfg.BACKEND_MAX_BYTES} bytes. Show "(Bytes: Y)".
- Active Ingredients: INCI 1:1 from user label if provided; else "Not provided".

OUTPUT FORMAT EXACTLY:
ФАЗА 2 · ЛИСТИНГ
${variants === 3 ? "VARIANT A\n...\nVARIANT B\n...\nVARIANT C\n..." : ""}

Phase 2 block:
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
<text>
Backend — Generic Keywords (1 ред) (Bytes: Y):
<one line>
Active Ingredients (черта със запетайки):
<INCI or Not provided>
Compliance note (ако е нужно): ...
• Special Features – 1 ред
• Benefits – 3 на брой
• Special Ingredients – търговските наименования
• Material Features – 1 ред
• Material Type Free – 1 ред
• Active Ingredients – търговски наименования
• Recommended Uses For Product – 1 изречение
• Scent – 1 ред
• Safety Warning – 1 ред
• Directions – 1 ред
Attributes (препоръка за попълване):
• Size: ...
• Skin type: ...
• Benefits: ...
• Recommended use: ...
QA & Compliance Check:
• ✅/⚠️ Title length
• ✅/⚠️ Bullets count/length/format
• ✅/⚠️ Description length
• ✅/⚠️ Backend bytes/ASCII/no brand
• ✅/⚠️ No URLs in Phase 2
• ✅/⚠️ No emojis/No Cyrillic in client fields

If info missing: add ONE line at the start of Phase 2: "Assumptions: ...".`;
}

function buildRepairInstructions({ marketplace, outLang, brandName, cfg, variants }) {
  return `You are fixing an Amazon listing. Focus on ${marketplace}.
Rewrite ONLY Phase 2 to satisfy constraints EXACTLY. No extra commentary.

Same constraints:
- Titles: 2, each ${cfg.TITLE_MIN}-${cfg.TITLE_MAX} chars (≤${cfg.TITLE_HARD_MAX}), start with "${brandName}", show (Chars: X)
- Bullets: ${cfg.BULLET_COUNT}, each ${cfg.BULLET_MIN}-${cfg.BULLET_MAX} chars, one line, format "• **Label**: ...", label not ALL CAPS, no emojis
- Description: ${cfg.DESC_MIN}-${cfg.DESC_MAX} chars, show (Chars: Z)
- Backend: one line, ASCII only, ≤${cfg.BACKEND_MAX_BYTES} bytes, no brand, show (Bytes: Y)
- No URLs anywhere in Phase 2
- Client fields in ${outLang}, no Cyrillic

Output:
ФАЗА 2 · ЛИСТИНГ
${variants === 3 ? "VARIANT A / VARIANT B / VARIANT C blocks" : "single block"}
(with the exact block structure).`;
}

/* ---------------- OPENAI CALL (NO temperature) ---------------- */

async function callOpenAI(env, { model, instructions, input, max_output_tokens, timeoutMs, tools, include, reasoning, verbosity }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);

  const body = {
    model,
    instructions,
    input,
    max_output_tokens: max_output_tokens ?? 2000,
    text: { format: { type: "text" }, verbosity: verbosity || "medium" },
  };

  if (reasoning) body.reasoning = reasoning;
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (Array.isArray(include) && include.length) body.include = include;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).finally(() => clearTimeout(timeout));

  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await resp.json() : { raw: await resp.text() };

  if (!resp.ok) {
    const msg = data?.error?.message || data?.raw || "OpenAI error";
    throw new Error(msg);
  }
  return data;
}

function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = data?.output;
  if (!Array.isArray(out)) return "";
  const parts = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
      else if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

/* ---------------- SOURCES (Phase 1) ---------------- */

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
  return [...new Set(urls)].slice(0, 15);
}

function ensurePhase1Sources(phase1Text, urls) {
  let s = String(phase1Text || "").trim();
  if (!s) s = "ФАЗА 1 · РЕСЪРЧ (резюме)\n";

  const has = /•\s*Източници\s*:/i.test(s);
  if (has) return s;

  const list = (urls || []).filter(u => /^https?:\/\//i.test(u)).slice(0, 12);
  const sourcesLine = `• Източници: ${(list.length ? list : ["https://www.amazon.de/"]).map(u => `[${u}]`).join(" ")}`;

  return `${s}\n${sourcesLine}\n`.trim();
}

/* ---------------- PHASE 2 URL STRIP ---------------- */

function stripUrlsInPhase2(full) {
  const s = String(full || "");
  const idx = s.search(/ФАЗА\s*2/i);
  if (idx < 0) return s;

  const before = s.slice(0, idx);
  let after = s.slice(idx);

  // Remove URLs in Phase 2 part only
  after = after.replace(/https?:\/\/\S+/gi, "");
  return (before + after).trim();
}

/* ---------------- POST-PROCESS: backend ASCII + counters ---------------- */

function postProcessCountersAndBackend(full, { brandName, cfg }) {
  let s = String(full || "").trim();
  if (!s) return s;

  // Normalize backend line(s) to ASCII and remove brand
  s = s.replace(/(Backend\s*[—-]\s*Generic\s*Keywords[^\n]*\n)([^\n]+)/gi, (m, h, line) => {
    let clean = asciiNormalizeBackend(line);
    clean = removeBrandToken(clean, brandName);
    clean = hardTrimBackendToBytes(clean, cfg.BACKEND_MAX_BYTES);
    const bytes = byteLen(clean);
    // Ensure header contains (Bytes: Y)
    let header = h.replace(/\(Bytes:\s*\d+\)/i, "").trimEnd();
    if (!/\(Bytes:/i.test(header)) header = header.replace(/:\s*$/,"").trimEnd() + ` (Bytes: ${bytes}):\n`;
    else header = header.replace(/:\s*$/,"").trimEnd() + `:\n`;
    return header + clean;
  });

  // Refresh Title counters
  s = s.replace(/^\s*1\.\s*(.+?)(\s*\(Chars:\s*\d+\s*\))?\s*$/gim, (m, t) => {
    const txt = stripCounterSuffix(String(t || "")).trim();
    return `1. ${txt} (Chars: ${txt.length})`;
  });
  s = s.replace(/^\s*2\.\s*(.+?)(\s*\(Chars:\s*\d+\s*\))?\s*$/gim, (m, t) => {
    const txt = stripCounterSuffix(String(t || "")).trim();
    return `2. ${txt} (Chars: ${txt.length})`;
  });

  // Refresh Description counter
  s = refreshDescriptionCounter(s);

  return s.trim();

  function refreshDescriptionCounter(text) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^Product\s*Description/i.test(lines[i])) {
        // collect until Backend line
        let j = i + 1;
        const descLines = [];
        for (; j < lines.length; j++) {
          if (/^Backend\s*[—-]/i.test(lines[j])) break;
          descLines.push(lines[j]);
        }
        const descText = descLines.join("\n").trim();
        lines[i] = `Product Description (Chars: ${descText.length})`;
      }
    }
    return lines.join("\n");
  }
}

function stripCounterSuffix(s) {
  return String(s || "").replace(/\s*\(Chars:\s*\d+\s*\)\s*$/i, "").trim();
}

function asciiNormalizeBackend(s) {
  let x = String(s || "");
  x = x
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
  x = x.replace(/[^\x00-\x7F]/g, " ");
  x = x.replace(/[,\.;:|/\\]+/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  return x;
}

function removeBrandToken(backend, brand) {
  const b = String(brand || "").trim().toLowerCase();
  if (!b) return backend;
  return backend
    .split(/\s+/)
    .filter(tok => tok.toLowerCase() !== b)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hardTrimBackendToBytes(backend, maxBytes) {
  const toks = String(backend || "").split(/\s+/).filter(Boolean);
  let out = [];
  for (const tok of toks) {
    const cand = out.length ? out.join(" ") + " " + tok : tok;
    if (byteLen(cand) <= maxBytes) out.push(tok);
    else break;
  }
  return out.join(" ");
}

function byteLen(s) {
  return new TextEncoder().encode(String(s || "")).length;
}

/* ---------------- VALIDATION (Phase 2 only, minimal & fast) ---------------- */

function validatePhase2(full, { brandName, cfg, variants }) {
  const errors = [];
  const s = String(full || "");

  const idx = s.search(/ФАЗА\s*2/i);
  if (idx < 0) return { ok: false, errors: ["Missing Phase 2 heading."] };
  const phase2 = s.slice(idx);

  const blocks = splitVariantsPhase2(phase2, variants);
  for (const b of blocks) {
    const label = b.label || "OUTPUT";
    const t = b.text;

    const titles = parseTitles(t);
    if (titles.length !== 2) errors.push(`${label}: titles found ${titles.length}/2`);
    else {
      titles.forEach((title, i) => {
        const len = title.length;
        if (len < cfg.TITLE_MIN || len > cfg.TITLE_MAX || len > cfg.TITLE_HARD_MAX)
          errors.push(`${label}: title ${i + 1} len=${len} (need ${cfg.TITLE_MIN}-${cfg.TITLE_MAX}, hard<=${cfg.TITLE_HARD_MAX})`);
        if (!title.toLowerCase().startsWith(String(brandName).toLowerCase()))
          errors.push(`${label}: title ${i + 1} must start with brand`);
      });
    }

    const bullets = parseBullets(t);
    if (bullets.length !== cfg.BULLET_COUNT) errors.push(`${label}: bullets count ${bullets.length}/${cfg.BULLET_COUNT}`);
    bullets.forEach((bl, i) => {
      const line = bl.replace(/\s+/g, " ").trim();
      const len = line.length;
      if (len < cfg.BULLET_MIN || len > cfg.BULLET_MAX)
        errors.push(`${label}: bullet ${i + 1} len=${len} (need ${cfg.BULLET_MIN}-${cfg.BULLET_MAX})`);
      if (!/^•\s*\*\*.+\*\*:\s+/.test(line))
        errors.push(`${label}: bullet ${i + 1} bad format`);
    });

    const desc = parseDescription(t);
    const dlen = desc.length;
    if (dlen < cfg.DESC_MIN || dlen > cfg.DESC_MAX)
      errors.push(`${label}: description len=${dlen} (need ${cfg.DESC_MIN}-${cfg.DESC_MAX})`);

    const backend = parseBackend(t);
    const bytes = byteLen(asciiNormalizeBackend(backend));
    if (bytes > cfg.BACKEND_MAX_BYTES)
      errors.push(`${label}: backend bytes=${bytes} (need <=${cfg.BACKEND_MAX_BYTES})`);
    if (backend.toLowerCase().includes(String(brandName).toLowerCase()))
      errors.push(`${label}: backend contains brand (not allowed)`);
  }

  return { ok: errors.length === 0, errors };
}

function splitVariantsPhase2(phase2, variantsExpected) {
  const lines = String(phase2 || "").split("\n");
  const header = lines[0] || "";
  const rest = lines.slice(1).join("\n").trim();

  const re = /\bVARIANT\s+[ABC]\b/gi;
  const matches = [];
  let m;
  while ((m = re.exec(rest)) !== null) matches.push({ idx: m.index, label: m[0].toUpperCase() });

  if (!matches.length) return [{ label: "", text: rest || "" }];

  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : rest.length;
    const chunk = rest.slice(start, end).trim();
    const firstLine = chunk.split("\n")[0].trim();
    out.push({ label: firstLine, text: chunk.slice(firstLine.length).trim() });
  }

  return variantsExpected === 1 ? [out[0]] : out;
}

function parseTitles(block) {
  const lines = String(block || "").split("\n").map(l => l.trim());
  const t1 = lines.find(l => /^1\./.test(l));
  const t2 = lines.find(l => /^2\./.test(l));
  const out = [];
  if (t1) out.push(t1.replace(/^1\.\s*/, "").replace(/\(Chars:\s*\d+\)\s*$/i, "").trim());
  if (t2) out.push(t2.replace(/^2\.\s*/, "").replace(/\(Chars:\s*\d+\)\s*$/i, "").trim());
  return out;
}

function parseBullets(block) {
  return String(block || "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("•"));
}

function parseDescription(block) {
  const s = String(block || "");
  const start = s.search(/Product\s*Description/i);
  const end = s.search(/Backend\s*[—-]/i);
  if (start < 0 || end < 0 || end <= start) return "";
  const desc = s.slice(start, end).split("\n").slice(1).join("\n").trim();
  return desc;
}

function parseBackend(block) {
  const s = String(block || "");
  const m = /Backend\s*[—-][^\n]*\n([^\n]+)/i.exec(s);
  return (m && m[1]) ? m[1].trim() : "";
}

/* ---------------- RESPONSE ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
