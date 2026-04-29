import { sendMessage } from '../services/lark.js';
import { getSession, clearSession } from '../services/session.js';
import { generateReport } from './generateReport.js';

export async function handleCommand({ text, userId, chatId, env }) {
  const cmd = text.split(' ')[0].toLowerCase();

  switch (cmd) {
    case '/报告':
      await cmdReport({ userId, chatId, env });
      break;
    case '/状态':
      await cmdStatus({ userId, chatId, env });
      break;
    case '/清除':
      await clearSession(userId, env);
      await sendMessage(chatId, '✅ 当前记录已清除，可以开始新一轮巡检。', env);
      break;
    default:
      await sendMessage(
        chatId,
        '❓ 可用指令：\n/报告 — 生成本次巡检报告\n/状态 — 查看当前记录条数\n/清除 — 清除当前记录',
        env,
      );
  }
}

async function cmdReport({ userId, chatId, env }) {
  const session = await getSession(userId, env);

  if (session.items.length === 0) {
    await sendMessage(chatId, '📭 暂无记录，请先发送图片或文字。', env);
    return;
  }

  await sendMessage(chatId, `📝 正在生成报告（共 ${session.items.length} 条记录）…`, env);

  try {
    const report = await generateReport(session, env);
    await sendMessage(chatId, report, env);
    await clearSession(userId, env);
  } catch (e) {
    console.error('Generate report error:', e);
    await sendMessage(chatId, `❌ 报告生成失败：${e.message}`, env);
  }
}

async function cmdStatus({ userId, chatId, env }) {
  const session = await getSession(userId, env);

  if (session.items.length === 0) {
    await sendMessage(chatId, '📭 当前没有待整理的记录。', env);
    return;
  }

  const images = session.items.filter((i) => i.type === 'image').length;
  const texts = session.items.filter((i) => i.type === 'text').length;
  const since = new Date(session.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  await sendMessage(
    chatId,
    `📋 当前记录：图片 ${images} 张，文字 ${texts} 条\n开始时间：${since}\n\n发送 /报告 生成巡检报告`,
    env,
  );
}
