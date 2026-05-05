import { VEHICLE_TYPES, getChecklistForType } from '../data/checklists.js';

const STATUS_ICON = { ok: '✓', low: '⚠ Low', leak: '⚠ Leak', dirty: '⚠ Dirty', missing: '✗ Missing', unreadable: '— Unreadable', 'n/a': '—', noted: '✓' };

export async function generateReport(session, env) {
  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const reportType = session.report_type ?? 'SERVICE';

  const v = session.vehicle ?? {};
  const vehicleLine = [v.model, v.serial ? `S/N: ${v.serial}` : null, v.hours ? `${v.hours}h` : null, v.type ? VEHICLE_TYPES[v.type] : null]
    .filter(Boolean).join(' | ') || 'Vehicle not identified';

  const typeLabel = reportType === 'PD' ? 'Pre-Delivery Inspection' : 'Service Report';

  // 按 check_id 汇总所有记录（同一项可能有多张图）
  const itemMap = {};
  for (const item of session.items) {
    const id = item.check_id || 'general';
    if (!itemMap[id]) itemMap[id] = [];
    itemMap[id].push(item);
  }

  let body = '';

  if (reportType === 'PD' && v.type && v.type !== 'UNKNOWN') {
    // PD 报告：按标准检查项模板输出表格
    const checklist = getChecklistForType(v.type);
    body += 'CHECKLIST:\n';
    for (const checkItem of checklist) {
      const records = itemMap[checkItem.id];
      if (records && records.length > 0) {
        const latest = records[records.length - 1];
        const icon = STATUS_ICON[latest.status] ?? latest.status;
        body += `${icon.padEnd(12)} ${checkItem.label}\n`;
        if (latest.reading) body += `             → ${latest.reading}\n`;
      } else {
        body += `${'—'.padEnd(12)} ${checkItem.label}\n`;
      }
    }
  } else {
    // Service 报告：按时间顺序列出所有记录
    body += 'RECORDS:\n';
    for (const item of session.items) {
      const icon = STATUS_ICON[item.status] ?? item.status ?? '•';
      const label = item.check_id ?? 'note';
      const detail = item.reading ?? item.raw ?? '';
      body += `${icon} [${label}] ${detail}\n`;
    }
  }

  // 异常汇总
  const issues = session.items.filter(i => ['low', 'leak', 'dirty', 'missing'].includes(i.status));
  if (issues.length > 0) {
    body += '\nISSUES NOTED:\n';
    for (const i of issues) {
      body += `⚠ [${i.check_id}] ${i.reading}\n`;
    }
  }

  return `📋 ${typeLabel}\n🕐 ${now}\n🔧 ${vehicleLine}\n${'─'.repeat(40)}\n${body}`;
}
