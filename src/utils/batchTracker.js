const WINDOW_TTL = 6;    // seconds — images arriving within 6s = same batch
const DATA_TTL   = 600;  // seconds — batch data kept 10 minutes

async function safeGet(kv, key) {
  try { return await kv.get(key); } catch (_) { return null; }
}

function jitter(ms) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * ms)));
}

/**
 * Register an incoming image into the current batch window.
 * Returns { isNew, total, statusMsgId }
 */
export async function registerImage(kv, userId, imageKey, messageId) {
  const winKey  = `bwin:${userId}`;
  const dataKey = `bdat:${userId}`;

  const windowExists = await safeGet(kv, winKey);
  // Refresh the sliding window every time an image arrives
  await kv.put(winKey, '1', { expirationTtl: WINDOW_TTL });

  if (!windowExists) {
    // New batch
    const data = {
      images: [{ imageKey, messageId }],
      completed: 0,
      results: [],
      statusMsgId: null,
    };
    await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
    return { isNew: true, total: 1, statusMsgId: null };
  } else {
    // Existing batch — append
    await jitter(150); // reduce concurrent-write conflicts on KV
    const raw = await safeGet(kv, dataKey);
    const data = raw
      ? JSON.parse(raw)
      : { images: [], completed: 0, results: [], statusMsgId: null };
    data.images.push({ imageKey, messageId });
    await kv.put(dataKey, JSON.stringify(data), { expirationTtl: DATA_TTL });
    return { isNew: false, total: data.images.length, statusMsgId: data.statusMsgId };
  }
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
 * Returns { completed, total, allDone, data, statusMsgId }
 */
export async function addResult(kv, userId, result) {
  const dataKey = `bdat:${userId}`;
  await jitter(200); // stagger concurrent writes
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
  try { await kv.delete(`bwin:${userId}`); } catch (_) {}
  try { await kv.delete(`bdat:${userId}`); } catch (_) {}
}
