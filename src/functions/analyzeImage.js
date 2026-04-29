import { getToken, downloadImage, sendMessage, sendCard } from '../services/lark.js';
import { analyzeImageWithClaude, extractNameplateData } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';
import { detectVehicleType, CHECK_KEYWORDS } from '../data/checklists.js';
import { withUserQueue } from '../utils/userQueue.js';

// 判断图片分析结果覆盖了哪些检查项
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

// 判断是否是铭牌图片
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

export async function handleImageMessage({ message, userId, chatId, content, env }) {
  const imageKey = content.image_key;
  if (!imageKey) return;

  await sendMessage(chatId, '🔍 Analysing image...', env);

  try {
    // Download before the queue lock (no session state involved)
    const token = await getToken(env);
    const imageData = await downloadImage(message.message_id, imageKey, token, env);

    // 主分析 (outside lock — pure Claude call, no session writes)
    const analysis = await analyzeImageWithClaude(imageData, env);

    // Nameplate extraction if needed (also outside lock)
    let nameplateData = null;
    if (likelyNameplate(analysis)) {
      nameplateData = await extractNameplateData(imageData, env);
    }

    // All session reads + writes inside the queue lock
    await withUserQueue(env.REPORT_SESSIONS, userId, async () => {
      const session = await getSession(userId, env);

      // ── Nameplate / vehicle info merge ────────────────────────────────────
      if (nameplateData && nameplateData.model) {
        const parsed = nameplateData;
        const incoming = parsed.vehicle || parsed; // flat response from PROMPT_DETECT_VEHICLE
        const incomingIsNameplate = parsed.imageType === 'NAMEPLATE' || true; // nameplate path always true here

        if (!session.vehicle) session.vehicle = {};

        // Serial number priority logic
        if (incoming.serial) {
          const existingIsNameplate = session.vehicle.serialSource === 'NAMEPLATE';

          if (!session.vehicle.serial) {
            session.vehicle.serial = incoming.serial;
            session.vehicle.serialSource = incomingIsNameplate ? 'NAMEPLATE' : 'CERT';
          } else if (incomingIsNameplate && !existingIsNameplate) {
            const old = session.vehicle.serial;
            session.vehicle.serial = incoming.serial;
            session.vehicle.serialSource = 'NAMEPLATE';
            parsed.flags = parsed.flags || [];
            parsed.flags.push(`Serial updated to nameplate value: ${incoming.serial} (replaced cert value: ${old})`);
          } else if (!incomingIsNameplate && existingIsNameplate && incoming.serial !== session.vehicle.serial) {
            parsed.flags = parsed.flags || [];
            parsed.flags.push(`Cert serial (${incoming.serial}) differs from nameplate serial (${session.vehicle.serial}) — nameplate retained`);
          }
        }

        // Merge other fields — nameplate values never overwritten by cert
        if (incoming.model && !session.vehicle.model) session.vehicle.model = incoming.model;
        if (incoming.voltage && !session.vehicle.voltage) session.vehicle.voltage = incoming.voltage;
        if (incoming.capacity_kg && !session.vehicle.capacity) session.vehicle.capacity = incoming.capacity_kg;
        if (incoming.year && !session.vehicle.year) session.vehicle.year = incoming.year;
        if (incoming.chassisNo) session.vehicle.chassisNo = incoming.chassisNo;

        // Derive vehicle type
        if (!session.vehicle.type || session.vehicle.type === 'UNKNOWN') {
          session.vehicle.type = detectVehicleType(incoming.model) !== 'UNKNOWN'
            ? detectVehicleType(incoming.model)
            : incoming.vehicle_type_hint ?? 'UNKNOWN';
        }

        // confirmNeeded — park a pending prompt for the user
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

      // 写入 item
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

      await sendCard(chatId, {
        header: { title: `✅ Photo #${count} Analysed`, style: 'green' },
        body: `${analysis}\n\n──────────\n🔧 ${vehicleLabel}`,
        buttons: [
          { label: 'Check Status', action: 'CHECKSTATUS', type: 'default' },
          { label: 'End', action: 'END', type: 'danger' },
        ],
      }, env);

      // Prompt user to confirm uncertain serial reading
      if (session.pendingConfirm) {
        await sendMessage(chatId, `⚠️ Uncertain reading — ${session.pendingConfirm.prompt}`, env);
      }
    });
  } catch (e) {
    console.error('Image analysis error:', e);
    await sendMessage(chatId, `❌ Analysis failed: ${e.message}`, env);
  }
}
