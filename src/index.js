import { decryptEvent } from './utils/crypto.js';
import { routeMessage } from './router.js';
import { routeCardAction } from './router.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK');

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

    if (event.challenge) {
      return Response.json({ challenge: event.challenge });
    }

    const eventId = event.header?.event_id;
    if (eventId) {
      const seen = await env.REPORT_SESSIONS.get(`event:${eventId}`);
      if (seen) return new Response('ok');
      await env.REPORT_SESSIONS.put(`event:${eventId}`, '1', { expirationTtl: 86400 });
    }

    const eventType = event.header?.event_type;

    if (eventType === 'im.message.receive_v1') {
      ctx.waitUntil(routeMessage(event, env));
    } else if (eventType === 'card.action.trigger') {
      ctx.waitUntil(routeCardAction(event, env));
    }

    return new Response('ok');
  },
};
