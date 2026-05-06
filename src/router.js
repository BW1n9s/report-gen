import { analyzeImage } from './functions/analyzeImage.js';
import { handleTextMessage } from './functions/analyzeText.js';
import { handleCommand, handleItemCardAction } from './functions/commands.js';
import { parseCorrection } from './utils/parseCorrection.js';
import { sendMessage, replyToMessage } from './services/lark.js';
import { getSession, updateSession } from './services/session.js';

const COMMAND_KEYWORDS = new Set([
  'START', 'CHECKSTATUS', 'END', 'ABORT',
  '开始', '检查占用', '结束', '中断',
  'PDI', 'PD', 'SERVICE',
]);

const ITEM_CARD_ACTIONS = new Set([
  'IMG_OK', 'IMG_NG', 'IMG_CORRECT',
  'IMG_NG_SUBMIT', 'IMG_CORRECT_SUBMIT', 'IMG_CANCEL',
]);

// 通过 DO 检查 imageKey 是否已处理过（原子操作）
async function isDuplicate(env, userId, imageKey, chatId) {
  const id   = env.IMAGE_DEDUP.idFromName(userId);
  const stub = env.IMAGE_DEDUP.get(id);
  const res  = await stub.fetch('http://do/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageKey, chatId, userId }),
  });
  const { isNew } = await res.json();
  return !isNew;
}

export async function routeMessage(event, env) {
  try {
    if (event.header?.event_type !== 'im.message.receive_v1') return;
    const { message, sender } = event.event ?? {};
    if (!message || !sender) return;
    if (sender.sender_type !== 'user') return;

    const userId      = sender.sender_id?.open_id;
    const chatId      = message.chat_id;
    const messageType = message.message_type;
    let content;
    try { content = JSON.parse(message.content ?? '{}'); } catch { content = {}; }

    if (messageType === 'image') {
      const messageId = message.message_id;
      const imageKey  = content.image_key;

      if (!imageKey) return;

      const duplicate = await isDuplicate(env, userId, imageKey, chatId);
      if (duplicate) {
        console.log(`[router] duplicate imageKey ${imageKey}, skipping`);
        return;
      }

      try {
        const session = await getSession(userId, env);
        await analyzeImage(imageKey, messageId, session, userId, env);
      } catch (err) {
        console.error('[router] image processing error:', err);
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
        const text    = (content.text ?? '').trim();
        const session = await getSession(userId, env);

        // 先尝试 serial/model 显式修正
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
            'text', env,
          );
          return;
        }

        // 否则：视为对某张图片的 Correction（quote 的是 bot 的卡片回复或原图）
        const doId   = env.IMAGE_DEDUP.idFromName(userId);
        const doStub = env.IMAGE_DEDUP.get(doId);

        const byCardRes = await doStub.fetch(
          `http://do/item-by-card?cardMsgId=${encodeURIComponent(parentId)}`,
        );
        const { item } = await byCardRes.json();

        if (item) {
          const { analyzeCorrection } = await import('./services/claude.js');
          const { updateItemCard }    = await import('./services/lark.js');
          const corrResult = await analyzeCorrection(text, item.reading, env);

          const newReading = corrResult.reading ?? item.reading;
          const newNote    = corrResult.note ?? null;
          const newStatus  = corrResult.action === 'ng' ? 'ng' : 'corrected';

          await doStub.fetch('http://do/item', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              itemId: item.itemId, status: newStatus,
              reading: newReading, note: newNote,
            }),
          });

          if (item.cardMsgId) {
            const itemsRes     = await doStub.fetch('http://do/get-items');
            const { items }    = await itemsRes.json();
            const SECTION_LABEL = {
              attachment_accessories:'附件配件', visual_structure:'外观结构',
              fluid_levels:'油液液位', engine_mechanical:'发动机机械',
              electrical_system:'电气系统', hydraulic_system:'液压系统',
              mast_fork_chain:'门架链条', loader_arm_axle:'大臂车桥',
              steering_brake_dynamic:'转向刹车', tyre_wheel:'轮胎车轮',
              safety_functions:'安全功能', maintenance_work:'保养工作',
              final_result:'最终结果', general:'其他',
            };
            await updateItemCard({
              cardMsgId: item.cardMsgId,
              count:     items.length,
              label:     SECTION_LABEL[item.check_id] ?? item.check_id,
              reading:   newReading,
              itemId:    item.itemId,
              status:    newStatus,
              note:      newNote,
              env,
            });
          }

          await replyToMessage(
            message.message_id,
            JSON.stringify({ text: '✅ 已更新记录' }),
            'text', env,
          );
          return;
        }
        // 找不到对应 item — 继续向下作普通文字处理
      }

      const text = (content.text ?? '').trim();
      const ctx  = { message, userId, chatId, content, env };
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
    const e          = event.event ?? {};
    const action     = e.action?.value?.action;
    const chatId     = e.context?.open_chat_id;
    const userId     = e.operator?.open_id;
    const itemId     = e.action?.value?.itemId;
    const formValues = e.action?.form_values ?? {};

    if (!action || !userId || !chatId) return;

    if (ITEM_CARD_ACTIONS.has(action)) {
      await handleItemCardAction({ action, itemId, formValues, userId, chatId, env });
      return;
    }

    await handleCommand({ text: action, userId, chatId, env });
  } catch (e) {
    console.error('CardAction error:', e);
  }
}
