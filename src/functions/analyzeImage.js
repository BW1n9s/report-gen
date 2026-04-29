import { getToken, downloadImage, sendMessage } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';

export async function handleImageMessage({ message, userId, chatId, content, env }) {
  const imageKey = content.image_key;
  if (!imageKey) return;

  await sendMessage(chatId, '🔍 正在识别图片，请稍候…', env);

  try {
    // 用同一个 token 完成下载，减少 API 调用
    const token = await getToken(env);
    const imageData = await downloadImage(message.message_id, imageKey, token, env);

    // Claude Vision 分析
    const analysis = await analyzeImageWithClaude(imageData, env);

    // 写入 session
    const session = await getSession(userId, env);
    session.items.push({
      type: 'image',
      imageKey,
      analysis,
      timestamp: new Date().toISOString(),
    });
    await updateSession(userId, session, env);

    const count = session.items.length;
    await sendMessage(
      chatId,
      `✅ 图片 #${count} 识别完成\n\n${analysis}\n\n──────────\n继续发送图片或文字，或发送 /报告 生成巡检报告`,
      env,
    );
  } catch (e) {
    console.error('Image analysis error:', e);
    await sendMessage(chatId, `❌ 图片识别失败：${e.message}`, env);
  }
}
