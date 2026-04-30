import { decryptEvent } from './utils/crypto.js';
import { routeMessage, routeCardAction } from './router.js';

// Dedup + routing — runs inside waitUntil so the 200 is returned first
async function handleRequest(event, env) {
  const eventId = event.header?.event_id;
  if (eventId) {
    try {
      const seen = await env.REPORT_SESSIONS.get(`event:${eventId}`);
      if (seen) return;
      await env.REPORT_SESSIONS.put(`event:${eventId}`, '1', { expirationTtl: 86400 });
    } catch (_) {}
  }

  const eventType = event.header?.event_type;
  if (eventType === 'im.message.receive_v1') {
    await routeMessage(event, env);
  } else if (eventType === 'card.action.trigger') {
    await routeCardAction(event, env);
  }
}

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

    // Everything else (dedup + routing) runs in waitUntil so we can return 200 immediately
    const processingPromise = handleRequest(event, env).catch(err => {
      console.error('[index] Unhandled error:', err);
    });
    ctx.waitUntil(processingPromise);
    return new Response('ok', { status: 200 });
  },
};
