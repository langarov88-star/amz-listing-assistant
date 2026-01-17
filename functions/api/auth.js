export async function onRequestPost({ request, env }) {
  if (!env?.ACCESS_PASSWORD) {
    return json({ error: "ACCESS_PASSWORD missing in env" }, 500);
  }
  if (!env?.ACCESS_TOKEN_SECRET) {
    return json({ error: "ACCESS_TOKEN_SECRET missing in env" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const password = String(body.password || "");
  if (!timingSafeEqual(password, String(env.ACCESS_PASSWORD))) {
    return json({ error: "Invalid password" }, 401);
  }

  // Token TTL (пример: 7 дни)
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 7 * 24 * 60 * 60;

  const payloadObj = { v: 1, iat: now, exp };
  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));

  const sigB64 = await hmacSha256Base64Url(env.ACCESS_TOKEN_SECRET, payloadB64);
  const token = `${payloadB64}.${sigB64}`;

  return json({ token, exp }, 200);
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

// Constant-time-ish compare (за да няма лесен timing leak)
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
