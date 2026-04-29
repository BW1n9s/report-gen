import { sendMessage, sendCard } from '../services/lark.js';
import { getSession, clearSession } from '../services/session.js';
import { generateReport } from './generateReport.js';

// 报告类型配置 — 未来可在此添加更多类型或用户自定义模板
const REPORT_TYPES = {
  PD: {
    label: '发车前检查 (PD)',
    description: '检查车辆出发前的各项状态',
  },
  SERVICE: {
    label: '外出保养 (Service)',
    description: '记录外出保养的操作和结果',
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
    'PD': 'PD',
    'SERVICE': 'SERVICE',
  }[cmd] ?? cmd.toUpperCase();

  switch (normalized) {
    case 'START':
      await cmdStart({ userId, chatId, env });
      break;
    case 'PD':
      await cmdSetType({ userId, chatId, type: 'PD', env });
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
      `⚠️ 你有一个进行中的 ${REPORT_TYPES[session.report_type]?.label ?? session.report_type} 记录（共 ${session.items.length} 条）。\n发送 END 完成报告，或 /清除 放弃当前记录。`,
      env,
    );
    return;
  }

  await sendCard(chatId, {
    header: { title: '📋 新建巡检记录', style: 'blue' },
    body: '请选择本次检查类型：',
    buttons: [
      { label: '发车前检查 (PD)', action: 'PD', type: 'primary' },
      { label: '外出保养 (Service)', action: 'SERVICE', type: 'default' },
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
      header: { title: '📭 当前没有进行中的记录', style: 'grey' },
      body: '点击下方按钮开始新的巡检。',
      buttons: [
        { label: '发车前检查 (PD)', action: 'PD', type: 'primary' },
        { label: '外出保养 (Service)', action: 'SERVICE', type: 'default' },
      ],
    }, env);
    return;
  }

  const images = session.items.filter((i) => i.type === 'image').length;
  const texts = session.items.filter((i) => i.type === 'text').length;
  const since = new Date(session.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const typeLabel = REPORT_TYPES[session.report_type]?.label ?? session.report_type ?? '未分类';

  await sendCard(chatId, {
    header: { title: `📋 进行中：${typeLabel}`, style: 'yellow' },
    body: `图片：${images} 张　文字：${texts} 条\n开始时间：${since}\n\n继续发送内容，或点击结束生成报告。`,
    buttons: [
      { label: '检查占用', action: 'CHECKSTATUS', type: 'default' },
      { label: '结束', action: 'END', type: 'danger' },
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

  const typeLabel = REPORT_TYPES[session.report_type]?.label ?? session.report_type ?? '巡检';
  await sendMessage(chatId, `📝 正在生成 ${typeLabel} 报告（共 ${session.items.length} 条记录）…`, env);

  try {
    const report = await generateReport(session, env);
    await sendMessage(chatId, report, env);
    await clearSession(userId, env);
  } catch (e) {
    console.error('Generate report error:', e);
    await sendMessage(chatId, `❌ 报告生成失败：${e.message}`, env);
  }
}
