const KV_TTL = 86400;

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
  if (!raw) return null;
  const session = JSON.parse(raw);
  await cacheWrite(chatId, session); // warm local cache on KV hit
  return session;
}

// Fast path — no retry. Use for card action events (Feishu 3s timeout).
export async function getSession(chatId, env) {
  if (!chatId) return null;
  const cached = await cacheRead(chatId);
  if (cached !== undefined) return cached;
  return kvRead(chatId, env);
}

// Retrying path — use for text/image message events (Feishu 5s timeout).
// Polls KV every 500ms for up to 2s to handle cross-PoP propagation lag.
// Total time including processing stays well within the 5s limit.
export async function getSessionWithRetry(chatId, env) {
  if (!chatId) return null;

  const cached = await cacheRead(chatId);
  if (cached !== undefined) return cached;

  // First KV attempt
  const first = await kvRead(chatId, env);
  if (first !== null) return first;

  // Retry loop: 4 × 500ms = 2s max wait
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 500));
    const retry = await kvRead(chatId, env);
    if (retry !== null) return retry;
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
