import { getToken, downloadImage, sendMessage, sendCard } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';

export async function handleImageMessage({ message, userId, chatId, content, env }) {
  const imageKey = content.image_key;
  if (!imageKey) return;

  await sendMessage(chatId, '🔍 正在识别图片，请稍候…', env);

  try {
    const token = await getToken(env);
    const imageData = await downloadImage(message.message_id, imageKey, token, env);
    const analysis = await analyzeImageWithClaude(imageData, env);

    const session = await getSession(userId, env);
    session.items.push({
      type: 'image',
      imageKey,
      analysis,
      timestamp: new Date().toISOString(),
    });
    await updateSession(userId, session, env);

    const count = session.items.length;

    await sendCard(chatId, {
      header: { title: `✅ 图片 #${count} 识别完成`, style: 'green' },
      body: analysis,
      buttons: [
        { label: '检查占用', action: 'CHECKSTATUS', type: 'default' },
        { label: '结束', action: 'END', type: 'danger' },
      ],
    }, env);
  } catch (e) {
    console.error('Image analysis error:', e);
    await sendMessage(chatId, `❌ 图片识别失败：${e.message}`, env);
  }
}
