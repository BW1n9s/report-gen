// src/session.js
export const SESSION_TTL = 86400;

export async function getSession(chatId, env) {
  const raw = await env.REPORT_SESSIONS.get(chatId);
  return raw ? JSON.parse(raw) : null;
}

export async function saveSession(chatId, session, env) {
  await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

export async function initSession(chatId, type, env) {
  const session = {
    report_type: type, // "PD" | "Service"
    status: "collecting",
    extracted: { model: "", vin: "", serial_no: "", hours: "", date: new Date().toISOString() },
    images: [],
    notes: []
  };
  await saveSession(chatId, session, env);
  return session;
}