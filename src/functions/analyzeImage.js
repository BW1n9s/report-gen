import { getToken, downloadImage, replyToMessage, sendItemCard } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { updateSession } from '../services/session.js';

const SECTION_LABEL = {
  attachment_accessories:  '附件配件',
  visual_structure:        '外观结构',
  fluid_levels:            '油液液位',
  engine_mechanical:       '发动机机械',
  electrical_system:       '电气系统',
  hydraulic_system:        '液压系统',
  mast_fork_chain:         '门架链条',
  loader_arm_axle:         '大臂车桥',
  steering_brake_dynamic:  '转向刹车',
  tyre_wheel:              '轮胎车轮',
  safety_functions:        '安全功能',
  maintenance_work:        '保养工作',
  final_result:            '最终结果',
  nameplate:               '铭牌',
  general:                 '其他',
};

export async function analyzeImage(imageKey, messageId, session, userId, env) {
  try {
    await updateSession(userId, session, env);

    const token     = await getToken(env);
    const imageData = await downloadImage(messageId, imageKey, token, env);

    // 车辆上下文
    let vehicleContext = null;
    if (session.vehicle) {
      const parts = [];
      if (session.vehicle.model) parts.push(`Model: ${session.vehicle.model}`);
      if (session.vehicle.type) {
        const isElectric = ['FORKLIFT_ELECTRIC', 'FORKLIFT_WALKIE'].includes(session.vehicle.type);
        parts.push(`Vehicle type: ${session.vehicle.type}`);
        if (isElectric) parts.push('ELECTRIC: no engine_oil/transmission_oil/fuel.');
      }
      if (session.vehicle.serial) parts.push(`Serial: ${session.vehicle.serial}`);
      if (parts.length > 0) vehicleContext = parts.join('\n');
    }

    const result = await analyzeImageWithClaude(imageData, env, 25000, vehicleContext);

    // 铭牌处理
    const np = result.nameplate;
    if (np?.model) {
      if (!session.vehicle) session.vehicle = {};
      if (!session.vehicle.model)  session.vehicle.model  = np.model;
      if (!session.vehicle.serial && np.serial) {
        session.vehicle.serial       = np.serial;
        session.vehicle.serialSource = 'NAMEPLATE';
      }
      if (!session.vehicle.voltage  && np.voltage)     session.vehicle.voltage  = np.voltage;
      if (!session.vehicle.capacity && np.capacity_kg) session.vehicle.capacity = np.capacity_kg;
      if (!session.vehicle.year     && np.year)        session.vehicle.year     = np.year;
      if (!session.vehicle.type || session.vehicle.type === 'UNKNOWN')
        session.vehicle.type = np.vehicle_type ?? 'UNKNOWN';
      await updateSession(userId, session, env);
    }

    // covered_checks
    const checkId = result.check_id;
    if (checkId && !['nameplate', 'general'].includes(checkId)
        && !session.covered_checks.includes(checkId)) {
      session.covered_checks.push(checkId);
      await updateSession(userId, session, env);
    }

    // DO /result — 先存一条（msgId 待回填）
    const doId   = env.IMAGE_DEDUP.idFromName(userId);
    const doStub = env.IMAGE_DEDUP.get(doId);
    const doRes  = await doStub.fetch('http://do/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        check_id: result.check_id,
        reading:  result.reading,
        imageKey,
        msgId: null,
      }),
    });
    const { count, itemId } = await doRes.json();

    const patchMsgId = async (id) => doStub.fetch('http://do/item', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, msgId: id }),
    });

    if (np?.model) {
      // 铭牌：纯文本回复，回填 msgId 让 quote 也能找到 item
      const txt     = `已分析 ${count} 张｜📋 ${np.model}${np.serial ? ' S/N: ' + np.serial : ''}`;
      const txtResp = await replyToMessage(messageId, JSON.stringify({ text: txt }), 'text', env);
      const txtMsgId = txtResp?.data?.message_id ?? null;
      if (txtMsgId) await patchMsgId(txtMsgId);
      if (np.confirm_needed && np.confirm_prompt) {
        await replyToMessage(messageId, JSON.stringify({ text: `⚠️ ${np.confirm_prompt}` }), 'text', env);
      }
    } else {
      // 普通检查项：发交互卡片（引用原图），回填 msgId
      const label    = SECTION_LABEL[result.check_id] ?? result.check_id;
      const cardResp = await sendItemCard({
        messageId,
        chatId:  session.chatId ?? null,
        count,
        label,
        reading: result.reading ?? '',
        itemId,
        env,
      });
      const cardMsgId = cardResp?.data?.message_id ?? null;
      if (cardMsgId) await patchMsgId(cardMsgId);
    }

  } catch (e) {
    console.error('Image analysis error:', e);
    await replyToMessage(
      messageId,
      JSON.stringify({ text: `❌ 分析失败: ${e.message}` }),
      'text', env,
    ).catch(() => {});
  }
}
