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

    // 1. 菜單事件映射
    if (menuKey === "start_pd") actionValue = { action: "start", type: "PD" };
    if (menuKey === "start_service") actionValue = { action: "start", type: "Service" };

    // 2. 處理“結束”邏輯
    if (menuKey === "end") {
      await sendLarkMessage(chatId, { text: "🏁 正在生成報告..." }, token);
      await deleteSession(chatId, env);
      await sendLarkMessage(chatId, { text: "✅ 會話已關閉。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 開啟新會話邏輯
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
      await sendLarkMessage(chatId, { text: `✅ ${newSession.report_type} 流程已啟動！\n您可以發送圖片或文字，輸入“結束”完成。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 繼續任務邏輯
    if (actionValue?.action === "continue") {
      await sendLarkMessage(chatId, { text: "👍 已回到當前任務。請繼續發送信息。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 正常業務流程
    let session = await getSession(chatId, env);
    if (!session) {
      if (event?.message) await sendGuideCard(chatId, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    if (event?.message) {
      const msg = event.message;
      if (msg.message_type === "text") {
        const text = JSON.parse(msg.content).text.trim();
        if (text === "結束" || text === "end") {
          await sendLarkMessage(chatId, { text: "🏁 正在生成報告..." }, token);
          await deleteSession(chatId, env);
          await sendLarkMessage(chatId, { text: "✅ 會話已關閉。" }, token);
        } else {
          session.notes.push({ text, ts: Date.now() });
          await saveSession(chatId, session, env);
          
          // 關鍵修改：只發送簡短確認，並指定 msg.message_id 進行引用
          // 這會讓 Lark 自動顯示引用界面
          await sendLarkMessage(chatId, { text: "✍️ 備註已記錄" }, token, "text", msg.message_id);
        }
      }
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};