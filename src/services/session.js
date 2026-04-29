const PREFIX = 'session:';
const TTL = 24 * 60 * 60;

export async function getSession(userId, env) {
  const raw = await env.REPORT_SESSIONS.get(PREFIX + userId);
  if (raw) return JSON.parse(raw);
  return {
    user_id: userId,
    report_type: null,   // 'PD' | 'SERVICE' | null
    status: 'collecting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    items: [],
  };
}

export async function updateSession(userId, session, env) {
  session.updated_at = new Date().toISOString();
  await env.REPORT_SESSIONS.put(PREFIX + userId, JSON.stringify(session), {
    expirationTtl: TTL,
  });
}

export async function clearSession(userId, env) {
  await env.REPORT_SESSIONS.delete(PREFIX + userId);
}
