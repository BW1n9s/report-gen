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

    // 🌟 更加鲁棒的 ID 提取：涵盖 菜单、卡片、普通消息 三种场景
    const chatId = event?.message?.chat_id || 
                   body?.open_chat_id || 
                   event?.open_chat_id || 
                   body?.action?.open_chat_id;

    if (!chatId) return new Response("OK");

    const token = await getLarkToken(env);

    // 🌟 提取菜单 Key (底部自定义菜单)
    const menuKey = event?.event_key || event?.key; 
    
    // 🌟 提取卡片 Value (Guide卡片按钮)
    let actionValue = body?.action?.value || event?.action?.value;

    // 1. 映射底部菜单事件
    if (menuKey === "start_pd") actionValue = { action: "start", type: "PD" };
    if (menuKey === "start_service") actionValue = { action: "start", type: "Service" };

    // 2. 处理“结束会话” (匹配 end_session)
    if (menuKey === "end_session") {
      await sendLarkMessage(chatId, { text: "🏁 正在清理并生成报告..." }, token);
      await deleteSession(chatId, env);
      await env.REPORT_SESSIONS.delete(`lock:${chatId}`);
      await sendLarkMessage(chatId, { text: "✅ 会话已成功关闭。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 处理开始逻辑
    if (actionValue?.action === "start" || actionValue?.action === "force_start") {
      const lockKey = `lock:${chatId}`;
      const existing = await getSession(chatId, env);

      // 如果已有会话且不是强制开始，弹窗确认
      if (existing && actionValue?.action !== "force_start") {
        await sendConflictCard(chatId, token, existing.report_type);
        return new Response(JSON.stringify({ code: 0 }));
      }

      // 创建新 Session
      await env.REPORT_SESSIONS.put(lockKey, "1", { expirationTtl: 60 }); 
      const newSession = {
        report_type: actionValue.type || "PD",
        status: "collecting",
        images: [],
        notes: [],
        extracted: { model: "", vin: "", hours: "", date: new Date().toISOString() }
      };
      await saveSession(chatId, newSession, env);
      await sendLarkMessage(chatId, { text: `✅ ${newSession.report_type} 流程已启动！\n直接发送图片或文字即可记录。` }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 处理继续逻辑
    if (actionValue?.action === "continue") {
      await sendLarkMessage(chatId, { text: "👍 好的，请继续发送任务相关信息。" }, token);
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 5. 业务逻辑处理
    let session = await getSession(chatId, env);
    
    if (!session) {
      // 检查是否正在初始化（KV 延迟）
      const isLocked = await env.REPORT_SESSIONS.get(`lock:${chatId}`);
      if (isLocked) return new Response(JSON.stringify({ code: 0 })); // 静默等待

      // 只有在确定没 Session 的普通消息才发引导
      if (event?.message) {
        await sendGuideCard(chatId, token);
      }
      return new Response(JSON.stringify({ code: 0 }));
    }

    // 处理文字消息记录
    if (event?.message && event.message.message_type === "text") {
      const text = JSON.parse(event.message.content).text.trim();
      
      // 兼容文字输入“结束”
      if (text === "结束" || text === "end") {
        await sendLarkMessage(chatId, { text: "🏁 正在清理..." }, token);
        await deleteSession(chatId, env);
        await env.REPORT_SESSIONS.delete(`lock:${chatId}`);
        await sendLarkMessage(chatId, { text: "✅ 会话已关闭。" }, token);
      } else {
        session.notes.push({ text, ts: Date.now() });
        await saveSession(chatId, session, env);
        // 标准引用回复
        await sendLarkMessage(chatId, { text: "✍️ 备注已记录" }, token, "text", event.message.message_id);
      }
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};