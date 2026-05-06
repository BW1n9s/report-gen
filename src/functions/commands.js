import { sendMessage, sendCard, updateItemCard } from '../services/lark.js';
import { getSession, clearSession } from '../services/session.js';
import { generateReport, generateReportAsLarkDoc } from './generateReport.js';

function normalizeReportType(raw) {
  if (!raw) return 'PDI';
  if (raw === 'PD') return 'PDI';
  return raw;
}

// 报告类型配置 — 未来可在此添加更多类型或用户自定义模板
const REPORT_TYPES = {
  PDI: {
    label: 'Delivery Inspection (PDI)',
    description: '新机交付检查 — 发送照片和文字记录检查结果，完成后生成报告',
  },
  SERVICE: {
    label: 'Service Record / 外出服务记录',
    description: '记录外出服务的操作和结果',
  },
};

export async function handleCommand({ text, userId, chatId, env }) {
  const cmd = text.trim();

  // 中文菜单文字 → 统一映射到英文指令
  const normalized = {
    '开始': 'START', '/开始': 'START',
    '检查占用': 'CHECKSTATUS', '/状态': 'CHECKSTATUS',
    '结束': 'END', '/报告': 'END',
    '/清除': 'CLEAR',
    '中断': 'ABORT', '/中断': 'ABORT',
    'PDI':     'PDI',
    'PD':      'PDI',
    'SERVICE': 'SERVICE',
  }[cmd] ?? cmd.toUpperCase();

  switch (normalized) {
    case 'START':
      await cmdStart({ userId, chatId, env });
      break;
    case 'PDI':
      await cmdSetType({ userId, chatId, type: 'PDI', env });
      break;
    case 'SERVICE':
      await cmdSetType({ userId, chatId, type: 'SERVICE', env });
      break;
    case 'CHECKSTATUS':
      await cmdStatus({ userId, chatId, env });
      break;
    case 'END':
      await cmdEnd({ userId, chatId, env });
      break;
    case 'ABORT':
      await cmdAbort({ userId, chatId, env });
      break;
    case 'CONFIRM_ABORT':
      await clearSession(userId, env);
      await sendMessage(chatId, '🗑️ Session aborted. All records discarded.', env);
      break;
    case 'CLEAR':
      await clearSession(userId, env);
      await sendMessage(chatId, '✅ 当前记录已清除。', env);
      break;
    default:
      await sendMessage(chatId, '❓ 请发送图片或文字开始巡检，或点击菜单选择操作。', env);
  }
}

// 发送类型选择卡片
async function cmdStart({ userId, chatId, env }) {
  const session = await getSession(userId, env);
  if (session.items.length > 0) {
    await sendMessage(
      chatId,
      `⚠️ 你有一个进行中的 ${REPORT_TYPES[normalizeReportType(session.report_type)]?.label ?? session.report_type} 记录（共 ${session.items.length} 条）。\n发送 END 完成报告，或 /清除 放弃当前记录。`,
      env,
    );
    return;
  }

  await sendCard(chatId, {
    header: { title: '📋 新建巡检记录', style: 'blue' },
    body: '请选择本次检查类型：',
    buttons: [
      { label: 'Delivery Inspection (PDI)', action: 'PDI', type: 'primary' },
      { label: 'Service Record', action: 'SERVICE', type: 'default' },
    ],
  }, env);
}

// 设置报告类型并正式开始
async function cmdSetType({ userId, chatId, type, env }) {
  const session = await getSession(userId, env);
  session.report_type = type;
  const { updateSession } = await import('../services/session.js');
  await updateSession(userId, session, env);

  const typeInfo = REPORT_TYPES[type];
  await sendCard(chatId, {
    header: { title: `✅ 已开始：${typeInfo.label}`, style: 'green' },
    body: `${typeInfo.description}\n\n现在可以发送图片或文字记录，完成后发送 END 生成报告。`,
    buttons: [
      { label: '检查占用', action: 'CHECKSTATUS', type: 'default' },
      { label: '结束', action: 'END', type: 'danger' },
    ],
  }, env);
}

// 检查当前是否有进行中的 report
async function cmdStatus({ userId, chatId, env }) {
  const session = await getSession(userId, env);

  if (session.items.length === 0 && !session.report_type) {
    await sendCard(chatId, {
      header: { title: '📭 No active record', style: 'grey' },
      body: 'Start a new inspection below.',
      buttons: [
        { label: 'Delivery Inspection (PDI)', action: 'PDI', type: 'primary' },
        { label: 'Service Record', action: 'SERVICE', type: 'default' },
      ],
    }, env);
    return;
  }

  const images = session.items.filter((i) => i.type === 'image').length;
  const texts = session.items.filter((i) => i.type === 'text').length;
  const since = new Date(session.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

  const typeLabel = REPORT_TYPES[normalizeReportType(session.report_type)]?.label ?? session.report_type;
  const vehicleLabel = session.vehicle?.model
    ? `${session.vehicle.model}${session.vehicle.serial ? ' · ' + session.vehicle.serial : ''}`
    : '⚠️ Vehicle not yet identified — send a nameplate photo';

  // PD 时显示检查项覆盖进度
  let progressText = '';
  if (normalizeReportType(session.report_type) === 'PDI' && session.vehicle?.type && session.vehicle.type !== 'UNKNOWN') {
    const { getChecklistForType } = await import('../data/checklists.js');
    const checklist = getChecklistForType(session.vehicle.type);
    const coveredCount = checklist.filter((i) => session.covered_checks.includes(i.id)).length;
    progressText = `\nChecklist coverage: ${coveredCount}/${checklist.length} items`;
  }

  await sendCard(chatId, {
    header: { title: `📋 Active: ${typeLabel}`, style: 'yellow' },
    body: `🔧 ${vehicleLabel}\n📷 ${images} photos　📝 ${texts} notes\nStarted: ${since}${progressText}\n\nContinue sending photos/notes, or tap End to generate report.`,
    buttons: [
      { label: 'Check Status', action: 'CHECKSTATUS', type: 'default' },
      { label: 'End', action: 'END', type: 'danger' },
    ],
  }, env);
}

// 中断当前 session，发送确认卡片防止误操作
async function cmdAbort({ userId, chatId, env }) {
  const session = await getSession(userId, env);

  if (session.items.length === 0 && !session.report_type) {
    await sendMessage(chatId, '📭 No active record to abort.', env);
    return;
  }

  await sendCard(chatId, {
    header: { title: '⚠️ Confirm Abort', style: 'red' },
    body: `You have ${session.items.length} record(s) in progress. Abort will discard all records without generating a report.\n\nTap **Confirm Abort** to discard, or ignore this message to continue.`,
    buttons: [
      { label: 'Confirm Abort', action: 'CONFIRM_ABORT', type: 'danger' },
      { label: 'Continue', action: 'CHECKSTATUS', type: 'primary' },
    ],
  }, env);
}

// 生成报告并结束 session
async function cmdEnd({ userId, chatId, env }) {
  const session = await getSession(userId, env);

  if (session.items.length === 0) {
    await sendMessage(chatId, '📭 暂无记录，请先发送图片或文字。', env);
    return;
  }

  const reportType = normalizeReportType(session.report_type);
  const typeLabel  = REPORT_TYPES[reportType]?.label ?? reportType;

  await sendMessage(chatId, `📝 正在生成 ${typeLabel} 报告（共 ${session.items.length} 条记录）…`, env);

  try {
    const report = await generateReport(session, env);
    await sendMessage(chatId, report, env);

    try {
      const docResult = await generateReportAsLarkDoc(session, env);
      if (docResult) {
        await sendCard(chatId, {
          header: { title: '📄 Lark 文档已生成', style: 'green' },
          body: `**${docResult.title}**\n\n点击下方链接查看和编辑完整交付检查报告。`,
          buttons: [{ label: '打开文档', action: docResult.url, type: 'primary' }],
        }, env);
      }
    } catch (docErr) {
      console.error('[cmdEnd] Lark doc generation failed:', docErr);
    }

    await clearSession(userId, env);
  } catch (e) {
    console.error('Generate report error:', e);
    await sendMessage(chatId, `❌ 报告生成失败：${e.message}`, env);
  }
}

// ─── Item Card Actions ────────────────────────────────────────────────────────

const ITEM_SECTION_LABEL = {
  attachment_accessories:'附件配件', visual_structure:'外观结构',
  fluid_levels:'油液液位', engine_mechanical:'发动机机械',
  electrical_system:'电气系统', hydraulic_system:'液压系统',
  mast_fork_chain:'门架链条', loader_arm_axle:'大臂车桥',
  steering_brake_dynamic:'转向刹车', tyre_wheel:'轮胎车轮',
  safety_functions:'安全功能', maintenance_work:'保养工作',
  final_result:'最终结果', general:'其他',
};

export async function handleItemCardAction({ action, itemId, formValues, userId, chatId, env }) {
  if (!itemId) return;

  const doId   = env.IMAGE_DEDUP.idFromName(userId);
  const doStub = env.IMAGE_DEDUP.get(doId);

  const itemsRes    = await doStub.fetch('http://do/get-items');
  const { items }   = await itemsRes.json();
  const item        = items?.find(i => i.itemId === itemId);
  if (!item) return;

  const label = ITEM_SECTION_LABEL[item.check_id] ?? item.check_id;
  const count = items.length;

  const patch = async (fields) => doStub.fetch('http://do/item', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, ...fields }),
  });

  const updateCard = async (overrides = {}) => {
    if (!item.cardMsgId) return;
    await updateItemCard({
      cardMsgId: item.cardMsgId, count, label,
      reading: item.reading, itemId,
      status: item.status, note: item.note,
      ...overrides, env,
    });
  };

  if (action === 'IMG_OK') {
    await patch({ status: 'ok' });
    item.status = 'ok';
    await updateCard();
  }

  if (action === 'IMG_NG') {
    await updateCard({ showInput: 'ng' });
  }

  if (action === 'IMG_CORRECT') {
    await updateCard({ showInput: 'correction' });
  }

  if (action === 'IMG_NG_SUBMIT') {
    const note = formValues.ng_note ?? '';
    await patch({ status: 'ng', note });
    item.status = 'ng';
    item.note   = note;
    await updateCard();
  }

  if (action === 'IMG_CORRECT_SUBMIT') {
    const { analyzeCorrection } = await import('../services/claude.js');
    const corrNote  = formValues.correction_note ?? '';
    const corrResult = await analyzeCorrection(corrNote, item.reading, env);
    const newReading = corrResult.reading ?? item.reading;
    const newNote    = corrResult.note ?? corrNote;
    const newStatus  = corrResult.action === 'ng' ? 'ng' : 'corrected';
    await patch({ status: newStatus, reading: newReading, note: newNote });
    item.reading = newReading;
    item.note    = newNote;
    item.status  = newStatus;
    await updateCard();
  }

  if (action === 'IMG_CANCEL') {
    await updateCard(); // redraw without showInput
  }
}
