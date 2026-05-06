const PREFIX = 'session:';
const TTL = 24 * 60 * 60;

export async function getSession(userId, env) {
  const raw = await env.REPORT_SESSIONS.get(PREFIX + userId);
  if (raw) return JSON.parse(raw);
  return {
    user_id: userId,
    report_type: null,       // 'PD' | 'SERVICE'
    status: 'collecting',
    // 车辆信息（从铭牌图片提取）
    vehicle: {
      type: null,            // 'FORKLIFT_ICE' | 'FORKLIFT_ELECTRIC' | 'FORKLIFT_WALKIE' | 'WHEEL_LOADER' | 'SKID_STEER' | 'UNKNOWN'
      model: null,
      serial: null,
      capacity: null,
      year: null,
      hours: null,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    items: [],
    // 记录哪些检查项已有图片证据
    covered_checks: [],      // e.g. ['engine_oil', 'hydraulic_oil', 'battery']
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
  // DO 状态一并清空
  try {
    const id   = env.IMAGE_DEDUP.idFromName(userId);
    const stub = env.IMAGE_DEDUP.get(id);
    await stub.fetch('http://do/reset', { method: 'DELETE' });
  } catch (_) {}
}
