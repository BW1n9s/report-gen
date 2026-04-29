import { generateReportWithClaude } from '../services/claude.js';

export async function generateReport(session, env) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 整理所有记录
  const summaries = session.items
    .map((item, i) => {
      if (item.type === 'image') {
        return `[图片记录 ${i + 1}]\n${item.analysis}`;
      } else {
        return `[文字记录 ${i + 1}]\n原文：${item.original}\n解析：${item.analysis}`;
      }
    })
    .join('\n\n');

  const report = await generateReportWithClaude(summaries, now, env);

  return `📋 巡检报告\n🕐 ${now}\n${'─'.repeat(24)}\n\n${report}`;
}
