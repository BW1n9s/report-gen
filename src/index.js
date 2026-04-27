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
      console.error("[Fatal] Decrypt/Parse Error:", e.message);
      return new Response(JSON.stringify({ code: 1, msg: "decryption_failed" }));
    }

    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    // 统一提取 ID
    const chatId = body.event?.message?.chat_id || 
                   body.event?.context?.open_chat_id || 
                   body.action?.open_chat_id || 
                   body.open_chat_id;

    if (!chatId) {
      console.warn("[Warn] No ChatID found in request body");
      return new Response("OK");
    }

    ctx.waitUntil((async () => {
      try {
        const token = await getLarkToken(env);
        const action = body.event?.action || body.action;

        // 1. 处理开始动作
        if (action?.value?.action === "start") {
          console.log(`[Action] Starting ${action.value.type} for ${chatId}`);
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

        // 2. 检查 Session 状态
        let session = await getSession(chatId, env);
        if (!session) {
          if (body.event?.message) {
            console.log("[Info] No session, sending guide card");
            await sendGuideCard(chatId, token);
          }
          return;
        }

        // 3. 处理消息内容
        if (body.event?.message) {
          const msg = body.event.message;
          
          // 处理文本
          if (msg.message_type === "text") {
            const text = JSON.parse(msg.content).text.trim();
            if (text === "结束" || text === "end") {
              console.log("[Action] Finishing session for", chatId);
              await sendLarkMessage(chatId, { text: "🏁 正在汇总信息，准备生成报告文档..." }, token);
              // TODO: 此处后续接入生成 Lark Doc 的逻辑
              await deleteSession(chatId, env);
              await sendLarkMessage(chatId, { text: "✅ 报告已生成（模拟），会话已关闭。" }, token);
            } else {
              session.notes.push({ text, ts: Date.now() });
              await saveSession(chatId, session, env);
              await sendLarkMessage(chatId, { text: "✍️ 已记录备注" }, token);
            }
          }
          
          // 处理图片（防止报错导致异常结束）
          if (msg.message_type === "image") {
            console.log("[Action] Image received, starting AI analysis...");
            await sendLarkMessage(chatId, { text: "🔍 收到图片，正在尝试识别信息..." }, token);
            // 这里后续调用 ai.js
          }
        }
      } catch (err) {
        // 捕获异步链路中的所有错误并打印
        console.error("[Critical Error in waitUntil]:", err.stack);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};