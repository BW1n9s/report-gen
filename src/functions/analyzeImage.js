import { getToken, downloadImage, replyToMessage, replyCardToMessage, updateTextMessage } from '../services/lark.js';
import { analyzeImageWithClaude, parseAnalysisResponse } from '../services/claude.js';
import { updateSession } from '../services/session.js';
import { detectVehicleType, CHECK_KEYWORDS } from '../data/checklists.js';
import { addResult, clearBatch } from '../utils/batchTracker.js';

function inferCoveredChecks(analysisText) {
  const lower = analysisText.toLowerCase();
  const covered = [];
  for (const [checkId, keywords] of Object.entries(CHECK_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      covered.push(checkId);
    }
  }
  return covered;
}


export async function analyzeImage(imageKey, messageId, session, userId, env) {
  try {
    // Pre-Claude session save — ensures KV has current state before the long API call.
    // If the Worker is killed between Claude returning and the post-analysis save,
    // at least the session (type, startTime, prior items) is not lost.
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
        if (isElectric) parts.push('This is an ELECTRIC vehicle — it has NO engine, NO engine oil, NO fuel system, NO transmission oil.');
      }
      if (session.vehicle.serial) parts.push(`Serial: ${session.vehicle.serial}`);
      if (parts.length > 0) vehicleContext = parts.join('\n');
    }

    const raw = await analyzeImageWithClaude(imageData, env, 25000, vehicleContext);
    const { analysis, nameplateData } = parseAnalysisResponse(raw);

    // ── Nameplate / vehicle info merge ────────────────────────────────────────
    if (nameplateData && nameplateData.model) {
      const incoming = nameplateData.vehicle || nameplateData;
      const incomingIsNameplate = true;

      if (!session.vehicle) session.vehicle = {};

      if (incoming.serial) {
        const existingIsNameplate = session.vehicle.serialSource === 'NAMEPLATE';

        if (!session.vehicle.serial) {
          session.vehicle.serial = incoming.serial;
          session.vehicle.serialSource = incomingIsNameplate ? 'NAMEPLATE' : 'CERT';
        } else if (incomingIsNameplate && !existingIsNameplate) {
          const old = session.vehicle.serial;
          session.vehicle.serial = incoming.serial;
          session.vehicle.serialSource = 'NAMEPLATE';
          nameplateData.flags = nameplateData.flags || [];
          nameplateData.flags.push(`Serial updated to nameplate value: ${incoming.serial} (replaced cert value: ${old})`);
        } else if (!incomingIsNameplate && existingIsNameplate && incoming.serial !== session.vehicle.serial) {
          nameplateData.flags = nameplateData.flags || [];
          nameplateData.flags.push(`Cert serial (${incoming.serial}) differs from nameplate serial (${session.vehicle.serial}) — nameplate retained`);
        }
      }

      if (incoming.model && !session.vehicle.model) session.vehicle.model = incoming.model;
      if (incoming.voltage && !session.vehicle.voltage) session.vehicle.voltage = incoming.voltage;
      if (incoming.capacity_kg && !session.vehicle.capacity) session.vehicle.capacity = incoming.capacity_kg;
      if (incoming.year && !session.vehicle.year) session.vehicle.year = incoming.year;
      if (incoming.chassisNo) session.vehicle.chassisNo = incoming.chassisNo;

      if (!session.vehicle.type || session.vehicle.type === 'UNKNOWN') {
        session.vehicle.type = detectVehicleType(incoming.model) !== 'UNKNOWN'
          ? detectVehicleType(incoming.model)
          : incoming.vehicle_type_hint ?? 'UNKNOWN';
      }

      if (nameplateData.confirmNeeded && nameplateData.confirmPrompt) {
        session.pendingConfirm = {
          prompt: nameplateData.confirmPrompt,
          field: 'serial',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // 记录覆盖的检查项
    const newChecks = inferCoveredChecks(analysis);
    for (const c of newChecks) {
      if (!session.covered_checks.includes(c)) session.covered_checks.push(c);
    }

    session.items.push({
      type: 'image',
      imageKey,
      analysis,
      covered_checks: newChecks,
      timestamp: new Date().toISOString(),
    });

    // Post-Claude session save — full state including new analysis and vehicle info
    await updateSession(userId, session, env);

    // ── Batch tracking ───────────────────────────────────────────────────────

    const parsed = nameplateData; // null for non-nameplate images

    const batchResult = {
      originalMessageId: messageId,
      imageType:     parsed?.imageType    || 'GENERAL',
      confidence:    parsed?.confidence   || 'LOW',
      summary:       buildResultSummary(parsed),
      flags:         parsed?.flags        || [],
      confirmNeeded: parsed?.confirmNeeded || false,
      confirmPrompt: parsed?.confirmPrompt || null,
      vehicle:       parsed?.vehicle      || null,
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
        // Send summary card, quoting the first image in the batch
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

function buildResultSummary(parsed) {
  if (!parsed) return 'No result';
  const type = parsed.imageType || 'GENERAL';
  const findings = (parsed.findings || []).slice(0, 2).join('; ');
  const serial = parsed.vehicle?.serial ? ` | S/N: ${parsed.vehicle.serial}` : '';
  return `[${type}]${serial}${findings ? ' — ' + findings : ''}`;
}

function buildBatchSummaryCard(results, session) {
  const vehicle = session?.vehicle;
  const vehicleLine = vehicle?.serial
    ? `${vehicle.model || 'Unknown model'} | S/N: ${vehicle.serial}${vehicle.serialSource ? ` (source: ${vehicle.serialSource})` : ''}`
    : '⚠️ Vehicle not yet identified';

  const allFlags = results.flatMap((r, i) =>
    (r.flags || []).map(f => `Photo ${i + 1}: ${f}`),
  );

  const resultElements = results.map((r, i) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**📷 Photo ${i + 1}** *(${r.imageType})*\n${r.summary}${r.confirmNeeded ? '\n⚠️ *Confirmation needed — see individual reply above*' : ''}`,
    },
  }));

  const flagElements = allFlags.length > 0
    ? [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**⚠️ Flags:**\n${allFlags.map(f => `• ${f}`).join('\n')}`,
        },
      }]
    : [];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `✅ ${results.length} Photos Analysed` },
      template: allFlags.length > 0 ? 'orange' : 'green',
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
      ...(flagElements.length > 0 ? [{ tag: 'hr' }, ...flagElements] : []),
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: 'Each result corresponds to photos in the order you sent them. Photos with ⚠️ have individual replies above.',
        }],
      },
    ],
  };
}
