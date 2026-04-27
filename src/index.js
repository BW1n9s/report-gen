// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard } from './lark.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");

    let body;
    try {
      body = await request.json();
      if (body.encrypt) {
        body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
      }
    } catch (e) {
      return new Response(JSON.stringify({ code: 1, msg: e.message }));
    }

    // 飞书 URL 验证
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    const chatId = body.event?.message?.chat_id || body.event?.context?.open_chat_id || body.open_chat_id;
    if (!chatId) return new Response("OK");

    ctx.waitUntil((async () => {
      try {
        const token = await getLarkToken(env);
        const action = body.event?.action || body.action;

        // 1. 处理开始动作
        if (action?.value?.action === "start") {
          const newSession = {
            report_type: action.value.type,
            status: "collecting",
            images: [],
            notes: [],
            extracted: { model: "", vin: "", hours: "", date: new Date().toISOString() }
          };
          await saveSession(chatId, newSession, env);
          await sendLarkMessage(chatId, { text: `✅ ${action.value.type} 流程已启动！\n您可以开始发送铭牌图片或文字备注，输入“结束”完成。` }, token);
          return;
        }

        // 2. 检查 Session
        let session = await getSession(chatId, env);
        if (!session) {
          if (body.event?.message) {
            await sendGuideCard(chatId, token);
          }
          return;
        }

        // 3. 处理消息
        if (body.event?.message) {
          const msg = body.event.message;
          if (msg.message_type === "text") {
            const text = JSON.parse(msg.content).text.trim();
            if (text === "结束" || text === "end") {
              await sendLarkMessage(chatId, { text: "🏁 正在生成报告文档..." }, token);
              await deleteSession(chatId, env);
            } else {
              session.notes.push({ text, ts: Date.now() });
              await saveSession(chatId, session, env);
              await sendLarkMessage(chatId, { text: "✍️ 已记录备注" }, token);
            }
          }
          // 图片处理逻辑待续...
        }
      } catch (err) {
        console.error("Worker Error:", err);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};