import { sendMessage, sendCard } from '../services/lark.js';
import { analyzeTextWithClaude } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';

export async function handleTextMessage({ userId, chatId, content, env }) {
  const text = (content.text ?? '').trim();
  if (!text) return;

  try {
    const analysis = await analyzeTextWithClaude(text, env);

    const session = await getSession(userId, env);
    session.items.push({
      type: 'text',
      original: text,
      analysis,
      timestamp: new Date().toISOString(),
    });
    await updateSession(userId, session, env);

    const count = session.items.length;

    // 引用用户原文 + 显示解析结果
    await sendCard(chatId, {
      header: { title: `✅ 记录 #${count} 已解析`, style: 'green' },
      // 原文引用 + 解析结果
      body: `💬 原文：\n"${text}"\n\n📋 解析结果：\n${analysis}`,
      buttons: [
        { label: '检查占用', action: 'CHECKSTATUS', type: 'default' },
        { label: '结束', action: 'END', type: 'danger' },
      ],
    }, env);
  } catch (e) {
    console.error('Text analysis error:', e);
    await sendMessage(chatId, `❌ 文字解析失败：${e.message}`, env);
  }
}
