import { sendMessage } from '../services/lark.js';
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
    await sendMessage(
      chatId,
      `✅ 记录 #${count} 已解析\n\n${analysis}\n\n──────────\n继续发送内容，或发送 /报告 生成巡检报告`,
      env,
    );
  } catch (e) {
    console.error('Text analysis error:', e);
    await sendMessage(chatId, `❌ 文字解析失败：${e.message}`, env);
  }
}
