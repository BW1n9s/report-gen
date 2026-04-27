import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

// 优化：提取 ChatID 的逻辑，兼容卡片上下文
function extractChatId(body) {
  const event = body?.event || {};
  // 优先取卡片上下文的 chat_id，其次取消息的 chat_id
  return event?.context?.open_chat_id || event?.message?.chat_id || event?.chat_id || null;
}

// 优化：提取 ActionValue
function extractActionValue(body) {
  return body?.event?.action?.value || null;
}

// 提取文本
function extractTextMessage(event) {
  if (!event?.message || event.message.message_type !== 'text') return null;
  try {
    const content = JSON.parse(event.message.content || '{}');
    return (content?.text || '').trim();
  } catch { return ''; }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    let body;
    try {
      const raw = await request.json();
      body = raw.encrypt ? await decrypt(raw.encrypt, env.FEISHU_ENCRYPT_KEY) : raw;
    } catch (e) { return new Response('OK'); }

    if (body.type === 'url_verification') return new Response(JSON.stringify({ challenge: body.challenge }));

    const event = body.event;
    const chatId = extractChatId(body);
    const eventType = body.header?.event_type; // 获取事件类型
    
    if (!chatId) return new Response('OK');
    const token = await getLarkToken(env);

    console.log(`🆔 ChatID: ${chatId}, ⚡ EventType: ${eventType}`);

    // 1. 处理卡片点击逻辑 (start 动作)
    if (eventType === 'card.action.trigger') {
      const action = extractActionValue(body);
      if (action?.action === 'start') {
        const type = action.type;
        const existing = await getSession(chatId, env);
        if (existing) {
          await sendConflictCard(chatId, token, existing.report_type);
        } else {
          const newSession = { report_type: type, status: 'collecting', images: [], notes: [], extracted: {} };
          await saveSession(chatId, newSession, env);
          await sendLarkMessage(chatId, { text: `✅ 已进入 ${type} 模式，请发送内容。` }, token);
        }
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 2. 处理普通文本消息
    const text = extractTextMessage(event);
    const messageId = event?.message?.message_id;

    // 结束指令
    if (text === '结束' || text?.toLowerCase() === 'end') {
      const session = await getSession(chatId, env);
      if (session) {
        await deleteSession(chatId, env);
        await sendLarkMessage(chatId, { text: `✅ 会话已结束。` }, token);
      } else {
        await sendLarkMessage(chatId, { text: '⚠️ 无正在进行的会话。' }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 处理会话内逻辑
    let session = await getSession(chatId, env);
    if (!session) {
      if (event?.message) await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    if (event?.message?.message_type === 'image') {
      await sendLarkMessage(chatId, { text: '📸 图片已收到。' }, token, 'text', messageId);
    } else if (text) {
      session.notes.push({ text, ts: Date.now() });
      await saveSession(chatId, session, env);
      await sendLarkMessage(chatId, { text: `✍️ 备注已记录` }, token, 'text', messageId);
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};