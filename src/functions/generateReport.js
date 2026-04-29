import { generateReportWithClaude } from '../services/claude.js';

const TYPE_LABELS = {
  PD: '发车前检查 (PD)',
  SERVICE: '外出保养 (Service)',
};

export async function generateReport(session, env) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const typeLabel = TYPE_LABELS[session.report_type] ?? '巡检记录';

  const summaries = session.items
    .map((item, i) => {
      if (item.type === 'image') {
        return `[图片记录 ${i + 1}]\n${item.analysis}`;
      } else {
        return `[文字记录 ${i + 1}]\n原文：${item.original}\n解析：${item.analysis}`;
      }
    })
    .join('\n\n');

  const report = await generateReportWithClaude(summaries, now, typeLabel, env);
  return `📋 ${typeLabel} 报告\n🕐 ${now}\n${'─'.repeat(24)}\n\n${report}`;
}
