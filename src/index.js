import { decryptEvent } from './utils/crypto.js';
import { routeMessage } from './router.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    let event;
    try {
      const body = await request.text();
      const parsed = JSON.parse(body);

      // 解密（如果启用了加密）
      if (parsed.encrypt) {
        event = await decryptEvent(parsed.encrypt, env.FEISHU_ENCRYPT_KEY);
      } else {
        event = parsed;
      }
    } catch (e) {
      console.error('Parse/decrypt error:', e);
      return new Response('ok');
    }

    // URL 验证握手
    if (event.challenge) {
      return Response.json({ challenge: event.challenge });
    }

    // 去重：同一事件 Lark 可能推送多次
    const eventId = event.header?.event_id;
    if (eventId) {
      const seen = await env.REPORT_SESSIONS.get(`event:${eventId}`);
      if (seen) return new Response('ok');
      await env.REPORT_SESSIONS.put(`event:${eventId}`, '1', { expirationTtl: 86400 });
    }

    // 立即返回 200，异步处理（Lark 要求 3 秒内响应）
    ctx.waitUntil(routeMessage(event, env));
    return new Response('ok');
  },
};
