// NOTE: withUserQueue is used only for report generation (END command),
// NOT for image processing. Images are processed concurrently and deduplicated
// via ImageDedupDO instead.
import { sleep } from './retry.js';

const LOCK_TTL_SEC = 60;
const POLL_MS = 800;
const TIMEOUT_MS = 25000;  // 降至 25s，低于 Cloudflare Worker 30s 上限

export async function withUserQueue(kv, userId, fn) {
  const lockKey = `lock:${userId}`;
  const myToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + TIMEOUT_MS;

  let acquired = false;
  while (Date.now() < deadline) {
    let existing = null;
    try { existing = await kv.get(lockKey); } catch (_) {}

    if (!existing) {
      try {
        await kv.put(lockKey, myToken, { expirationTtl: LOCK_TTL_SEC });
        const confirm = await kv.get(lockKey);
        if (confirm === myToken) { acquired = true; break; }
      } catch (_) {}
    }
    await sleep(POLL_MS);
  }

  if (!acquired) {
    console.warn(`[queue] Lock timeout for ${userId} — proceeding anyway`);
  }

  try {
    return await fn();
  } catch (err) {
    throw err;  // re-throw so router's catch block can reply to user
  } finally {
    // Always attempt cleanup, even if fn() threw
    try {
      const current = await kv.get(lockKey);
      if (current === myToken) await kv.delete(lockKey);
    } catch (_) {}
  }
}
