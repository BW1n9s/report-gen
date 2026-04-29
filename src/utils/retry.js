export async function withRetry(fn, options = {}) {
  const { maxAttempts = 4, baseDelay = 1200, maxDelay = 20000 } = options;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (result && typeof result.status === 'number' && result.status === 429) {
        const retryAfter = result.headers?.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay) + Math.random() * 600;
        if (attempt < maxAttempts) { await sleep(delay); continue; }
        throw Object.assign(new Error('Claude API rate limit exceeded after retries'), { status: 429 });
      }
      return result;
    } catch (err) {
      lastError = err;
      const is429 =
        err?.status === 429 ||
        String(err?.message).includes('429') ||
        String(err?.message).includes('rate_limit');
      if (!is429 || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay) + Math.random() * 600;
      await sleep(delay);
    }
  }
  throw lastError;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
