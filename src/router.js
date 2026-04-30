import { analyzeImage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand } from './functions/commands.js';
import { withUserQueue } from './utils/userQueue.js';
import { parseCorrection } from './utils/parseCorrection.js';
import { replyToMessage } from './services/lark.js';
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
      const imageKey = JSON.parse(message.content).image_key;

      // Send immediate acknowledgement
      // (already sent "🔍 Analysing image..." before this point — keep that)

      try {
        const session = await getSession(userId, env);
        await withUserQueue(env.REPORT_SESSIONS, userId, async () => {
          await analyzeImage(imageKey, messageId, session, userId, env);
        });
      } catch (err) {
        console.error('[router] analyzeImage failed:', err);
        // Always send a failure reply so user is not left hanging
        try {
          await replyToMessage(
            messageId,
            JSON.stringify({ text: `❌ Analysis failed: ${err.message || 'Unknown error'}. Please resend the photo.` }),
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
