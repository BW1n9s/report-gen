// Batch window: images arriving within WINDOW_MS of each other = same batch.
// We avoid sub-60s KV TTLs by storing timestamps inside the value.
const BATCH_WINDOW_MS = 8000;
const DATA_TTL = 600; // seconds, must be >= 60

async function safeGet(kv, key) {
  try { return await kv.get(key); } catch (_) { return null; }
}

async function safePut(kv, key, value) {
  try { await kv.put(key, JSON.stringify(value), { expirationTtl: DATA_TTL }); return true; }
  catch (_) { return false; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Register an incoming image. Uses a CAS-style read-modify-write with jitter.
 * Returns { isNew, total, statusMsgId }
 */
export async function registerImage(kv, userId, imageKey, messageId) {
  const key = `bdat:${userId}`;

  // Stagger concurrent writes from multiple Worker instances
  await sleep(80 + Math.random() * 120);

  const raw = await safeGet(kv, key);

  if (!raw) {
    const data = {
      windowStart: Date.now(),
      lastArrival: Date.now(),
      images: [{ imageKey, messageId }],
      completed: 0,
      results: [],
      statusMsgId: null,
      summarySent: false,
    };
    await safePut(kv, key, data);
    return { isNew: true, total: 1, statusMsgId: null };
  }

  const data = JSON.parse(raw);
  const sinceLastArrival = Date.now() - (data.lastArrival || data.windowStart || 0);

  if (sinceLastArrival > BATCH_WINDOW_MS) {
    // Previous batch window expired — start fresh
    const fresh = {
      windowStart: Date.now(),
      lastArrival: Date.now(),
      images: [{ imageKey, messageId }],
      completed: 0,
      results: [],
      statusMsgId: null,
      summarySent: false,
    };
    await safePut(kv, key, fresh);
    return { isNew: true, total: 1, statusMsgId: null };
  }

  // Same batch — append
  data.images.push({ imageKey, messageId });
  data.lastArrival = Date.now();
  await safePut(kv, key, data);
  return { isNew: false, total: data.images.length, statusMsgId: data.statusMsgId };
}

export async function setStatusMsgId(kv, userId, statusMsgId) {
  const key = `bdat:${userId}`;
  const raw = await safeGet(kv, key);
  if (!raw) return;
  const data = JSON.parse(raw);
  data.statusMsgId = statusMsgId;
  await safePut(kv, key, data);
}

/**
 * Record a completed result.
 * Returns { completed, total, allDone, statusMsgId, data } or null.
 * allDone is only true once — the first caller to see completed===total
 * also sets summarySent=true so other workers don't double-send.
 */
export async function addResult(kv, userId, result) {
  const key = `bdat:${userId}`;

  // Stagger concurrent writes
  await sleep(50 + Math.random() * 200);

  const raw = await safeGet(kv, key);
  if (!raw) return null;

  const data = JSON.parse(raw);
  data.completed = (data.completed || 0) + 1;
  data.results.push(result);

  const completed = data.completed;
  const total = data.images.length;
  let iAmTheSummarySender = false;

  if (completed >= total && !data.summarySent) {
    data.summarySent = true;
    iAmTheSummarySender = true;
  }

  await safePut(kv, key, data);

  return {
    completed,
    total,
    allDone: iAmTheSummarySender, // only ONE worker gets true
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
