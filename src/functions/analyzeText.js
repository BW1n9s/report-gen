import { sendMessage, sendCard } from '../services/lark.js';
import { analyzeTextWithClaude } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';

export async function handleTextMessage({ userId, chatId, content, env }) {
  const text = (content.text ?? '').trim();
  if (!text) return;

  try {
    const result = await analyzeTextWithClaude(text, env);

    const session = await getSession(userId, env);
    if (result.check_id && result.check_id !== 'general' && !session.covered_checks.includes(result.check_id)) {
      session.covered_checks.push(result.check_id);
    }
    session.items.push({
      type: 'text',
      check_id: result.check_id,
      status: result.status,
      reading: result.reading,
      raw: text,
      timestamp: new Date().toISOString(),
    });
    await updateSession(userId, session, env);

    const count = session.items.length;
    await sendCard(chatId, {
      header: { title: `✅ 记录 #${count}`, style: 'green' },
      body: `📋 ${result.check_id} — ${result.status}\n${result.reading}`,
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
