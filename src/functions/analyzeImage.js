import { getToken, downloadImage, replyToMessage, replyCardToMessage, updateTextMessage } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { updateSession } from '../services/session.js';
import { addResult, clearBatch } from '../utils/batchTracker.js';

export async function analyzeImage(imageKey, messageId, session, userId, env) {
  try {
    // Pre-Claude session save — ensures KV has current state before the long API call.
    await updateSession(userId, session, env);

    const token = await getToken(env);
    const imageData = await downloadImage(messageId, imageKey, token, env);

    // Build vehicle context from session
    let vehicleContext = null;
    if (session.vehicle) {
      const parts = [];
      if (session.vehicle.model) parts.push(`Model: ${session.vehicle.model}`);
      if (session.vehicle.type) {
        const isElectric = session.vehicle.type === 'FORKLIFT_ELECTRIC' || session.vehicle.type === 'FORKLIFT_WALKIE';
        parts.push(`Vehicle type: ${session.vehicle.type}`);
        if (isElectric) parts.push('ELECTRIC: no engine_oil/transmission_oil/fuel.');
      }
      if (session.vehicle.serial) parts.push(`Serial: ${session.vehicle.serial}`);
      if (parts.length > 0) vehicleContext = parts.join('\n');
    }

    const result = await analyzeImageWithClaude(imageData, env, 25000, vehicleContext);

    // 铭牌处理
    const nameplateData = result.nameplate;
    if (nameplateData && nameplateData.model) {
      if (!session.vehicle) session.vehicle = {};
      if (nameplateData.model && !session.vehicle.model) session.vehicle.model = nameplateData.model;
      if (nameplateData.serial && !session.vehicle.serial) {
        session.vehicle.serial = nameplateData.serial;
        session.vehicle.serialSource = 'NAMEPLATE';
      }
      if (nameplateData.voltage && !session.vehicle.voltage) session.vehicle.voltage = nameplateData.voltage;
      if (nameplateData.capacity_kg && !session.vehicle.capacity) session.vehicle.capacity = nameplateData.capacity_kg;
      if (nameplateData.year && !session.vehicle.year) session.vehicle.year = nameplateData.year;
      if (!session.vehicle.type || session.vehicle.type === 'UNKNOWN') {
        session.vehicle.type = nameplateData.vehicle_type ?? 'UNKNOWN';
      }
      if (nameplateData.confirm_needed && nameplateData.confirm_prompt) {
        session.pendingConfirm = {
          prompt: nameplateData.confirm_prompt,
          field: 'serial',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // 检查项覆盖
    const checkId = result.check_id;
    if (checkId && checkId !== 'general' && !session.covered_checks.includes(checkId)) {
      session.covered_checks.push(checkId);
    }

    // 存储精简记录（不存原始 analysis 文字，只存标签）
    session.items.push({
      type: 'image',
      imageKey,
      check_id: result.check_id,
      status: result.status,
      reading: result.reading,
      timestamp: new Date().toISOString(),
    });

    // Post-Claude session save — full state including new analysis and vehicle info
    await updateSession(userId, session, env);

    // ── Batch tracking ───────────────────────────────────────────────────────

    const batchResult = {
      originalMessageId: messageId,
      check_id: result.check_id,
      status: result.status,
      reading: result.reading,
      confirmNeeded: nameplateData?.confirm_needed || false,
      confirmPrompt: nameplateData?.confirm_prompt || null,
    };

    const batchStatus = await addResult(env.REPORT_SESSIONS, userId, batchResult);

    if (batchStatus) {
      const { completed, total, allDone, statusMsgId, data } = batchStatus;

      // Update the single status message with current count
      if (statusMsgId) {
        try {
          await updateTextMessage(
            statusMsgId,
            allDone
              ? `✅ ${completed}/${total} 已处理完成，以下是分析结果`
              : `📸 已收到 ${total} 张，正在处理 (${completed}/${total} 完成)...`,
            env,
          );
        } catch (_) {}
      }

      // allDone is true for exactly ONE worker (the last to finish)
      if (allDone) {
        try {
          const summaryCard = buildBatchSummaryCard(data.results, session);
          const firstMsgId = data.images?.[0]?.messageId || messageId;
          await replyCardToMessage(firstMsgId, summaryCard, env);
        } catch (e) {
          console.error('[analyzeImage] summary card failed:', e);
        }

        // Send individual confirm prompts ONLY for items that need it
        for (const r of data.results) {
          if (r.confirmNeeded && r.confirmPrompt) {
            try {
              await replyToMessage(
                r.originalMessageId,
                JSON.stringify({ text: `⚠️ Please confirm for this photo:\n${r.confirmPrompt}` }),
                'text',
                env,
              );
            } catch (_) {}
          }
        }

        await clearBatch(env.REPORT_SESSIONS, userId);
      }
    }

    // ── End batch tracking ────────────────────────────────────────────────────

  } catch (e) {
    console.error('Image analysis error:', e);
    await replyToMessage(messageId, JSON.stringify({ text: `❌ Analysis failed: ${e.message}` }), 'text', env);
  }
}

function buildBatchSummaryCard(results, session) {
  const vehicle = session?.vehicle;
  const vehicleLine = vehicle?.serial
    ? `${vehicle.model || 'Unknown model'} | S/N: ${vehicle.serial}${vehicle.serialSource ? ` (source: ${vehicle.serialSource})` : ''}`
    : '⚠️ Vehicle not yet identified';

  const resultElements = results.map((r, i) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**📷 Photo ${i + 1}** *(${r.check_id})*\n${r.reading} — ${r.status}${r.confirmNeeded ? '\n⚠️ *Confirmation needed — see individual reply above*' : ''}`,
    },
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `✅ ${results.length} Photos Analysed` },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Vehicle:** ${vehicleLine}`,
        },
      },
      { tag: 'hr' },
      ...resultElements,
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: 'Each result corresponds to photos in the order you sent them.',
        }],
      },
    ],
  };
}
