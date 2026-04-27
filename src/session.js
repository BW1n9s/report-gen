// Session storage backed by Durable Objects for strong consistency.
// All reads/writes for the same chatId go to the same DO instance —
// no eventual-consistency lag across Cloudflare edge nodes.

function stub(chatId, env) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(chatId));
}

export async function getSession(chatId, env) {
  if (!chatId) return null;
  try {
    const res = await stub(chatId, env).fetch('https://session-do/get');
    return await res.json();
  } catch {
    return null;
  }
}

export async function saveSession(chatId, session, env) {
  if (!chatId) return;
  await stub(chatId, env).fetch('https://session-do/put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session)
  });
}

export async function deleteSession(chatId, env) {
  if (!chatId) return;
  await stub(chatId, env).fetch('https://session-do/delete', { method: 'POST' });
}
