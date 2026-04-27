/**
 * 获取 Session
 */
export async function getSession(chatId, env) {
  if (!chatId) return null;
  const raw = await env.REPORT_SESSIONS.get(chatId);
  return raw ? JSON.parse(raw) : null;
}

/**
 * 保存 Session
 */
export async function saveSession(chatId, session, env, expirationTtl = 86400) {
  if (!chatId) return;
  await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), {
    expirationTtl
  });
}

/**
 * 删除 Session
 */
export async function deleteSession(chatId, env) {
  if (!chatId) return;
  await env.REPORT_SESSIONS.delete(chatId);
}
