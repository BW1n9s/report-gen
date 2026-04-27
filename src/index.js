import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, replyLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function parseBody(request, env) {
  const payload = await request.json();

  if (payload?.type === 'url_verification') {
    return { verification: payload.challenge };
  }

  if (payload?.encrypt) {
    if (!env.FEISHU_ENCRYPT_KEY) throw new Error('Missing FEISHU_ENCRYPT_KEY');
    return decrypt(payload.encrypt, env.FEISHU_ENCRYPT_KEY);
  }

  return payload;
}

function extractChatId(body) {
  return (
    body?.event?.message?.chat_id ||
    body?.event?.context?.open_chat_id ||
    body?.event?.open_chat_id ||
    body?.chat_id ||
    null
  );
}

function extractTextMessage(event) {
  if (event?.message?.message_type !== 'text') return '';
  const raw = event.message.content;
  if (!raw) return '';
  try {
    return (JSON.parse(raw)?.text || '').trim();
  } catch {
    return String(raw).trim();
  }
}

function extractActionValue(body) {
  const v = body?.event?.action?.value ?? body?.action?.value;
  if (!v) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

function extractImageKey(event) {
  const raw = event?.message?.content;
  if (!raw) return '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed?.image_key || '';
  } catch {
    return '';
  }
}

function buildSession(type) {
  return {
    report_type: type,
    status: 'initializing',
    initialized_at: null,
    started_at: Date.now(),
    notes: [],
    images: []
  };
}

function buildSummary(session) {
  const noteLines = session.notes.length
    ? session.notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
    : '（无文字记录）';

  const imageLines = session.images.length
    ? session.images.map((img, i) => `${i + 1}. image_key=${img.image_key || 'unknown'}`).join('\n')
    : '（无图片记录）';

  return [
    `📊 ${session.report_type} 会话已结束，以下是本次记录：`,
    `文字记录 ${session.notes.length} 条：`,
    noteLines,
    `图片记录 ${session.images.length} 张：`,
    imageLines
  ].join('\n\n');
}

export default {
  async fetch(request, env, ctx) {
    try {
      const body = await parseBody(request, env);

      if (body?.verification) {
        return jsonResponse({ challenge: body.verification });
      }

      const event = body?.event || {};
      const chatId = extractChatId(body);
      if (!chatId) return jsonResponse({ code: 0, msg: 'missing chat_id' });

      const messageId = event?.message?.message_id || null;
      const token = await getLarkToken(env);
      const text = extractTextMessage(event);

      // 1. End command — works anytime inside a session
      if (text === '结束' || text.toLowerCase() === 'end') {
        const current = await getSession(chatId, env);
        if (!current) {
          await replyLarkMessage(messageId, { text: '当前没有进行中的 session。' }, token);
          return jsonResponse({ code: 0 });
        }
        const summary = buildSummary(current);
        await deleteSession(chatId, env);
        await replyLarkMessage(messageId, { text: summary }, token);
        return jsonResponse({ code: 0 });
      }

      // 2. Card button actions
      const actionValue = extractActionValue(body);
      if (actionValue) {
        if (actionValue.action === 'continue') {
          return jsonResponse({ code: 0 });
        }

        if (actionValue.action === 'start' || actionValue.action === 'force_start') {
          const existing = await getSession(chatId, env);

          if (existing && actionValue.action !== 'force_start') {
            await sendConflictCard(chatId, token, existing.report_type, actionValue.type);
            return jsonResponse({ code: 0 });
          }

          const reportType = actionValue.type;
          const session = buildSession(reportType);
          await saveSession(chatId, session, env);
          await sendLarkMessage(chatId, { text: `🔄 已进入 ${reportType} session，正在初始化，请稍候...` }, token);

          // Return to Feishu immediately, finish init in background
          ctx.waitUntil((async () => {
            // Place any async init work here (load templates, external APIs, etc.)
            const activeSession = { ...session, status: 'active', initialized_at: Date.now() };
            await saveSession(chatId, activeSession, env);
            await sendLarkMessage(chatId, {
              text: `✅ ${reportType} session 初始化完成，可以开始记录了。\n\n发送"结束"或"END"可结束 session 并输出记录。`
            }, token);
          })());

          return jsonResponse({ code: 0 });
        }
      }

      // 3. In-session message handling
      const session = await getSession(chatId, env);
      if (session) {
        if (session.status !== 'active') {
          await sendLarkMessage(chatId, { text: '⏳ Session 仍在初始化中，请稍候...' }, token);
          return jsonResponse({ code: 0 });
        }

        // Image
        if (event?.message?.message_type === 'image') {
          session.images.push({ image_key: extractImageKey(event), timestamp: Date.now() });
          await saveSession(chatId, session, env);
          await replyLarkMessage(messageId, { text: '📸 图片已收到，读图功能正在开发中。' }, token);
          return jsonResponse({ code: 0 });
        }

        // Text — quote original and confirm
        if (text) {
          session.notes.push({ text, timestamp: Date.now() });
          await saveSession(chatId, session, env);
          await replyLarkMessage(messageId, { text: '✍️ 已记录。' }, token);
        }

        return jsonResponse({ code: 0 });
      }

      // 4. Outside session — show guide card
      if (event?.message) {
        await sendGuideCard(chatId, token);
      }

      return jsonResponse({ code: 0 });
    } catch (error) {
      console.error('Webhook error:', error);
      return jsonResponse({ code: 500, msg: error?.message || 'internal error' }, 500);
    }
  }
};
