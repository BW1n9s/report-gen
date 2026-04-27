import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, replyLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

function extractChatId(body) {
  // Regular message event
  if (body.event?.message?.chat_id) return body.event.message.chat_id;
  // Card action event
  if (body.event?.context?.open_chat_id) return body.event.context.open_chat_id;
  return null;
}

function extractActionValue(body) {
  return body.event?.action?.value ?? null;
}

function extractTextMessage(event) {
  if (event?.message?.message_type !== 'text') return null;
  try {
    const content = JSON.parse(event.message.content);
    return content.text?.trim() || null;
  } catch {
    return null;
  }
}

function buildSummary(session) {
  const lines = [`📊 ${session.report_type} 会话记录`];
  if (session.notes.length > 0) {
    lines.push(`\n📝 备注 (${session.notes.length} 条):`);
    session.notes.forEach((n, i) => lines.push(`${i + 1}. ${n.text}`));
  }
  if (session.images.length > 0) {
    lines.push(`\n📷 图片: ${session.images.length} 张`);
  }
  if (session.notes.length === 0 && session.images.length === 0) {
    lines.push('（无记录内容）');
  }
  return lines.join('\n');
}

export default {
  async fetch(request, env, ctx) {
    let body;
    try {
      const raw = await request.json();
      body = raw.encrypt ? await decrypt(raw.encrypt, env.LARK_ENCRYPT_KEY) : raw;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Webhook URL verification challenge
    if (body.challenge) {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const event = body.event;
    const chatId = extractChatId(body);
    if (!chatId) return new Response(JSON.stringify({ code: 0 }));

    const messageId = event?.message?.message_id;
    const token = await getLarkToken(env);
    const text = extractTextMessage(event);

    // 1. End command — works anytime inside a session
    if (text === '结束' || text?.toLowerCase() === 'end') {
      const session = await getSession(chatId, env);
      if (session) {
        const summary = buildSummary(session);
        await deleteSession(chatId, env);
        await replyLarkMessage(messageId, { text: `✅ 会话已结束。\n\n${summary}` }, token);
      } else {
        await replyLarkMessage(messageId, { text: '当前没有进行中的会话。' }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 2. Card button actions
    const actionValue = extractActionValue(body);
    if (actionValue) {
      if (actionValue.action === 'continue') {
        // User chose to keep existing session — no-op
        return new Response(JSON.stringify({ code: 0 }));
      }

      if (actionValue.action === 'start' || actionValue.action === 'force_start') {
        const existing = await getSession(chatId, env);

        if (existing && actionValue.action !== 'force_start') {
          // Show conflict card, pass the new type so force_start knows what to start
          await sendConflictCard(chatId, token, existing.report_type, actionValue.type);
          return new Response(JSON.stringify({ code: 0 }));
        }

        const reportType = actionValue.type;
        // Mark as initializing immediately so any racing messages are held
        await saveSession(chatId, { report_type: reportType, status: 'initializing', images: [], notes: [] }, env);
        await sendLarkMessage(chatId, { text: `🔄 正在启动 ${reportType} 流程，请稍候...` }, token);

        // Return to Feishu immediately — continue init in background
        ctx.waitUntil((async () => {
          // Place any real async initialisation work here (external APIs, etc.)
          await saveSession(chatId, { report_type: reportType, status: 'active', images: [], notes: [] }, env);
          await sendLarkMessage(chatId, {
            text: `✅ ${reportType} 会话已就绪，开始记录吧！\n\n发送"结束"或"END"可结束会话并输出记录。`
          }, token);
        })());

        return new Response(JSON.stringify({ code: 0 }));
      }
    }

    // 3. In-session message handling
    const session = await getSession(chatId, env);
    if (session) {
      if (session.status === 'initializing') {
        await sendLarkMessage(chatId, { text: '⏳ 正在初始化中，请稍候...' }, token);
        return new Response(JSON.stringify({ code: 0 }));
      }

      // Image message
      if (event?.message?.message_type === 'image') {
        session.images.push({ ts: Date.now() });
        await saveSession(chatId, session, env);
        await replyLarkMessage(messageId, { text: '📸 图片已收到，读图功能正在开发中。' }, token);
        return new Response(JSON.stringify({ code: 0 }));
      }

      // Text message — quote the original and confirm recording
      if (text) {
        session.notes.push({ text, ts: Date.now() });
        await saveSession(chatId, session, env);
        await replyLarkMessage(messageId, { text: '✍️ 已记录' }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. Outside session — show type selection card
    if (event?.message) {
      await sendGuideCard(chatId, token);
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};
