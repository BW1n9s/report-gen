// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

function extractChatId(body) {
  const event = body?.event || {};
  return (
    event?.message?.chat_id ||
    event?.chat_id ||
    event?.open_chat_id ||
    body?.open_chat_id ||
    body?.action?.open_chat_id ||
    body?.action?.chat_id ||
    event?.action?.open_chat_id ||
    event?.action?.chat_id ||
    null
  );
}

function extractActionValue(body) {
  return body?.action?.value || body?.event?.action?.value || null;
}

function extractMenuKey(body) {
  const event = body?.event || {};
  return event?.event_key || event?.key || body?.event_key || body?.key || null;
}

function extractTextMessage(event) {
  if (!event?.message || event.message.message_type !== 'text') return null;
  try {
    const parsed = JSON.parse(event.message.content || '{}');
    return (parsed?.text || '').trim();
  } catch {
    return '';
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    let body;
    try {
      body = await request.json();
      if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    } catch {
      return new Response('OK');
    }

    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    const event = body.event;
    const chatId = extractChatId(body);
    if (!chatId) return new Response('OK');

    const token = await getLarkToken(env);
    const menuKey = extractMenuKey(body);
    let actionValue = extractActionValue(body);

    if (menuKey === 'start_pd') actionValue = { action: 'start', type: 'PD' };
    if (menuKey === 'start_service') actionValue = { action: 'start', type: 'Service' };

    if (menuKey === 'end_session') {
      await sendLarkMessage(chatId, { text: '🏁 正在清理并生成报告...' }, token);
      await deleteSession(chatId, env);
      await env.REPORT_SESSIONS.delete(`lock:${chatId}`);
      await sendLarkMessage(chatId, { text: '✅ 会话已成功关闭。' }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    if (actionValue?.action === 'start' || actionValue?.action === 'force_start') {
      const lockKey = `lock:${chatId}`;
      const existing = await getSession(chatId, env);

      if (existing && actionValue?.action !== 'force_start') {
        await sendConflictCard(chatId, token, existing.report_type);
        return new Response(JSON.stringify({ code: 0 }));
      }

      await env.REPORT_SESSIONS.put(lockKey, '1', { expirationTtl: 20 });
      const newSession = {
        report_type: actionValue.type || 'PD',
        status: 'collecting',
        images: [],
        notes: [],
        extracted: { model: '', vin: '', hours: '', date: new Date().toISOString() }
      };

      await saveSession(chatId, newSession, env);
      await env.REPORT_SESSIONS.delete(lockKey);
      await sendLarkMessage(chatId, { text: `✅ ${newSession.report_type} 流程已启动！\n直接发送图片或文字即可记录。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    if (actionValue?.action === 'continue') {
      await sendLarkMessage(chatId, { text: '👍 好的，请继续发送任务相关信息。' }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    let session = await getSession(chatId, env);
    if (!session) {
      const isLocked = await env.REPORT_SESSIONS.get(`lock:${chatId}`);
      if (isLocked) {
        await new Promise((resolve) => setTimeout(resolve, 180));
        session = await getSession(chatId, env);
      }

      if (!session) {
        if (event?.message) await sendGuideCard(chatId, token);
        return new Response(JSON.stringify({ code: 0 }));
      }
    }

    const text = extractTextMessage(event);
    if (text !== null) {
      if (text === '结束' || text.toLowerCase() === 'end') {
        await sendLarkMessage(chatId, { text: '🏁 正在清理...' }, token);
        await deleteSession(chatId, env);
        await env.REPORT_SESSIONS.delete(`lock:${chatId}`);
        await sendLarkMessage(chatId, { text: '✅ 会话已关闭。' }, token);
      } else if (text) {
        session.notes.push({ text, ts: Date.now() });
        await saveSession(chatId, session, env);
        const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
        await sendLarkMessage(chatId, { text: `✍️ 备注已记录\n> ${preview}` }, token, 'text', event.message.message_id);
      }
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};
