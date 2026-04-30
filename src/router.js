import { analyzeImage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand } from './functions/commands.js';
import { parseCorrection } from './utils/parseCorrection.js';
import { registerImage, setStatusMsgId } from './utils/batchTracker.js';
import { sendMessage, replyToMessage } from './services/lark.js';
import { getSession, updateSession } from './services/session.js';

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

    if (messageType === 'image') {
      const messageId = message.message_id;
      const imageKey = content.image_key;

      try {
        const { isNew } = await registerImage(
          env.REPORT_SESSIONS, userId, imageKey, messageId,
        );

        if (isNew) {
          // First image in this batch — send ONE status message
          const statusResp = await sendMessage(chatId, '📸 Photos received — analysing...', env);
          const newStatusMsgId = statusResp?.data?.message_id;
          if (newStatusMsgId) {
            await setStatusMsgId(env.REPORT_SESSIONS, userId, newStatusMsgId);
          }
        }
        // Subsequent images: no message sent here — status updated in analyzeImage

        const session = await getSession(userId, env);
        await analyzeImage(imageKey, messageId, session, userId, env);

      } catch (err) {
        console.error('[router] image processing error:', err);
        // Only send error reply if it's a real failure, not a batch-window issue
        try {
          await replyToMessage(
            messageId,
            JSON.stringify({ text: `❌ Failed to analyse this photo: ${err.message || 'Unknown error'}. Please resend.` }),
            'text',
            env,
          );
        } catch (_) {}
      }
      return;
    }

    if (messageType === 'text') {
      const parentId = message.parent_id;
      if (parentId) {
        const text = (content.text ?? '').trim();
        const session = await getSession(userId, env);
        const correction = parseCorrection(text, session);
        if (correction) {
          if (!session.vehicle) session.vehicle = {};
          Object.assign(session.vehicle, correction.fields);
          await updateSession(userId, session, env);
          const confirmLines = Object.entries(correction.fields)
            .filter(([k]) => k !== 'serialSource')
            .map(([k, v]) => `• ${k}: ${v}`)
            .join('\n');
          await replyToMessage(
            message.message_id,
            JSON.stringify({ text: `✅ Updated:\n${confirmLines}` }),
            'text',
            env,
          );
          return;
        }
      }

      const text = (content.text ?? '').trim();
      const ctx = { message, userId, chatId, content, env };
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
