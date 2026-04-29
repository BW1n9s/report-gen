import { getToken, downloadImage, sendMessage, replyToMessage, replyCardToMessage } from '../services/lark.js';
import { analyzeImageWithClaude, extractNameplateData } from '../services/claude.js';
import { updateSession } from '../services/session.js';
import { detectVehicleType, CHECK_KEYWORDS } from '../data/checklists.js';

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

function likelyNameplate(analysisText) {
  const lower = analysisText.toLowerCase();
  return (
    lower.includes('nameplate') ||
    lower.includes('data plate') ||
    lower.includes('serial') ||
    lower.includes('rated capacity') ||
    lower.includes('model') ||
    lower.includes('year of manufacture') ||
    lower.includes('铭牌') ||
    lower.includes('合格证')
  );
}

export async function analyzeImage(imageKey, messageId, session, userId, env) {
  await replyToMessage(messageId, JSON.stringify({ text: '🔍 Analysing image...' }), 'text', env);

  try {
    const token = await getToken(env);
    const imageData = await downloadImage(messageId, imageKey, token, env);

    const analysis = await analyzeImageWithClaude(imageData, env);

    let nameplateData = null;
    if (likelyNameplate(analysis)) {
      nameplateData = await extractNameplateData(imageData, env);
    }

    // ── Nameplate / vehicle info merge ────────────────────────────────────────
    if (nameplateData && nameplateData.model) {
      const incoming = nameplateData.vehicle || nameplateData;
      const incomingIsNameplate = true; // this path is always from a nameplate extraction

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

    await updateSession(userId, session, env);

    const count = session.items.length;
    const vehicleLabel = session.vehicle?.model
      ? `${session.vehicle.model}${session.vehicle.serial ? ' · ' + session.vehicle.serial : ''}`
      : 'Vehicle not yet identified';

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `✅ Photo #${count} Analysed` },
        template: 'green',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `${analysis}\n\n──────────\n🔧 ${vehicleLabel}` },
        },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'Check Status' }, type: 'default', value: { action: 'CHECKSTATUS' } },
            { tag: 'button', text: { tag: 'plain_text', content: 'End' }, type: 'danger', value: { action: 'END' } },
          ],
        },
      ],
    };
    await replyCardToMessage(messageId, card, env);

    if (session.pendingConfirm) {
      await replyToMessage(
        messageId,
        JSON.stringify({ text: `⚠️ Uncertain reading — ${session.pendingConfirm.prompt}` }),
        'text',
        env,
      );
    }
  } catch (e) {
    console.error('Image analysis error:', e);
    await replyToMessage(messageId, JSON.stringify({ text: `❌ Analysis failed: ${e.message}` }), 'text', env);
  }
}
