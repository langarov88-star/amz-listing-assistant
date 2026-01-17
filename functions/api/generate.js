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
  const userPromptRaw = String(body.user_prompt || "").trim();

  const variantsRaw = Number(body.variants || 1);
  const variants = variantsRaw === 3 ? 3 : 1;

  if (!marketplace) return json({ error: "Missing marketplace" }, 400);
  if (!brandName) return json({ error: "Missing brand_name" }, 400);
  if (!userPromptRaw) return json({ error: "Missing user_prompt" }, 400);

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

  // ✅ Булети + описание с твърди изисквания
  const BULLET_COUNT = 7;
  const BULLET_MIN = 220; // chars
  const BULLET_MAX = 240; // chars
  const DESC_MIN = 3000; // chars
  const DESC_MAX = 4000; // chars

  // ✅ NEW: ако user_prompt е URL -> fetch + extract
  let userPrompt = userPromptRaw;
  let scrapedInfo = "";
  if (looksLikeUrl(userPromptRaw)) {
    try {
      const ctx = await fetchProductContext(userPromptRaw, { timeoutMs: 15000 });
      scrapedInfo = buildProductContextText(ctx);
      // вместо да подаваме само линк, подаваме извлечена информация
      userPrompt = scrapedInfo || userPromptRaw;
    } catch (e) {
      // ако scrape падне, продължаваме само с линка
      userPrompt = userPromptRaw;
    }
  }

  const instructions = `You are an Amazon Marketplace Listing Expert.

OUTPUT LANGUAGE: ${outLang}

HARD REQUIREMENTS (must be satisfied):
- Bullet points: EXACTLY ${BULLET_COUNT} bullets.
- Each bullet MUST be ${BULLET_MIN}–${BULLET_MAX} characters (including spaces).
- Each bullet must start with: a SHORT UPPERCASE label + colon, then the text.
  Example format: "✅ HEAT PROTECTION: ..."
- Description: MUST be ${DESC_MIN}–${DESC_MAX} characters total (including spaces).
- Description must be detailed, multi-paragraph, conversion-oriented, readable.
- No medical claims, no guarantees, comply with Amazon policies.

TITLE RULES:
- Title MUST follow this exact structure:
  BRAND PRODUCT_LINE PRODUCT_TYPE VOLUME ml for AREA + MAIN NEED, with ACTIVE_1 & ACTIVE_2, SKIN_TYPE, KEY BENEFIT
- Use the en dash "–" and the separators "+" and "|" and parentheses "()" exactly as shown.
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

User product info:
${userPrompt}

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

    // 3) Repair pass
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

    const parsed = parseAD(output);
    if (!parsed.desc) {
      return json({ output }, 200);
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

/* ---------------- URL SCRAPE / EXTRACT ---------------- */

function looksLikeUrl(s) {
  return /^https?:\/\/\S+$/i.test(String(s || "").trim());
}

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local")) return true;

  // Block plain IPv4 private ranges
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]), b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  // Basic IPv6 localhost
  if (h === "::1") return true;

  return false;
}

async function fetchProductContext(url, { timeoutMs = 15000 } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Unsupported URL protocol");
  if (isPrivateOrLocalHost(u.hostname)) throw new Error("Blocked host");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const resp = await fetch(url, {
    method: "GET",
    signal: controller.signal,
    headers: {
      // леко помага срещу някои блокировки
      "User-Agent": "Mozilla/5.0 (compatible; ListingBot/1.0)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  }).finally(() => clearTimeout(timeout));

  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  const html = await resp.text();

  const pageTitle = extractTagText(html, "title");
  const metaDescription = extractMetaContent(html, "description");
  const h1 = extractFirstH1(html);

  const jsonLdBlocks = extractJsonLdBlocks(html);
  const productLd = findFirstProductJsonLd(jsonLdBlocks);

  // Fallback: cleaned visible text (truncated)
  const cleanedText = cleanHtmlToText(html);

  return {
    source_url: url,
    status: resp.status,
    content_type: contentType,
    page_title: pageTitle,
    meta_description: metaDescription,
    h1,
    product_jsonld: productLd,
    extracted_text: cleanedText,
  };
}

function buildProductContextText(ctx) {
  const lines = [];
  lines.push(`SOURCE URL: ${ctx.source_url}`);
  if (ctx.status) lines.push(`HTTP STATUS: ${ctx.status}`);
  if (ctx.page_title) lines.push(`PAGE TITLE: ${ctx.page_title}`);
  if (ctx.h1) lines.push(`H1: ${ctx.h1}`);
  if (ctx.meta_description) lines.push(`META DESCRIPTION: ${ctx.meta_description}`);

  if (ctx.product_jsonld) {
    const p = ctx.product_jsonld;
    lines.push("");
    lines.push("STRUCTURED PRODUCT DATA (JSON-LD):");
    if (p.name) lines.push(`Name: ${p.name}`);
    if (p.brand) lines.push(`Brand: ${p.brand}`);
    if (p.sku) lines.push(`SKU: ${p.sku}`);
    if (p.gtin) lines.push(`GTIN: ${p.gtin}`);
    if (p.mpn) lines.push(`MPN: ${p.mpn}`);
    if (p.category) lines.push(`Category: ${p.category}`);
    if (p.description) lines.push(`Description: ${p.description}`);
    if (p.price || p.currency) lines.push(`Price: ${p.price || ""} ${p.currency || ""}`.trim());
    if (p.availability) lines.push(`Availability: ${p.availability}`);
    if (p.url) lines.push(`Offer URL: ${p.url}`);
    if (Array.isArray(p.images) && p.images.length) lines.push(`Images: ${p.images.slice(0, 5).join(" | ")}`);
  }

  if (ctx.extracted_text) {
    lines.push("");
    lines.push("EXTRACTED PAGE TEXT (cleaned):");
    lines.push(truncate(ctx.extracted_text, 9000));
  }

  const out = lines.join("\n").trim();
  return truncate(out, 12000);
}

function extractTagText(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(html || "").match(re);
  if (!m) return "";
  return normalizeSpaces(decodeHtmlEntities(stripTags(m[1])));
}

function extractFirstH1(html) {
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
  const m = String(html || "").match(re);
  if (!m) return "";
  return normalizeSpaces(decodeHtmlEntities(stripTags(m[1])));
}

function extractMetaContent(html, name) {
  const s = String(html || "");
  // meta name="description" content="..."
  const re1 = new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]*>`, "i");
  const tag = (s.match(re1) || [])[0] || "";
  if (!tag) return "";
  const m = tag.match(/content=["']([^"']+)["']/i);
  return m ? normalizeSpaces(decodeHtmlEntities(m[1])) : "";
}

function extractJsonLdBlocks(html) {
  const s = String(html || "");
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = String(m[1] || "").trim();
    if (!raw) continue;
    const cleaned = raw.replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    try {
      out.push(JSON.parse(cleaned));
    } catch {
      // Some sites put multiple JSON objects or invalid JSON; ignore silently
    }
  }
  return out;
}

function findFirstProductJsonLd(blocks) {
  const candidates = [];

  for (const b of blocks || []) {
    collectJsonLdNodes(b, candidates);
  }

  // find first Product
  for (const node of candidates) {
    const t = String(node?.["@type"] || "").toLowerCase();
    if (t === "product" || (Array.isArray(node?.["@type"]) && node["@type"].some(x => String(x).toLowerCase() === "product"))) {
      return normalizeProductLd(node);
    }
  }
  return null;
}

function collectJsonLdNodes(node, out) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const x of node) collectJsonLdNodes(x, out);
    return;
  }

  if (typeof node === "object") {
    out.push(node);
    if (node["@graph"]) collectJsonLdNodes(node["@graph"], out);
    // also scan nested objects lightly
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") collectJsonLdNodes(v, out);
    }
  }
}

function normalizeProductLd(p) {
  const brand = p?.brand?.name || p?.brand || "";
  const offers = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const availability = offers?.availability || "";
  const price = offers?.price || offers?.lowPrice || "";
  const currency = offers?.priceCurrency || "";
  const offerUrl = offers?.url || "";

  // common GTIN fields
  const gtin = p?.gtin13 || p?.gtin12 || p?.gtin14 || p?.gtin8 || p?.gtin || "";

  const images = [];
  const img = p?.image;
  if (typeof img === "string") images.push(img);
  else if (Array.isArray(img)) images.push(...img.filter(x => typeof x === "string"));

  return {
    name: normalizeSpaces(decodeHtmlEntities(String(p?.name || ""))),
    description: normalizeSpaces(decodeHtmlEntities(stripTags(String(p?.description || "")))),
    brand: normalizeSpaces(decodeHtmlEntities(String(brand || ""))),
    sku: normalizeSpaces(String(p?.sku || "")),
    mpn: normalizeSpaces(String(p?.mpn || "")),
    gtin: normalizeSpaces(String(gtin || "")),
    category: normalizeSpaces(decodeHtmlEntities(String(p?.category || ""))),
    price: normalizeSpaces(String(price || "")),
    currency: normalizeSpaces(String(currency || "")),
    availability: normalizeSpaces(String(availability || "")),
    url: normalizeSpaces(String(offerUrl || "")),
    images: images.map(x => String(x)).filter(Boolean),
  };
}

function cleanHtmlToText(html) {
  let s = String(html || "");

  // remove scripts/styles/noscript
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // drop svg (often huge)
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  // keep separators
  s = s.replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td|th)>/gi, "\n");

  // strip remaining tags
  s = stripTags(s);

  // decode entities + normalize spaces
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");

  return normalizeSpaces(s).slice(0, 20000);
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(s) {
  let out = String(s || "");

  const map = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#34;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  out = out.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => map[m] || m);
  out = out.replace(/&#(\d+);/g, (_, d) => {
    const code = Number(d);
    if (!Number.isFinite(code)) return _;
    try { return String.fromCharCode(code); } catch { return _; }
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const code = parseInt(h, 16);
    if (!Number.isFinite(code)) return _;
    try { return String.fromCharCode(code); } catch { return _; }
  });

  // handle any remaining common mapped ones
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  return out;
}

function truncate(s, maxLen) {
  const str = String(s || "");
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 20).trimEnd() + "\n...[TRUNCATED]...";
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------- VALIDATION ---------------- */
function validateOutput(text, cfg) {
  const errors = [];

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
  return String(block || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
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
function modelSupportsTemperature(modelId) {
  const m = String(modelId || "").trim().toLowerCase();
  if (m.startsWith("gpt-5")) return false;
  if (/^o\d/.test(m)) return false; // o1, o3, o4, etc.
  return true;
}

async function callOpenAI(env, instructions, input, { max_output_tokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);

  const model = env.OPENAI_MODEL || "gpt-5.2";

  const payload = {
    model,
    instructions,
    input,
    max_output_tokens: max_output_tokens ?? 3200,
    text: { format: { type: "text" } },
  };

  // ✅ FIX: only send temperature if supported by model
  if (modelSupportsTemperature(model) && typeof temperature === "number") {
    payload.temperature = temperature;
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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
