export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env?.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY missing in runtime env" }, 500);
  }

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
    "amazon.co.uk": "English (UK)"
  };
  const outLang = langMap[marketplace] || "English";

  // ✅ ВАЖНО: добавихме твърдото изискване за 3000–4000 chars
  const instructions = `You are an Amazon Marketplace Listing Expert.

GOAL:
Create HIGH-CONVERTING, Amazon-optimized listings that comply with Amazon policies.

OUTPUT LANGUAGE: ${outLang}

TITLE RULES:
- Start with Brand Name
- Primary keyword immediately after
- 1–2 strongest USPs
- No keyword stuffing
- Aim ~180–200 characters

BULLET RULES:
- 5 bullets
- Short, scannable
- Keyword → micro-benefit
- No fluff

DESCRIPTION RULES:
- Total length must be 3000–4000 characters (including spaces).
- Write a persuasive, detailed description (multiple paragraphs). You may use short subheadings.
- Natural keyword integration (no stuffing).
- No prohibited claims (medical/guarantees). Comply with Amazon policies.

BACKEND SEARCH TERMS:
- ~250 characters
- No duplicates
- No brand name
- No generic words (creme, pflege, produkt)
- Space-separated only

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

User product info:
${userPrompt}

Generate ${variants === 3 ? "THREE distinct variants (A/B/C)" : "ONE version"}.
Each variant must fully include A–D.
If 3 variants, clearly label them exactly as:
VARIANT A
VARIANT B
VARIANT C`;

  try {
    // По-голям token budget (за да има шанс за 3–4k chars)
    const first = await callOpenAI(env, instructions, input, {
      max_output_tokens: variants === 3 ? 6500 : 2600,
      temperature: 0.6,
      timeoutMs: 45000
    });

    let output = extractText(first);
    if (!output) return json({ error: "Empty output from OpenAI", debug: first }, 500);

    // ✅ Валидация + Fix на DESCRIPTION ако е извън 3000–4000 chars
    output = await enforceDescriptionLength(output, env, {
      outLang, marketplace, brandName, usp, brandVoice, userPrompt,
      minChars: 3000,
      maxChars: 4000
    });

    return json({ output }, 200);

  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Timeout while calling OpenAI. Try again."
        : String(e?.message || e || "Server error");
    return json({ error: msg }, 500);
  }
}

/* ---------------- Enforce DESCRIPTION length ---------------- */

async function enforceDescriptionLength(output, env, ctx) {
  const variants = splitVariants(output);

  // Ако няма варианти (single) -> пак ще върне масив с 1 елемент
  const fixed = [];
  for (const v of variants) {
    const parsed = parseAD(v.text);
    if (!parsed?.desc) {
      fixed.push(v.label ? `${v.label}\n${v.text}` : v.text);
      continue;
    }

    const descNorm = normalizeSpaces(parsed.desc);
    const len = descNorm.length;

    if (len >= ctx.minChars && len <= ctx.maxChars) {
      fixed.push(rebuildVariant(v.label, parsed));
      continue;
    }

    // Втори call – връща САМО DESCRIPTION в 3000–4000 chars
    const fixedDesc = await fixDescription(env, {
      outLang: ctx.outLang,
      minChars: ctx.minChars,
      maxChars: ctx.maxChars,
      marketplace: ctx.marketplace,
      brandName: ctx.brandName,
      usp: ctx.usp,
      brandVoice: ctx.brandVoice,
      userPrompt: ctx.userPrompt,
      currentDesc: parsed.desc
    });

    parsed.desc = fixedDesc || parsed.desc;
    fixed.push(rebuildVariant(v.label, parsed));
  }

  return fixed.join("\n\n").trim();
}

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
    const end = (i + 1 < matches.length) ? matches[i + 1].idx : s.length;
    const chunk = s.slice(start, end).trim();
    // label е първия ред
    const firstLine = chunk.split("\n")[0].trim();
    out.push({ label: firstLine, text: chunk.slice(firstLine.length).trim() });
  }
  return out;
}

function parseAD(text) {
  const t = String(text || "");

  const title = extractBetween(t, "A) TITLE:", "B) BULLET POINTS:");
  const bullets = extractBetween(t, "B) BULLET POINTS:", "C) DESCRIPTION:");
  const desc = extractBetween(t, "C) DESCRIPTION:", "D) BACKEND SEARCH TERMS:");
  const backend = extractAfter(t, "D) BACKEND SEARCH TERMS:");

  return { title, bullets, desc, backend };
}

function rebuildVariant(label, p) {
  const parts = [];
  if (label) parts.push(label);

  parts.push("A) TITLE:");
  parts.push((p.title || "").trim());

  parts.push("");
  parts.push("B) BULLET POINTS:");
  parts.push((p.bullets || "").trim());

  parts.push("");
  parts.push("C) DESCRIPTION:");
  parts.push((p.desc || "").trim());

  parts.push("");
  parts.push("D) BACKEND SEARCH TERMS:");
  parts.push((p.backend || "").trim());

  return parts.join("\n").trim();
}

function extractBetween(text, start, end) {
  const s = text.indexOf(start);
  if (s === -1) return "";
  const from = s + start.length;
  const e = text.indexOf(end, from);
  if (e === -1) return text.slice(from).trim();
  return text.slice(from, e).trim();
}

function extractAfter(text, start) {
  const s = text.indexOf(start);
  if (s === -1) return "";
  return text.slice(s + start.length).trim();
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/* ---------------- Fix DESCRIPTION only ---------------- */

async function fixDescription(env, ctx) {
  const instr = `You are an Amazon listing copywriter.
Task: Rewrite ONLY the DESCRIPTION section.

HARD REQUIREMENTS:
- Language: ${ctx.outLang}
- LENGTH: ${ctx.minChars}–${ctx.maxChars} characters total (including spaces). Count characters and stay within range.
- Keep it conversion-oriented, detailed, and readable (multiple paragraphs).
- No medical claims, no guarantees, comply with Amazon policies.
- Do NOT output Title, Bullets, Backend terms.
- Output ONLY the description text (plain text).`;

  const uspLine = ctx.usp ? `USPs: ${ctx.usp}\n` : "";
  const bvLine = ctx.brandVoice ? `Brand voice: ${ctx.brandVoice}\n` : "";

  const inp = `Marketplace: ${ctx.marketplace}
Brand name: ${ctx.brandName}
${uspLine}${bvLine}

Product info:
${ctx.userPrompt}

Current (too short/too long) description:
${ctx.currentDesc}

Rewrite the description to meet the length requirement.`;

  const data = await callOpenAI(env, instr, inp, {
    max_output_tokens: 2200,
    temperature: 0.5,
    timeoutMs: 45000
  });

  const out = extractText(data);
  const clean = String(out || "").trim();

  // Ако моделът пак не спази – връщаме каквото има, а enforce ще остави старото
  const len = normalizeSpaces(clean).length;
  if (len < ctx.minChars || len > ctx.maxChars) return "";
  return clean;
}

/* ---------------- OpenAI call helper ---------------- */

async function callOpenAI(env, instructions, input, { max_output_tokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 45000);

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.2",
      instructions,
      input,
      max_output_tokens: max_output_tokens ?? 2600,
      temperature: temperature ?? 0.6,
      text: { format: { type: "text" } }
    })
  }).finally(() => clearTimeout(timeout));

  const contentType = resp.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await resp.json()
    : { raw: await resp.text() };

  if (!resp.ok) {
    const msg = data?.error?.message || data?.raw || "OpenAI error";
    throw new Error(msg);
  }
  return data;
}

/* ---------------- Responses API text extractor ---------------- */

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
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
