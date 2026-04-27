import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

const SESSION_TTL_SECONDS = 86400;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function parseBody(request, env) {
  const payload = await request.json();

  // URL 验证
  if (payload?.type === 'url_verification') {
    return { verification: payload.challenge };
  }

  // 飞书加密事件
  if (payload?.encrypt) {
    if (!env.FEISHU_ENCRYPT_KEY) {
      throw new Error('Missing FEISHU_ENCRYPT_KEY');
    }
    return decrypt(payload.encrypt, env.FEISHU_ENCRYPT_KEY);
  }

  return payload;
}

function extractChatId(body) {
  return (
    body?.event?.message?.chat_id ||
    body?.event?.open_chat_id ||
    body?.open_message_id ||
    body?.chat_id ||
    null
  );
}

function extractTextMessage(event) {
  if (event?.message?.message_type !== 'text') return '';
  const raw = event.message.content;
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    return (parsed?.text || '').trim();
  } catch {
    return String(raw).trim();
  }
}

function extractActionValue(body) {
  const actionValue = body?.action?.value;
  if (!actionValue) return null;

  if (typeof actionValue === 'string') {
    try {
      return JSON.parse(actionValue);
    } catch {
      return null;
    }
  }

  return actionValue;
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
    ? session.notes.map((n, idx) => `${idx + 1}. ${n.text}`).join('\n')
    : '（无文字记录）';

  const imageLines = session.images.length
    ? session.images.map((img, idx) => `${idx + 1}. image_key=${img.image_key || 'unknown'}`).join('\n')
    : '（无图片记录）';

  return [
    '📊 会话已结束，以下是本次记录：',
    `类型: ${session.report_type}`,
    `文字记录数: ${session.notes.length}`,
    noteLines,
    `图片记录数: ${session.images.length}`,
    imageLines
  ].join('\n\n');
}

export default {
  async fetch(request, env) {
    try {
      const body = await parseBody(request, env);

      if (body?.verification) {
        return jsonResponse({ challenge: body.verification });
      }

      const event = body?.event || {};
      const chatId = extractChatId(body);

      if (!chatId) {
        return jsonResponse({ code: 0, msg: 'missing chat_id' });
      }

      const messageId = event?.message?.message_id || body?.open_message_id || null;
      const token = await getLarkToken(env);

      const text = extractTextMessage(event);
      const textLower = text.toLowerCase();

      // 4) 会话中随时结束
      if (text === '结束' || textLower === 'end') {
        const current = await getSession(chatId, env);
        if (!current) {
          await sendLarkMessage(chatId, { text: '当前没有进行中的 session。' }, token, 'text', messageId);
          return jsonResponse({ code: 0 });
        }

        const summary = buildSummary(current);
        await deleteSession(chatId, env);
        await sendLarkMessage(chatId, { text: summary }, token, 'text', messageId);
        return jsonResponse({ code: 0 });
      }

      // 2) 处理卡片点击进入 session
      const actionValue = extractActionValue(body);
      if (actionValue?.action === 'start' && (actionValue?.type === 'PD' || actionValue?.type === 'Service')) {
        const existing = await getSession(chatId, env);
        if (existing) {
          await sendConflictCard(chatId, token, existing.report_type);
          return jsonResponse({ code: 0 });
        }

        const session = buildSession(actionValue.type);
        await saveSession(chatId, session, env, SESSION_TTL_SECONDS);
        await sendLarkMessage(
          chatId,
          { text: `✅ 已进入 ${actionValue.type} session，正在初始化，请稍候...` },
          token,
          'text',
          messageId
        );

        // 这里预留初始化逻辑（例如加载模板、检查依赖等）
        const activeSession = {
          ...session,
          status: 'active',
          initialized_at: Date.now()
        };
        await saveSession(chatId, activeSession, env, SESSION_TTL_SECONDS);
        await sendLarkMessage(chatId, { text: `✅ ${actionValue.type} session 初始化完成，可以开始记录。` }, token);
        return jsonResponse({ code: 0 });
      }

      // 3/5/6) session 内消息处理
      const session = await getSession(chatId, env);
      if (session) {
        if (session.status !== 'active') {
          await sendLarkMessage(chatId, { text: '⏳ session 仍在初始化中，暂时不能记录，请稍候。' }, token, 'text', messageId);
          return jsonResponse({ code: 0 });
        }

        if (event?.message?.message_type === 'image') {
          session.images.push({
            image_key: extractImageKey(event),
            timestamp: Date.now()
          });
          await saveSession(chatId, session, env, SESSION_TTL_SECONDS);
          await sendLarkMessage(chatId, { text: '📸 图片已收到，读图功能正在开发中。' }, token, 'text', messageId);
          return jsonResponse({ code: 0 });
        }

        if (text) {
          session.notes.push({ text, timestamp: Date.now() });
          await saveSession(chatId, session, env, SESSION_TTL_SECONDS);
          await sendLarkMessage(chatId, { text: '✍️ 已记录。' }, token, 'text', messageId);
          return jsonResponse({ code: 0 });
        }

        return jsonResponse({ code: 0 });
      }

      // 1) session 外任意内容都提示进入并选择类型
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
