import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

// 提取消息文本的辅助函数
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
      if (raw.encrypt) {
        body = await decrypt(raw.encrypt, env.FEISHU_ENCRYPT_KEY);
      } else {
        body = raw;
      }
      // 记录收到的所有内容，方便在 Cloudflare Logs 查看
      console.log("📥 [Log] 收到请求体:", JSON.stringify(body));
    } catch (e) {
      console.error("❌ [Log] 解析失败:", e);
      return new Response('OK');
    }

    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    const event = body.event;
    const chatId = event?.message?.chat_id || event?.chat_id || null;
    const messageId = event?.message?.message_id;
    const text = extractTextMessage(event);

    if (!chatId) return new Response('OK');
    const token = await getLarkToken(env);

    console.log(`🆔 ChatID: ${chatId}, 💬 识别文本: "${text}"`);

    // 1. 处理结束命令 (不依赖 Session 状态)
    if (text === '结束' || text?.toLowerCase() === 'end') {
      const session = await getSession(chatId, env);
      if (session) {
        await deleteSession(chatId, env);
        await sendLarkMessage(chatId, { text: `✅ 会话已结束。` }, token);
      } else {
        await sendLarkMessage(chatId, { text: '⚠️ 当前没有进行中的会话。' }, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 2. 检查是否有 Session
    let session = await getSession(chatId, env);

    // 3. 处理“启动会话”逻辑 (通过文本匹配按钮文字)
    // 假设你的按钮发送的文字就是 "PD" 或 "Service"
    if (!session && (text === 'PD' || text === 'Service')) {
      console.log(`⚡ [Log] 触发启动: ${text}`);
      const newSession = { 
        report_type: text, 
        status: 'collecting', 
        images: [], 
        notes: [], 
        extracted: {} 
      };
      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `✅ 已进入 ${text} 模式，请开始发送内容。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 未进入 Session 时的引导
    if (!session) {
      console.log("🧐 [Log] 未在 Session 中，发送引导卡片");
      await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 会话内消息处理
    console.log("📝 [Log] 处理会话内容...");
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