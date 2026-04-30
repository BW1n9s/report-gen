const BATCH_WINDOW_MS = 8000;  // images arriving within 8s = same batch
const DATA_TTL = 600;          // KV TTL in seconds (must be >= 60)

async function safeGet(kv, key) {
  try { return await kv.get(key); } catch (_) { return null; }
}

function jitter(ms) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * ms)));
}

/**
 * Register an incoming image into the current batch window.
 * Window detection uses a timestamp stored inside the KV value (no sub-60s TTL).
 * Returns { isNew, total, statusMsgId }
 */
export async function registerImage(kv, userId, imageKey, messageId) {
  const dataKey = `bdat:${userId}`;

  await jitter(100 + Math.random() * 150); // stagger concurrent writes

  const raw = await safeGet(kv, dataKey);

  if (!raw) {
    // Brand new batch
    const data = {
      windowStart: Date.now(),
      images: [{ imageKey, messageId }],
      completed: 0,
      results: [],
      statusMsgId: null,
    };
    await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
    return { isNew: true, total: 1, statusMsgId: null };
  }

  const data = JSON.parse(raw);
  const age = Date.now() - (data.windowStart || 0);

  if (age > BATCH_WINDOW_MS) {
    // Window expired — start a new batch, overwrite old data
    const fresh = {
      windowStart: Date.now(),
      images: [{ imageKey, messageId }],
      completed: 0,
      results: [],
      statusMsgId: null,
    };
    await kv.put(dataKey, JSON.stringify(fresh), { expirationTtl: DATA_TTL });
    return { isNew: true, total: 1, statusMsgId: null };
  }

  // Within window — append to existing batch
  data.images.push({ imageKey, messageId });
  await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
  return { isNew: false, total: data.images.length, statusMsgId: data.statusMsgId };
}

/**
 * Store the status message ID so all workers can update it.
 */
export async function setStatusMsgId(kv, userId, statusMsgId) {
  const dataKey = `bdat:${userId}`;
  const raw = await safeGet(kv, dataKey);
  if (!raw) return;
  const data = JSON.parse(raw);
  data.statusMsgId = statusMsgId;
  await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
}

/**
 * Record a completed analysis result.
 * Returns { completed, total, allDone, statusMsgId, data } or null.
 */
export async function addResult(kv, userId, result) {
  const dataKey = `bdat:${userId}`;
  await jitter(100 + Math.random() * 200);
  const raw = await safeGet(kv, dataKey);
  if (!raw) return null;
  const data = JSON.parse(raw);
  data.completed = (data.completed || 0) + 1;
  data.results = data.results || [];
  data.results.push(result);
  await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
  return {
    completed: data.completed,
    total: data.images.length,
    allDone: data.completed >= data.images.length,
    statusMsgId: data.statusMsgId,
    data,
  };
}

export async function getBatchData(kv, userId) {
  const raw = await safeGet(kv, `bdat:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function clearBatch(kv, userId) {
  try { await kv.delete(`bdat:${userId}`); } catch (_) {}
}
