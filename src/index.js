// src/index.js
import { decrypt } from './utils.js';
import { getSession, saveSession, deleteSession } from './session.js';
import { getLarkToken, sendLarkMessage, sendGuideCard, sendConflictCard } from './lark.js';

// ... (extractChatId, extractActionValue, extractTextMessage 等辅助函数保持不变)

export default {
  async fetch(request, env) {
    // ... (解密逻辑保持不变)

    const event = body.event;
    const chatId = extractChatId(body);
    const messageId = event?.message?.message_id; // 获取当前消息 ID 用于引用
    const token = await getLarkToken(env);

    // 1. 处理结束命令 (随时可触发)
    const text = extractTextMessage(event);
    if (text === '结束' || text?.toLowerCase() === 'end') {
        const session = await getSession(chatId, env);
        if (session) {
            const summary = `📊 会话结束\n类型: ${session.report_type}\n备注: ${session.notes.length}\n图片: ${session.images.length}`;
            await deleteSession(chatId, env);
            await sendLarkMessage(chatId, { text: `✅ 会话已结束。\n\n${summary}` }, token, "text", messageId);
        }
        return new Response(JSON.stringify({ code: 0 }));
    }

    // 2. 处理启动按钮逻辑
    const actionValue = extractActionValue(body);
    if (actionValue?.action === 'start') {
        const existing = await getSession(chatId, env);
        if (existing) {
            // 如果已在初始化或已在 session 中，提示冲突
            await sendConflictCard(chatId, token, existing.report_type);
        } else {
            // 立即标记为 initializing，防止重复点击
            await saveSession(chatId, { report_type: actionValue.type, status: 'initializing', images: [], notes: [] }, env);
            await sendLarkMessage(chatId, { text: `🔄 正在启动 ${actionValue.type} 流程...` }, token);
            
            // 这里执行你的初始化耗时操作...
            // 完成后更新状态
            await saveSession(chatId, { report_type: actionValue.type, status: 'active', images: [], notes: [] }, env);
            await sendLarkMessage(chatId, { text: `✅ 初始化完成，可以开始记录了。` }, token);
        }
        return new Response(JSON.stringify({ code: 0 }));
    }

    // 3. 处理会话内消息
    let session = await getSession(chatId, env);
    if (session) {
        // 状态检查
        if (session.status === 'initializing') {
            await sendLarkMessage(chatId, { text: '⏳ 正在初始化中，请稍候...' }, token, "text", messageId);
            return new Response(JSON.stringify({ code: 0 }));
        }

        // 处理图片
        if (event?.message?.message_type === 'image') {
            await sendLarkMessage(chatId, { text: '📸 图片已收到，读图功能正在开发中。' }, token, "text", messageId);
            return new Response(JSON.stringify({ code: 0 }));
        }

        // 处理文本 (引用回复)
        if (text) {
            session.notes.push({ text, ts: Date.now() });
            await saveSession(chatId, session, env);
            await sendLarkMessage(chatId, { text: `✍️ 已记录: ${text}` }, token, "text", messageId);
        }
        return new Response(JSON.stringify({ code: 0 }));
    }

    // 4. 未进入 Session，触发引导
    if (event?.message) {
        await sendGuideCard(chatId, token);
    }

    return new Response(JSON.stringify({ code: 0 }));
  }
};