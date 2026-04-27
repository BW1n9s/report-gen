import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

// 辅助函数保持不变
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

function formatSessionSummary(session) {
  return `📊 **会话已结束，内容摘要**：\n类型: ${session.report_type}\n备注: ${session.notes.length}\n图片: ${session.images.length}`;
}

export default {
  async fetch(request, env) {
    console.log("🚀 [Log] Worker 收到请求");

    if (request.method !== 'POST') return new Response('OK');

    let body;
    try {
      const raw = await request.json();
      if (raw.encrypt) {
        body = await decrypt(raw.encrypt, env.FEISHU_ENCRYPT_KEY);
        console.log("✅ [Log] 解密成功:", JSON.stringify(body));
      } else {
        body = raw;
      }
    } catch (e) {
      console.error("❌ [Log] 解密或解析失败:", e);
      return new Response('OK'); // 必须返回OK防止飞书重试
    }

    if (body.type === 'url_verification') {
      console.log("🔗 [Log] 收到验证请求");
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    const event = body.event;
    const chatId = extractChatId(body);
    console.log("🆔 [Log] 当前 ChatID:", chatId);
    
    if (!chatId) {
      console.log("⚠️ [Log] 无法获取 ChatID，跳过处理");
      return new Response('OK');
    }

    const token = await getLarkToken(env);
    const menuKey = extractMenuKey(body);
    let actionValue = extractActionValue(body);
    
    console.log(`🔍 [Log] MenuKey: ${menuKey}, ActionValue: ${JSON.stringify(actionValue)}`);

    // 快捷菜单映射
    if (menuKey === 'start_pd') actionValue = { action: 'start', type: 'PD' };
    if (menuKey === 'start_service') actionValue = { action: 'start', type: 'Service' };

    // 处理结束命令
    const text = extractTextMessage(event);
    if (text === '结束' || text?.toLowerCase() === 'end') {
      console.log("🛑 [Log] 收到结束指令");
      const session = await getSession(chatId, env);
      if (session) {
        await deleteSession(chatId, env);
        await sendLarkMessage(chatId, { text: `✅ 会话已手动结束。` }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 处理启动逻辑
    if (actionValue?.action === 'start') {
      console.log("⚡ [Log] 尝试启动 Session:", actionValue.type);
      const existing = await getSession(chatId, env);
      if (existing) {
        console.log("⚠️ [Log] Session 已存在，发送冲突卡片");
        await sendConflictCard(chatId, token, existing.report_type);
      } else {
        const newSession = { report_type: actionValue.type, status: 'collecting', images: [], notes: [], extracted: {} };
        await saveSession(chatId, newSession, env);
        console.log("✅ [Log] Session 初始化成功");
        await sendLarkMessage(chatId, { text: `✅ 已进入 ${newSession.report_type} 模式。` }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 处理会话内逻辑
    let session = await getSession(chatId, env);
    if (!session) {
      console.log("🧐 [Log] 未在 Session 中，发送引导卡片");
      if (event?.message) await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    console.log("📝 [Log] 处理会话消息");
    if (event?.message?.message_type === 'image') {
      await sendLarkMessage(chatId, { text: '📸 图片已收到。' }, token);
    } else if (text) {
      session.notes.push({ text, ts: Date.now() });
      await saveSession(chatId, session, env);
      await sendLarkMessage(chatId, { text: `✍️ 收到记录。` }, token);
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};