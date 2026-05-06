import { getToken, downloadImage, replyToMessage } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { updateSession } from '../services/session.js';

export async function analyzeImage(imageKey, messageId, session, userId, env) {
  try {
    await updateSession(userId, session, env);

    const token     = await getToken(env);
    const imageData = await downloadImage(messageId, imageKey, token, env);

    // 构建车辆上下文
    let vehicleContext = null;
    if (session.vehicle) {
      const parts = [];
      if (session.vehicle.model) parts.push(`Model: ${session.vehicle.model}`);
      if (session.vehicle.type) {
        const isElectric = session.vehicle.type === 'FORKLIFT_ELECTRIC'
                        || session.vehicle.type === 'FORKLIFT_WALKIE';
        parts.push(`Vehicle type: ${session.vehicle.type}`);
        if (isElectric) parts.push('ELECTRIC: no engine_oil/transmission_oil/fuel.');
      }
      if (session.vehicle.serial) parts.push(`Serial: ${session.vehicle.serial}`);
      if (parts.length > 0) vehicleContext = parts.join('\n');
    }

    const result = await analyzeImageWithClaude(imageData, env, 25000, vehicleContext);

    // 铭牌处理
    const nameplateData = result.nameplate;
    if (nameplateData?.model) {
      if (!session.vehicle) session.vehicle = {};
      if (!session.vehicle.model)   session.vehicle.model   = nameplateData.model;
      if (!session.vehicle.serial && nameplateData.serial) {
        session.vehicle.serial       = nameplateData.serial;
        session.vehicle.serialSource = 'NAMEPLATE';
      }
      if (!session.vehicle.voltage  && nameplateData.voltage)     session.vehicle.voltage  = nameplateData.voltage;
      if (!session.vehicle.capacity && nameplateData.capacity_kg) session.vehicle.capacity = nameplateData.capacity_kg;
      if (!session.vehicle.year     && nameplateData.year)        session.vehicle.year     = nameplateData.year;
      if (!session.vehicle.type || session.vehicle.type === 'UNKNOWN')
        session.vehicle.type = nameplateData.vehicle_type ?? 'UNKNOWN';
    }

    // 记录检查项
    const checkId = result.check_id;
    if (checkId && checkId !== 'nameplate' && checkId !== 'general'
        && !session.covered_checks.includes(checkId)) {
      session.covered_checks.push(checkId);
    }

    session.items.push({
      type:      'image',
      imageKey,
      check_id:  result.check_id,
      status:    result.status,
      reading:   result.reading,
      timestamp: new Date().toISOString(),
    });

    await updateSession(userId, session, env);

    // DO /result — 更新进度卡片
    const doId   = env.IMAGE_DEDUP.idFromName(userId);
    const doStub = env.IMAGE_DEDUP.get(doId);
    await doStub.fetch('http://do/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        check_id: result.check_id,
        status:   result.status,
        reading:  result.reading,
        vehicle:  session.vehicle,
      }),
    });

    // 只有需要人工确认时才单独回复（序列号模糊等）
    if (nameplateData?.confirm_needed && nameplateData?.confirm_prompt) {
      await replyToMessage(
        messageId,
        JSON.stringify({ text: `⚠️ ${nameplateData.confirm_prompt}` }),
        'text',
        env,
      );
    }

  } catch (e) {
    console.error('Image analysis error:', e);
    await replyToMessage(
      messageId,
      JSON.stringify({ text: `❌ Analysis failed: ${e.message}` }),
      'text',
      env,
    ).catch(() => {});
  }
}
