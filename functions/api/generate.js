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

  // ✅ ТУК: булети + описание с твърди изисквания
  const BULLET_COUNT = 7;
  const BULLET_MIN = 220; // chars
  const BULLET_MAX = 240; // chars
  const DESC_MIN = 3000; // chars
  const DESC_MAX = 4000; // chars

  const instructions = `You are an Amazon Marketplace Listing Expert.

OUTPUT LANGUAGE: ${outLang}

HARD REQUIREMENTS (must be satisfied):
- Bullet points: EXACTLY ${BULLET_COUNT} bullets.
- Each bullet MUST be ${BULLET_MIN}–${BULLET_MAX} characters (including spaces).
- Each bullet must start with: an emoji + a SHORT UPPERCASE label + colon, then the text.
  Example format: "✅ HEAT PROTECTION: ..."
- Description: MUST be ${DESC_MIN}–${DESC_MAX} characters total (including spaces).
- Description must be detailed, multi-paragraph, conversion-oriented, readable.
- No medical claims, no guarantees, comply with Amazon policies.

TITLE RULES:
- Title MUST follow this exact structure:
  BRAND – Haupt-Keyword + Produkttyp [VOLUMEN ml] – Relevante Terme | Hauttyp/Ziel | Einzigartiger Vorteil
- Use the en dash "–" and the separators "+" "[" "]" and "|" exactly as shown.
- Keep it clear and readable (no keyword stuffing).
- Aim ~185–200 characters total.

BACKEND SEARCH TERMS:
- ~250 characters
- No duplicates
- No brand name
- Space-separated only (no commas)

OUTPUT STRUCTURE (for each variant):
A) TITLE:
B) BULLET POINTS:
C) DESCRIPTION:
D) BACKEND SEARCH TERMS:

Return ONLY these sections (A–D), plain text.`;

  const uspLine = usp ? `USPs: ${usp}` : "";
  const brandVoiceLine = brandVoice ? `Brand voice: ${brandVoice}` : "";

  const input = `Brand name: ${brandName}
${uspLine}
Marketplace: ${marketplace}
${brandVoiceLine}
User product info: ${userPrompt}

Generate ${variants === 3 ? "THREE distinct variants (A/B/C)" : "ONE version"}.
Each variant must fully include A–D.
If 3 variants, clearly label them exactly as:
VARIANT A
VARIANT B
VARIANT C`;

  try {
    // 1) First pass
    const first = await callOpenAI(env, instructions, input, {
      max_output_tokens: variants === 3 ? 7500 : 3200,
      temperature: 0.7,
      timeoutMs: 60000,
    });

    let output = extractText(first);
    if (!output) return json({ error: "Empty output from OpenAI", debug: first }, 500);

    // 2) Validate
    const v1 = validateOutput(output, { BULLET_COUNT, BULLET_MIN, BULLET_MAX, DESC_MIN, DESC_MAX });
    if (v1.ok) return json({ output }, 200);

    // 3) Repair pass (rewrite A–D to satisfy HARD requirements)
    const repairInstructions = `${instructions}
You MUST fix the output to satisfy the HARD REQUIREMENTS.
Return again ONLY A–D.
Do not add extra commentary.`;

    const repairInput = `${input}

CURRENT OUTPUT (violations found):
${v1.errors.join("\n")}

Rewrite the output to satisfy the constraints.`;

    const repaired = await callOpenAI(env, repairInstructions, repairInput, {
      max_output_tokens: variants === 3 ? 8500 : 3600,
      temperature: 0.65,
      timeoutMs: 60000,
    });

    output = extractText(repaired) || output;

    // 4) Validate again; if still not ok → try targeted description fix once
    const v2 = validateOutput(output, { BULLET_COUNT, BULLET_MIN, BULLET_MAX, DESC_MIN, DESC_MAX });
    if (v2.ok) return json({ output }, 200);

    // Targeted description fix (only if description is the remaining issue)
    const parsed = parseAD(output);
    if (!parsed.desc) {
      return json({ output }, 200); // cannot parse; return best effort
    }

    const descLen = normalizeSpaces(parsed.desc).length;
    const descBad = descLen < DESC_MIN || descLen > DESC_MAX;

    if (descBad) {
      const fixedDesc = await fixDescriptionOnly(env, {
        outLang,
        marketplace,
        brandName,
        usp,
        brandVoice,
        userPrompt,
        DESC_MIN,
        DESC_MAX,
        currentDesc: parsed.desc,
      });
      if (fixedDesc) {
        parsed.desc = fixedDesc;
        output = rebuildAD(parsed);
      }
    }

    return json({ output }, 200);
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Timeout while calling OpenAI. Try again."
        : String(e?.message || e || "Server error");
    return json({ error: msg }, 500);
  }
}

/* ---------------- VALIDATION ---------------- */
function validateOutput(text, cfg) {
  const errors = [];

  // if variants exist, validate each variant block
  const variants = splitVariants(text);

  for (const v of variants) {
    const block = v.text || "";
    const p = parseAD(block);
    const bullets = splitBullets(p.bullets);

    if (bullets.length !== cfg.BULLET_COUNT) {
      errors.push(`${v.label || "OUTPUT"}: bullets count = ${bullets.length}, expected ${cfg.BULLET_COUNT}`);
    } else {
      bullets.forEach((b, i) => {
        const len = normalizeSpaces(b).length;
        if (len < cfg.BULLET_MIN || len > cfg.BULLET_MAX) {
          errors.push(
            `${v.label || "OUTPUT"}: bullet ${i + 1} length = ${len}, expected ${cfg.BULLET_MIN}-${cfg.BULLET_MAX}`
          );
        }
      });
    }

    const descLen = normalizeSpaces(p.desc).length;
    if (descLen < cfg.DESC_MIN || descLen > cfg.DESC_MAX) {
      errors.push(`${v.label || "OUTPUT"}: description length = ${descLen}, expected ${cfg.DESC_MIN}-${cfg.DESC_MAX}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ---------------- PARSING / REBUILD ---------------- */
function splitVariants(text) {
  const s = String(text || "").trim();
  const re = /\bVARIANT\s+[ABC]\b/gi;

  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) matches.push({ idx: m.index, label: m[0].toUpperCase() });

  if (!matches.length) return [{ label: "", text: s }];

  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : s.length;
    const chunk = s.slice(start, end).trim();
    const firstLine = chunk.split("\n")[0].trim();
    out.push({ label: firstLine, text: chunk.slice(firstLine.length).trim() });
  }
  return out;
}

function parseAD(text) {
  const t = String(text || "");

  // tolerant markers (allow missing colon, different spacing)
  const title = extractBetweenAny(t, [/A\)\s*TITLE\s*:/i, /A\)\s*TITLE\s*/i], [/B\)\s*BULLET/i]);
  const bullets = extractBetweenAny(
    t,
    [/B\)\s*BULLET[\s-]*POINTS\s*:/i, /B\)\s*BULLET[\s-]*POINTS/i],
    [/C\)\s*DESCRIPTION/i]
  );
  const desc = extractBetweenAny(t, [/C\)\s*DESCRIPTION\s*:/i, /C\)\s*DESCRIPTION/i], [/D\)\s*BACKEND/i]);
  const backend = extractAfterAny(
    t,
    [/D\)\s*BACKEND[\s-]*SEARCH\s*TERMS\s*:/i, /D\)\s*BACKEND[\s-]*SEARCH\s*TERMS/i]
  );

  return {
    title: title.trim(),
    bullets: bullets.trim(),
    desc: desc.trim(),
    backend: backend.trim(),
  };
}

function rebuildAD(p) {
  return [
    "A) TITLE:",
    (p.title || "").trim(),
    "",
    "B) BULLET POINTS:",
    (p.bullets || "").trim(),
    "",
    "C) DESCRIPTION:",
    (p.desc || "").trim(),
    "",
    "D) BACKEND SEARCH TERMS:",
    (p.backend || "").trim(),
  ]
    .join("\n")
    .trim();
}

function extractBetweenAny(text, startPatterns, endPatterns) {
  let startIdx = -1;
  let startLen = 0;

  for (const sp of startPatterns) {
    const m = text.match(sp);
    if (m && m.index != null) {
      startIdx = m.index;
      startLen = m[0].length;
      break;
    }
  }
  if (startIdx === -1) return "";

  const from = startIdx + startLen;
  let endIdx = -1;

  for (const ep of endPatterns) {
    const re = new RegExp(ep.source, ep.flags);
    re.lastIndex = from;
    const m2 = re.exec(text.slice(from));
    if (m2 && m2.index != null) {
      endIdx = from + m2.index;
      break;
    }
  }

  if (endIdx === -1) return text.slice(from);
  return text.slice(from, endIdx);
}

function extractAfterAny(text, startPatterns) {
  for (const sp of startPatterns) {
    const m = text.match(sp);
    if (m && m.index != null) {
      return text.slice(m.index + m[0].length);
    }
  }
  return "";
}

function splitBullets(block) {
  const lines = String(block || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // allow bullets separated by newline only
  return lines;
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/* ---------------- DESCRIPTION FIX (targeted) ---------------- */
async function fixDescriptionOnly(env, ctx) {
  const instr = `You are an Amazon listing copywriter.

HARD REQUIREMENTS:
- Language: ${ctx.outLang}
- DESCRIPTION length MUST be ${ctx.DESC_MIN}–${ctx.DESC_MAX} characters (including spaces).
- Detailed, multi-paragraph, conversion-oriented, readable.
- No medical claims, no guarantees.
- Output ONLY the description text (plain text).`;

  const uspLine = ctx.usp ? `USPs: ${ctx.usp}\n` : "";
  const bvLine = ctx.brandVoice ? `Brand voice: ${ctx.brandVoice}\n` : "";

  const inp = `Marketplace: ${ctx.marketplace}
Brand name: ${ctx.brandName}
${uspLine}${bvLine}
Product info: ${ctx.userPrompt}

Current description:
${ctx.currentDesc}

Rewrite the description to meet the length requirement exactly within range.`;

  const data = await callOpenAI(env, instr, inp, {
    max_output_tokens: 2600,
    temperature: 0.55,
    timeoutMs: 60000,
  });

  const out = extractText(data);
  const clean = String(out || "").trim();
  const len = normalizeSpaces(clean).length;

  if (len < ctx.DESC_MIN || len > ctx.DESC_MAX) return "";
  return clean;
}

/* ---------------- OpenAI call helper ---------------- */
async function callOpenAI(env, instructions, input, { max_output_tokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.2",
      instructions,
      input,
      max_output_tokens: max_output_tokens ?? 3200,
      temperature: temperature ?? 0.7,
      text: { format: { type: "text" } },
    }),
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
