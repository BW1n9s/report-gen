import { handleImageMessage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand } from './functions/commands.js';

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
    const e = event.event ?? {};
    const action = e.action?.value?.action;
    const chatId = e.context?.open_chat_id;
    const userId = e.operator?.open_id;

    console.log('[CardAction] action:', action, 'userId:', userId, 'chatId:', chatId);

    if (!action || !userId || !chatId) {
      console.warn('[CardAction] missing required fields', { action, userId, chatId });
      return;
    }

    await handleCommand({ text: action, userId, chatId, env });
  } catch (e) {
    console.error('CardAction error:', e);
  }
}
