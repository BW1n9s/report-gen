import { handleImageMessage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand } from './functions/commands.js';

// 所有应该被识别为指令的关键词（菜单按钮发送的文字 + 斜杠指令）
const COMMAND_KEYWORDS = new Set([
  'START', 'CHECKSTATUS', 'END',
  '开始', '检查占用', '结束',
  'PD', 'SERVICE',
]);

export async function routeMessage(event, env) {
  try {
    if (event.header?.event_type !== 'im.message.receive_v1') return;
    const { message, sender } = event.event ?? {};
    if (!message || !sender) return;
    if (sender.sender_type !== 'user') return;

    const userId = sender.sender_id?.open_id;
    const chatId = message.chat_id;
    const messageType = message.message_type;
    let content;
    try { content = JSON.parse(message.content ?? '{}'); } catch { content = {}; }

    const ctx = { message, userId, chatId, content, env };

    if (messageType === 'image') {
      await handleImageMessage(ctx);
    } else if (messageType === 'text') {
      const text = (content.text ?? '').trim();
      if (text.startsWith('/') || COMMAND_KEYWORDS.has(text)) {
        await handleCommand({ text, userId, chatId, env });
      } else {
        await handleTextMessage(ctx);
      }
    }
  } catch (e) {
    console.error('Router error:', e);
  }
}

export async function routeCardAction(event, env) {
  try {
    const action = event.event?.action?.value?.action;
    const userId = event.event?.operator?.open_id;
    const chatId = event.event?.context?.open_chat_id;
    if (!action || !userId || !chatId) return;

    await handleCommand({ text: action, userId, chatId, env });
  } catch (e) {
    console.error('CardAction error:', e);
  }
}
