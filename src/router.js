import { handleImageMessage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand } from './functions/commands.js';

export async function routeMessage(event, env) {
  try {
    if (event.header?.event_type !== 'im.message.receive_v1') return;

    const { message, sender } = event.event ?? {};
    if (!message || !sender) return;

    // 忽略 Bot 自身消息
    if (sender.sender_type !== 'user') return;

    const userId = sender.sender_id?.open_id;
    const chatId = message.chat_id;
    const messageType = message.message_type;
    let content;

    try {
      content = JSON.parse(message.content ?? '{}');
    } catch {
      content = {};
    }

    const ctx = { message, userId, chatId, content, env };

    if (messageType === 'image') {
      await handleImageMessage(ctx);
    } else if (messageType === 'text') {
      const text = (content.text ?? '').trim();
      if (text.startsWith('/')) {
        await handleCommand({ text, userId, chatId, env });
      } else {
        await handleTextMessage(ctx);
      }
    }
    // 其他类型（文件、语音等）暂时忽略，未来可在此扩展
  } catch (e) {
    console.error('Router error:', e);
  }
}
