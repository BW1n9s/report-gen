import { getToken, downloadImage, replyToMessage, sendItemCard } from '../services/lark.js';
import { analyzeImageWithClaude } from '../services/claude.js';
import { getSession, updateSession } from '../services/session.js';

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
  picking_list:            '提货单',
  general:                 '其他',
};

// ─── VIN cross-check ──────────────────────────────────────────────────────────

function crossCheckVin(plVin, npSerial) {
  if (!plVin || !npSerial) return [];
  const norm = (s) => s.replace(/[\s\-]/g, '').toUpperCase();
  if (norm(plVin) === norm(npSerial)) {
    return [`✅ VIN confirmed: ${plVin} matches picking list`];
  }
  return [
    `⚠️ VIN MISMATCH — please verify:`,
    `  Picking List: ${plVin}`,
    `  Nameplate:    ${npSerial}`,
  ];
}

function buildPickingListSummary(pl, crossCheckLines = []) {
  const lines = ['📋 Picking list detected:'];
  if (pl.customer)        lines.push(`  Customer:  ${pl.customer}`);
  if (pl.invoice_number)  lines.push(`  Invoice:   ${pl.invoice_number}`);
  if (pl.invoice_date)    lines.push(`  Date:      ${pl.invoice_date}`);
  if (pl.djj_code)        lines.push(`  DJJ Code:  ${pl.djj_code}`);
  if (pl.model)           lines.push(`  Model:     ${pl.model}`);
  if (pl.vin)             lines.push(`  VIN:       ${pl.vin}`);
  if (pl.contact)         lines.push(`  Contact:   ${pl.contact}`);
  if (pl.attachments && pl.attachments.length > 0) {
    lines.push(`  Attachments:`);
    for (const a of pl.attachments) {
      lines.push(`    • ${a.name}${a.djj_code ? ' (' + a.djj_code + ')' : ''}`);
    }
  }
  if (crossCheckLines.length > 0) {
    lines.push('');
    lines.push(...crossCheckLines);
  }
  return lines.join('\n');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeImage(imageKey, messageId, session, userId, env) {
  try {
    // Re-read latest session to avoid stale data from concurrent requests
    session = (await getSession(userId, env)) ?? session;

    const token     = await getToken(env);
    const imageData = await downloadImage(messageId, imageKey, token, env);

    // Vehicle context for Claude
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

    // Stagger concurrent requests to avoid Claude rate limits
    await new Promise(r => setTimeout(r, Math.random() * 1500));

    const result = await analyzeImageWithClaude(imageData, env, 25000, vehicleContext);

    // ── Picking list handling ────────────────────────────────────────────────
    if (result.check_id === 'picking_list' && result.picking_list) {
      const pl = result.picking_list;

      // Merge into session.pickingList (first detection wins for each field)
      if (!session.pickingList) session.pickingList = {};
      const plStore = session.pickingList;
      if (pl.customer       && !plStore.customer)       plStore.customer       = pl.customer;
      if (pl.invoice_number && !plStore.invoiceNumber)  plStore.invoiceNumber  = pl.invoice_number;
      if (pl.vin            && !plStore.vin)            plStore.vin            = pl.vin;
      if (pl.model          && !plStore.model)          plStore.model          = pl.model;
      if (pl.invoice_date   && !plStore.invoiceDate)    plStore.invoiceDate    = pl.invoice_date;
      if (pl.contact        && !plStore.contact)        plStore.contact        = pl.contact;
      if (pl.djj_code       && !plStore.djjCode)        plStore.djjCode        = pl.djj_code;

      // Always merge attachments (add new ones, skip duplicates by djj_code or name)
      if (Array.isArray(pl.attachments) && pl.attachments.length > 0) {
        if (!plStore.attachments) plStore.attachments = [];
        for (const att of pl.attachments) {
          const isDupe = plStore.attachments.some(
            a => (att.djj_code && a.djj_code === att.djj_code) ||
                 (att.name     && a.name?.toLowerCase() === att.name?.toLowerCase())
          );
          if (!isDupe) plStore.attachments.push(att);
        }
      }

      // If picking list has a VIN and no manual serial exists, promote it
      if (pl.vin && session.vehicle && !session.vehicle.serial) {
        session.vehicle.serial       = pl.vin;
        session.vehicle.serialSource = 'PICKING_LIST';
      }

      await updateSession(userId, session, env);

      // Cross-check against any nameplate already in session
      const crossCheckLines = session.vehicle?.serial && session.vehicle.serialSource !== 'PICKING_LIST'
        ? crossCheckVin(pl.vin, session.vehicle.serial)
        : [];

      const summaryText = buildPickingListSummary(pl, crossCheckLines);

      // Store item in DO then send confirmation
      const doId   = env.IMAGE_DEDUP.idFromName(userId);
      const doStub = env.IMAGE_DEDUP.get(doId);
      const doRes  = await doStub.fetch('http://do/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          check_id:      'picking_list',
          reading:       `${pl.customer ?? ''} ${pl.vin ?? ''}`.trim() || 'picking list',
          imageKey,
          msgId:         null,
          originalMsgId: messageId,
        }),
      });
      const { itemId } = await doRes.json();

      const txtResp = await replyToMessage(
        messageId,
        JSON.stringify({ text: summaryText }),
        'text',
        env,
      );
      const txtMsgId = txtResp?.data?.message_id ?? null;
      if (txtMsgId) {
        await doStub.fetch('http://do/item', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, msgId: txtMsgId }),
        });
      }
      return;
    }

    // ── Nameplate handling ───────────────────────────────────────────────────
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
    if (checkId && !['nameplate', 'picking_list', 'general'].includes(checkId)
        && !session.covered_checks.includes(checkId)) {
      session.covered_checks.push(checkId);
      await updateSession(userId, session, env);
    }

    // Store item in DO
    const doId   = env.IMAGE_DEDUP.idFromName(userId);
    const doStub = env.IMAGE_DEDUP.get(doId);
    const doRes  = await doStub.fetch('http://do/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        check_id:      result.check_id,
        reading:       result.reading,
        imageKey,
        msgId:         null,
        originalMsgId: messageId,
      }),
    });
    const { count, itemId } = await doRes.json();

    const patchMsgId = async (id) => doStub.fetch('http://do/item', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, msgId: id }),
    });

    if (np?.model) {
      // Nameplate reply — include picking list cross-check if available
      const crossCheckLines = session.pickingList?.vin
        ? crossCheckVin(session.pickingList.vin, np.serial ?? session.vehicle?.serial ?? '')
        : [];
      const crossCheckSuffix = crossCheckLines.length > 0
        ? '\n' + crossCheckLines.join('\n')
        : '';

      const txt     = `已分析 ${count} 张｜📋 ${np.model}${np.serial ? ' S/N: ' + np.serial : ''}${crossCheckSuffix}`;
      const txtResp = await replyToMessage(messageId, JSON.stringify({ text: txt }), 'text', env);
      const txtMsgId = txtResp?.data?.message_id ?? null;
      if (txtMsgId) await patchMsgId(txtMsgId);
      if (np.confirm_needed && np.confirm_prompt) {
        await replyToMessage(messageId, JSON.stringify({ text: `⚠️ ${np.confirm_prompt}` }), 'text', env);
      }
    } else {
      // Regular check item — send interactive card
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
