export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env?.OPENAI_API_KEY) {
  return json({ error: "OPENAI_API_KEY is missing in runtime env (Production)" }, 500);
}


  try {
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

    const system = `You are an Amazon Listing AI Specialist for EU marketplaces.
You create high-converting, Amazon-SEO-optimized product listings.

RULES:
- Output language MUST be ${outLang}.
- Follow Amazon best practices (no keyword stuffing, focus on benefits + clarity).
- Do not include forbidden claims (medical, misleading guarantees, #1/best unless provable).
- If info is missing: make conservative, realistic assumptions; do NOT invent certifications/awards.

OUTPUT ONLY in this exact structure:
A) TITLE:
B) BULLET POINTS: (5)
C) DESCRIPTION:
D) BACKEND SEARCH TERMS: (250–500 chars, space-separated, no repeats)`;

    const brandLine = brandVoice ? `\nBrand voice: ${brandVoice}` : "";
    const input = `${system}\n\n---\nMarketplace: ${marketplace}${brandLine}\n\nUser prompt:\n${userPrompt}\n---\nReturn ONLY A–D.`;

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.2",
        input
      })
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: data?.error?.message || "OpenAI error" }, resp.status);

    return json({ output: data.output_text || "" }, 200);

  } catch (e) {
    return json({ error: e?.message || "Server error" }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
