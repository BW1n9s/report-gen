// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

// 辅助函数：提取必要信息
function extractChatId(body) {
  const event = body?.event || {};
  return event?.message?.chat_id || event?.chat_id || event?.open_chat_id || null;
}

function extractActionValue(body) {
  return body?.action?.value || body?.event?.action?.value || null;
}

function extractMenuKey(body) {
  const event = body?.event || {};
  return event?.event_key || event?.key || null;
}

function extractTextMessage(event) {
  if (!event?.message || event.message.message_type !== 'text') return null;
  try {
    const parsed = JSON.parse(event.message.content || '{}');
    return (parsed?.text || '').trim();
  } catch { return ''; }
}

// 格式化报告总结
function formatSessionSummary(session) {
  return `📊 **会话已结束，内容摘要**：
--------------------------
类型: ${session.report_type}
模型: ${session.extracted.model || '未识别'}
VIN: ${session.extracted.vin || '未识别'}
机时: ${session.extracted.hours || '未识别'}
备注条数: ${session.notes.length}
图片张数: ${session.images.length}
--------------------------`;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    let body;
    try {
      body = await request.json();
      if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    } catch { return new Response('OK'); }

    if (body.type === 'url_verification') return new Response(JSON.stringify({ challenge: body.challenge }));

    const event = body.event;
    const chatId = extractChatId(body);
    const messageId = event?.message?.message_id;
    if (!chatId) return new Response('OK');

    const token = await getLarkToken(env);
    const menuKey = extractMenuKey(body);
    let actionValue = extractActionValue(body);

    // 快捷菜单映射
    if (menuKey === 'start_pd') actionValue = { action: 'start', type: 'PD' };
    if (menuKey === 'start_service') actionValue = { action: 'start', type: 'Service' };

    // 1. 处理结束命令 (随时可触发)
    const text = extractTextMessage(event);
    if (text === '结束' || text?.toLowerCase() === 'end') {
      const session = await getSession(chatId, env);
      if (session) {
        const summary = formatSessionSummary(session);
        await deleteSession(chatId, env);
        await sendLarkMessage(chatId, { text: `✅ 会话已手动关闭。\n\n${summary}` }, token);
      } else {
        await sendLarkMessage(chatId, { text: '⚠️ 当前没有进行中的会话。' }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 2. 处理启动逻辑
    if (actionValue?.action === 'start' || actionValue?.action === 'force_start') {
      const existing = await getSession(chatId, env);
      if (existing && actionValue?.action !== 'force_start') {
        await sendConflictCard(chatId, token, existing.report_type);
        return new Response(JSON.stringify({ code: 0 }));
      }

      const newSession = {
        report_type: actionValue.type || 'PD',
        status: 'initializing', // 设置为初始化中
        images: [],
        notes: [],
        extracted: { model: '', vin: '', hours: '', date: new Date().toISOString() }
      };

      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `🔄 正在初始化 ${newSession.report_type} 流程...` }, token);
      
      // 模拟初始化完成（后续可接数据库操作）
      newSession.status = 'collecting';
      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `✅ 初始化完成！已进入 ${newSession.report_type} 采集模式。\n请发送图片或备注。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 处理会话内逻辑
    let session = await getSession(chatId, env);
    if (!session) {
      // 未进入 session 时，引导用户
      if (event?.message) await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 初始化未完成限制
    if (session.status === 'initializing') {
      await sendLarkMessage(chatId, { text: '⏳ 会话正在初始化中，请稍候...' }, token, 'text', messageId);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 处理图片输入 (引用回复)
    if (event?.message?.message_type === 'image') {
      await sendLarkMessage(chatId, { text: '📸 图片已收到，读图功能正在开发中。' }, token, 'text', messageId);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 处理文本记录 (引用回复)
    if (text) {
      session.notes.push({ text, ts: Date.now() });
      await saveSession(chatId, session, env);
      await sendLarkMessage(chatId, { text: `✍️ 备注已记录` }, token, 'text', messageId);
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};