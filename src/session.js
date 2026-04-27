// Cache API: per-PoP, strongly consistent within the same Cloudflare data center.
// Requests from one user almost always hit the same PoP, so Cache reads are
// immediately consistent after a Cache write — no propagation delay.
// KV is kept as a global backup for cross-PoP edge cases.

const KV_TTL = 86400;

function cacheUrl(chatId) {
  return `https://session-cache.internal/${encodeURIComponent(chatId)}`;
}

async function cacheRead(chatId) {
  const res = await caches.default.match(cacheUrl(chatId));
  if (!res) return undefined; // undefined = cache miss (distinct from null = no session)
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

export async function getSession(chatId, env) {
  if (!chatId) return null;

  // Same-PoP read — instant consistency
  const cached = await cacheRead(chatId);
  if (cached !== undefined) return cached;

  // Cross-PoP fallback to KV
  const raw = await env.REPORT_SESSIONS.get(chatId);
  return raw ? JSON.parse(raw) : null;
}

export async function saveSession(chatId, session, env) {
  if (!chatId) return;
  // Write to both in parallel: Cache (fast, local) and KV (global backup)
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
