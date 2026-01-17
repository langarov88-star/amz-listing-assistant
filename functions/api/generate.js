export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- Env check ----
  if (!env?.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY missing in runtime env" }, 500);
  }

  // ---- Auth check (token signed with ACCESS_TOKEN_SECRET) ----
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;

  // ---- Read body safely ----
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // ---- Inputs from client ----
  const marketplace = String(body.marketplace || "").trim();
  const brandVoice = String(body.brand_voice || "").trim();
  const brandName = String(body.brand_name || "").trim();
  const usp = String(body.usp || "").trim();
  const userPrompt = String(body.user_prompt || "").trim();

  const variantsRaw = Number(body.variants || 1);
  const variants = variantsRaw === 3 ? 3 : 1;

  // ---- Validation ----
  if (!marketplace) return json({ error: "Missing marketplace" }, 400);
  if (!brandName) return json({ error: "Missing brand_name" }, 400);
  if (!userPrompt) return json({ error: "Missing user_prompt" }, 400);

  // ---- Output language ----
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

  // ---- System instructions ----
  const instructions = `You are an Amazon Marketplace Listing Expert.

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
- Total length must be 3000–4000 characters (including spaces)
- Use structured subheadings where helpful
- Natural keyword integration (no stuffing)
- No prohibited claims (medical/guarantees), comply with Amazon policies
- Must be coherent, conversion-oriented, and readable

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

  // ---- User input (prompt to the model) ----
  const uspLine = usp ? `USPs: ${usp}\n` : "";
  const brandVoiceLine = brandVoice ? `Brand voice: ${brandVoice}\n` : "";

  const input = `Brand name: ${brandName}
${uspLine}Marketplace: ${marketplace}
${brandVoiceLine}
User product info:
${userPrompt}

Generate ${variants === 3 ? "THREE distinct variants (A/B/C)" : "ONE version"}.
Each variant must fully include A–D.
If 3 variants, clearly label them exactly as:
VARIANT A
VARIANT B
VARIANT C`;

  // ---- OpenAI call (Responses API) ----
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // NOTE: махам "Thinking" от default-а, за да няма невалидно име на модел
        model: env.OPENAI_MODEL || "gpt-5.2",
        instructions,
        input,
        max_output_tokens: variants === 3 ? 3200 : 1600,
        temperature: 0.7,
        text: { format: { type: "text" } }
      })
    }).finally(() => clearTimeout(timeout));

    const contentType = resp.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await resp.json()
      : { raw: await resp.text() };

    if (!resp.ok) {
      return json(
        { error: data?.error?.message || data?.raw || "OpenAI error" },
        resp.status
      );
    }

    const output = extractText(data);
    if (!output) {
      return json(
        {
          error: "OpenAI returned an empty output. Check model availability and response format.",
          debug: data
        },
        500
      );
    }

    return json({ output }, 200);

  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Timeout while calling OpenAI (40s). Try again or reduce prompt."
        : (e?.message || "Server error");
    return json({ error: msg }, 500);
  }
}

/* -------------------- AUTH HELPERS -------------------- */

async function requireAuth(request, env) {
  if (!env?.ACCESS_TOKEN_SECRET) {
    return json({ error: "ACCESS_TOKEN_SECRET missing in env" }, 500);
  }

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!token || !token.includes(".")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) {
    return json({ error: "Unauthorized" }, 401);
  }

  const expectedSig = await hmacSha256Base64Url(env.ACCESS_TOKEN_SECRET, payloadB64);
  if (!timingSafeEqual(sigB64, expectedSig)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload?.exp || now >= payload.exp) {
    return json({ error: "Session expired" }, 401);
  }

  return null;
}

async function hmacSha256Base64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* -------------------- OUTPUT HELPERS -------------------- */

// Extract text from Responses API output items
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
