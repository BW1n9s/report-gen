import { sleep } from './retry.js';

const LOCK_TTL_SEC = 50;
const POLL_MS = 700;
const TIMEOUT_MS = 45000;

export async function withUserQueue(kv, userId, fn) {
  const lockKey = `lock:${userId}`;
  const myToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + TIMEOUT_MS;

  let acquired = false;
  while (Date.now() < deadline) {
    const existing = await kv.get(lockKey);
    if (!existing) {
      await kv.put(lockKey, myToken, { expirationTtl: LOCK_TTL_SEC });
      const confirm = await kv.get(lockKey);
      if (confirm === myToken) { acquired = true; break; }
    }
    await sleep(POLL_MS);
  }

  if (!acquired) {
    console.warn(`[queue] Could not acquire lock for ${userId}, proceeding without it`);
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await kv.get(lockKey);
      if (current === myToken) await kv.delete(lockKey);
    } catch (_) {}
  }
}
