// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");

    let body;
    try {
      body = await request.json();
      if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    } catch (e) { return new Response("OK"); }

    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    const event = body.event;
    const chatId = event?.message?.chat_id || 
                   event?.action?.open_chat_id || 
                   event?.open_chat_id || 
                   body.action?.open_chat_id || 
                   event?.context?.open_chat_id;

    if (!chatId) return new Response("OK");

    const token = await getLarkToken(env);
    const menuKey = event?.key; 
    let actionValue = event?.action?.value || body.action?.value;

    // 1. 菜单事件映射
    if (menuKey === "start_pd") actionValue = { action: "start", type: "PD" };
    if (menuKey === "start_service") actionValue = { action: "start", type: "Service" };

    // 2. 处理“结束”逻辑 (支持菜单点击)
    if (menuKey === "end") {
      await sendLarkMessage(chatId, { text: "🏁 正在生成报告..." }, token);
      await deleteSession(chatId, env);
      await sendLarkMessage(chatId, { text: "✅ 会话已关闭。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 开启新会话逻辑 (保留 60s 锁)
    if (actionValue?.action === "start" || actionValue?.action === "force_start") {
      const lockKey = `lock:${chatId}`;
      const isLocked = await env.REPORT_SESSIONS.get(lockKey);
      if (isLocked && actionValue?.action !== "force_start") return new Response(JSON.stringify({ code: 0 })); 
      await env.REPORT_SESSIONS.put(lockKey, "1", { expirationTtl: 60 }); 

      const existing = await getSession(chatId, env);
      if (existing && actionValue?.action !== "force_start") {
        await sendConflictCard(chatId, token, existing.report_type);
        return new Response(JSON.stringify({ code: 0 }));
      }

      const newSession = {
        report_type: actionValue.type || "PD",
        status: "collecting",
        images: [],
        notes: [],
        extracted: { model: "", vin: "", hours: "", date: new Date().toISOString() }
      };
      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `✅ ${newSession.report_type} 流程已启动！\n您可以发送图片或文字，输入“结束”完成。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 继续任务逻辑
    if (actionValue?.action === "continue") {
      await sendLarkMessage(chatId, { text: "👍 已回到当前任务。请继续发送信息。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 正常业务流程
    let session = await getSession(chatId, env);
    if (!session) {
      if (event?.message) await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    if (event?.message) {
      const msg = event.message;
      if (msg.message_type === "text") {
        const text = JSON.parse(msg.content).text.trim();
        // 文字输入的结束逻辑
        if (text === "结束" || text === "end") {
          await sendLarkMessage(chatId, { text: "🏁 正在生成报告..." }, token);
          await deleteSession(chatId, env);
          await sendLarkMessage(chatId, { text: "✅ 会话已关闭。" }, token);
        } else {
          session.notes.push({ text, ts: Date.now() });
          await saveSession(chatId, session, env);
          // 引用原文回复: 传入 msg.message_id
          await sendLarkMessage(chatId, { text: "✍️ 备注已记录" }, token, "text", msg.message_id);
        }
      }
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};