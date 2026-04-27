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

    // 飞书 URL 验证
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    const event = body.event;
    // 获取各种场景下的 chatId
    const chatId = event?.message?.chat_id || 
                   event?.action?.open_chat_id || 
                   event?.open_chat_id || 
                   body.action?.open_chat_id;

    if (!chatId) return new Response("OK");

    const token = await getLarkToken(env);
    
    // 关键修正：兼容自定义菜单的 event_key
    const menuKey = event?.event_key || event?.key; 
    let actionValue = event?.action?.value || body.action?.value;

    // 1. 映射底部菜单事件到 actionValue
    if (menuKey === "start_pd") actionValue = { action: "start", type: "PD" };
    if (menuKey === "start_service") actionValue = { action: "start", type: "Service" };

    // 2. 处理“结束会话”逻辑 (匹配 end_session)
    if (menuKey === "end_session") {
      await sendLarkMessage(chatId, { text: "🏁 正在生成报告..." }, token);
      await deleteSession(chatId, env);
      await env.REPORT_SESSIONS.delete(`lock:${chatId}`); // 清除锁
      await sendLarkMessage(chatId, { text: "✅ 会话已成功关闭。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 处理开始或强制开始逻辑
    if (actionValue?.action === "start" || actionValue?.action === "force_start") {
      const lockKey = `lock:${chatId}`;
      
      const existing = await getSession(chatId, env);
      if (existing && actionValue?.action !== "force_start") {
        await sendConflictCard(chatId, token, existing.report_type);
        return new Response(JSON.stringify({ code: 0 }));
      }

      // 设置锁并创建会话
      await env.REPORT_SESSIONS.put(lockKey, "1", { expirationTtl: 10 }); 
      const newSession = {
        report_type: actionValue.type || "PD",
        status: "collecting",
        images: [],
        notes: [],
        extracted: { model: "", vin: "", hours: "", date: new Date().toISOString() }
      };
      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `✅ ${newSession.report_type} 流程已启动！\n直接发送图片或文字即可记录，输入“结束”完成。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 处理继续任务逻辑
    if (actionValue?.action === "continue") {
      await sendLarkMessage(chatId, { text: "👍 已回到当前任务。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 业务消息处理
    let session = await getSession(chatId, env);
    
    // 解决延迟体验问题：如果读取不到 session 
    if (!session) {
      const isLocked = await env.REPORT_SESSIONS.get(`lock:${chatId}`);
      if (isLocked) {
        // 如果有锁但没 session，说明 KV 还没同步完，此时不做报错处理，允许静默等待
        return new Response(JSON.stringify({ code: 0 }));
      }
      
      // 只有在没 Session 且没锁的情况下，才给用户发引导卡片
      if (event?.message) {
        await sendGuideCard(chatId, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 记录文字备注
    if (event?.message && event.message.message_type === "text") {
      const text = JSON.parse(event.message.content).text.trim();
      
      if (text === "结束" || text === "end") {
        await sendLarkMessage(chatId, { text: "🏁 正在生成报告..." }, token);
        await deleteSession(chatId, env);
        await env.REPORT_SESSIONS.delete(`lock:${chatId}`);
        await sendLarkMessage(chatId, { text: "✅ 会话已关闭。" }, token);
      } else {
        session.notes.push({ text, ts: Date.now() });
        await saveSession(chatId, session, env);
        // 使用引用回复方式确认
        await sendLarkMessage(chatId, { text: "✍️ 备注已记录" }, token, "text", event.message.message_id);
      }
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};