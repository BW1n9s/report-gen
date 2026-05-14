import { decryptEvent } from './utils/crypto.js';

export { ImageDedupDO } from './session-do.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK');

    // Parse and decrypt must happen synchronously — request body stream
    // is consumed here and cannot be re-read inside waitUntil
    let event;
    try {
      const body = await request.text();
      const parsed = JSON.parse(body);
      if (parsed.encrypt) {
        event = await decryptEvent(parsed.encrypt, env.FEISHU_ENCRYPT_KEY);
      } else {
        event = parsed;
      }
    } catch (e) {
      console.error('Parse/decrypt error:', e);
      return new Response('ok');
    }

    // Challenge must be handled synchronously — Lark needs the value in the response body
    if (event.challenge) {
      return Response.json({ challenge: event.challenge });
    }

    // Queue event into the per-user DO; alarm fires 300ms later in a fresh context,
    // avoiding the 30-second waitUntil wall-clock limit on the free plan.
    const userId = event.event?.sender?.sender_id?.open_id
      ?? event.event?.operator?.open_id
      ?? 'global';
    const doStub = env.IMAGE_DEDUP.get(env.IMAGE_DEDUP.idFromName(userId));
    ctx.waitUntil(
      doStub.fetch('http://do/queue-event', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(event),
      }).catch(err => console.error('[index] queue-event error:', err)),
    );
    return new Response('ok', { status: 200 });
  },
};
