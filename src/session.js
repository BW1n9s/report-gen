// src/session.js
export async function getSession(chatId, env) {
  const raw = await env.REPORT_SESSIONS.get(chatId);
  return raw ? JSON.parse(raw) : null;
}

export async function saveSession(chatId, session, env) {
  await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), { expirationTtl: 86400 });
}

export async function deleteSession(chatId, env) {
  await env.REPORT_SESSIONS.delete(chatId);
}