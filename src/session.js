const KV_TTL = 86400;

// Cache API is PoP-local — fast when the card click and the message hit the
// same Cloudflare edge node, but useless across PoPs (Feishu may deliver
// different event types from different servers → different PoPs).
// KV is globally eventual: typically propagates in <2s within the same region,
// but can take up to 60s across regions. The retry below covers that gap.

function cacheUrl(chatId) {
  return `https://session-cache.internal/${encodeURIComponent(chatId)}`;
}

async function cacheRead(chatId) {
  const res = await caches.default.match(cacheUrl(chatId));
  if (!res) return undefined; // undefined = miss; null = confirmed no session
  const text = await res.text();
  return text === 'null' ? null : JSON.parse(text);
}

async function cacheWrite(chatId, session) {
  await caches.default.put(
    cacheUrl(chatId),
    new Response(JSON.stringify(session ?? null), {
      headers: { 'Cache-Control': 'max-age=3600' }
    })
  );
}

async function cacheDelete(chatId) {
  await caches.default.delete(cacheUrl(chatId));
}

async function kvRead(chatId, env) {
  const raw = await env.REPORT_SESSIONS.get(chatId);
  return raw ? JSON.parse(raw) : null;
}

export async function getSession(chatId, env) {
  if (!chatId) return null;

  // 1. Same-PoP cache hit → instant, no network
  const cached = await cacheRead(chatId);
  if (cached !== undefined) return cached;

  // 2. First KV attempt
  const first = await kvRead(chatId, env);
  if (first !== null) {
    await cacheWrite(chatId, first); // warm cache for next read
    return first;
  }

  // 3. KV returned null — could be "no session" OR cross-PoP propagation lag.
  //    Poll every 500 ms for up to 2 s. KV typically propagates within this
  //    window for same-region writes. Feishu's 5-second timeout leaves us ~2.5 s
  //    of headroom after accounting for normal processing time (~500 ms).
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 500));
    const retry = await kvRead(chatId, env);
    if (retry !== null) {
      await cacheWrite(chatId, retry);
      return retry;
    }
  }

  return null;
}

export async function saveSession(chatId, session, env) {
  if (!chatId) return;
  await Promise.all([
    cacheWrite(chatId, session),
    env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), { expirationTtl: KV_TTL })
  ]);
}

export async function deleteSession(chatId, env) {
  if (!chatId) return;
  await Promise.all([
    cacheDelete(chatId),
    env.REPORT_SESSIONS.delete(chatId)
  ]);
}
