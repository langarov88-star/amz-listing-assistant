export async function onRequestPost(context) {
  const brandName = String(body.brand_name || "").trim();
const uspLine = usp ? `USPs: ${usp}` : "";

const input = `
Brand name: ${brandName}
${uspLine}
Marketplace: ${marketplace}

User product info:
${userPrompt}

Generate ${variants === 3 ? "THREE distinct variants (A/B/C)" : "ONE version"}.
Each variant must fully include A–D.
If 3 variants, clearly label them as:
VARIANT A
VARIANT B
VARIANT C
`;


  const { request, env } = context;

  try {
    if (!env?.OPENAI_API_KEY) {
      return json({ error: "OPENAI_API_KEY is missing in Pages environment (Production)." }, 500);
    }

    const body = await request.json();
    const marketplace = String(body.marketplace || "").trim();
    const brandVoice = String(body.brand_voice || "").trim();
    const userPrompt = String(body.user_prompt || "").trim();

    if (!marketplace) return json({ error: "Missing marketplace" }, 400);
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

    const system = `You are an Amazon DE Listing Expert.

GOAL:
Create HIGH-CONVERTING, Amazon -optimized listings.

TITLE RULES :
- Start with Brand Name
- Primary keyword immediately after
- 1–2 strongest USPs
- No keyword stuffing
- Max ~180–200 characters

BULLET RULES:
- 5 bullets
- Short, scannable
- Keyword → micro-benefit
- No fluff

BACKEND SEARCH TERMS:
- ~250 characters
- No duplicates
- No brand name
- No generic words (creme, pflege, produkt)
- Space-separated only

OUTPUT LANGUAGE: ${outLang}

OUTPUT STRUCTURE:
A) TITLE:
B) BULLET POINTS:
C) DESCRIPTION:
D) BACKEND SEARCH TERMS:`;


    const brandLine = brandVoice ? `\nBrand voice: ${brandVoice}` : "";
    const input = `${system}\n\n---\nMarketplace: ${marketplace}${brandLine}\n\nUser prompt:\n${userPrompt}\n---\nReturn ONLY A–D.`;

    // Timeout защита
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
        model: env.OPENAI_MODEL || "gpt-5.2",
        input
      })
    }).finally(() => clearTimeout(timeout));

    const contentType = resp.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await resp.json()
      : { raw: await resp.text() };

    if (!resp.ok) {
      return json({ error: data?.error?.message || data?.raw || "OpenAI error" }, resp.status);
    }

    const output = extractText(data);
    if (!output) {
      return json({ error: "OpenAI returned an empty output. Check model availability and response format.", debug: data }, 500);
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

// Вади текст и от output_text, и от output[].content[].text
function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  // Responses API често има output масив
  const out = data?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") parts.push(c.text);
          if (typeof c?.content === "string") parts.push(c.content);
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
