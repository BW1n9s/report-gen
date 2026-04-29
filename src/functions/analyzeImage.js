import { getToken, downloadImage, sendMessage, sendCard } from '../services/lark.js';
import { analyzeImageWithClaude, extractNameplateData } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';
import { detectVehicleType, CHECK_KEYWORDS } from '../data/checklists.js';

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
    const token = await getToken(env);
    const imageData = await downloadImage(message.message_id, imageKey, token, env);

    // 主分析
    const analysis = await analyzeImageWithClaude(imageData, env);

    const session = await getSession(userId, env);

    // 如果疑似铭牌且车辆信息尚未确认，尝试提取结构化数据
    if (likelyNameplate(analysis) && !session.vehicle.model) {
      const nameplateData = await extractNameplateData(imageData, env);
      if (nameplateData && nameplateData.model) {
        session.vehicle.model = nameplateData.model;
        session.vehicle.serial = nameplateData.serial;
        session.vehicle.capacity = nameplateData.capacity_kg;
        session.vehicle.year = nameplateData.year;
        // 优先用模型判断，其次用 hint
        session.vehicle.type = detectVehicleType(nameplateData.model) !== 'UNKNOWN'
          ? detectVehicleType(nameplateData.model)
          : nameplateData.vehicle_type_hint ?? 'UNKNOWN';
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
    const vehicleLabel = session.vehicle.model
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
  } catch (e) {
    console.error('Image analysis error:', e);
    await sendMessage(chatId, `❌ Analysis failed: ${e.message}`, env);
  }
}
