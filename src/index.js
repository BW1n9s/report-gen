// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, initSession } from './session.js';
import { getLarkToken, sendLarkMessage } from './lark.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body = await request.json();
    if (body.encrypt) {
      body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    }

    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    const chatId = body.event?.message?.chat_id || body.event?.context?.open_chat_id;
    if (!chatId) return new Response("OK");

    const token = await getLarkToken(env);

    ctx.waitUntil((async () => {
      // 1. 处理开始指令 (卡片点击)
      const action = body.event?.action || body.action;
      if (action?.value?.action === "start") {
        await initSession(chatId, action.value.type, env);
        await sendLarkMessage(chatId, { text: `✅ ${action.value.type} 已开启！\n请发送图片或备注。` }, token);
        return;
      }

      // 2. 检查 Session 状态
      let session = await getSession(chatId, env);
      if (!session) return; // 或发送引导卡片

      // 3. 处理消息内容
      if (body.event?.message) {
        const { message_type, content } = body.event.message;
        
        if (message_type === "text") {
          const text = JSON.parse(content).text.trim();
          if (text === "结束" || text === "end") {
            // 执行生成文档流程
          } else {
            session.notes.push({ text, timestamp: Date.now() });
            await saveSession(chatId, session, env);
          }
        }
        
        if (message_type === "image") {
          // 调用 ai.js 中的 askGemini 并更新 session
        }
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};