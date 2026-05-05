import { VEHICLE_TYPES } from '../data/checklists.js';
import { getTemplate } from '../templates/index.js';

export async function generateReport(session, env) {
  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const reportType = session.report_type ?? 'SERVICE';
  const v = session.vehicle ?? {};

  const vehicleLine = [
    v.model,
    v.serial ? `S/N: ${v.serial}` : null,
    v.hours ? `${v.hours}h` : null,
    v.type ? VEHICLE_TYPES[v.type] : null,
  ].filter(Boolean).join(' | ') || 'Vehicle not identified';

  const template = await getTemplate(reportType, v.type ?? 'UNKNOWN');

  const STATUS_ICON = {
    ok: '✓', low: '⚠ Low', leak: '⚠ Leak', dirty: '⚠ Dirty',
    missing: '✗ Missing', unreadable: '—', 'n/a': 'N/A', noted: '✓',
  };

  // 按 check_id 汇总记录
  const itemMap = {};
  for (const item of session.items) {
    const id = item.check_id || 'general';
    if (!itemMap[id]) itemMap[id] = [];
    itemMap[id].push(item);
  }

  let body = '';

  for (const section of template.sections) {
    const isNA = section.na_for && section.na_for.includes(v.type);
    const records = itemMap[section.id];

    if (isNA) {
      body += `N/A          ${section.label}\n`;
    } else if (records && records.length > 0) {
      const latest = records[records.length - 1];
      const icon = STATUS_ICON[latest.status] ?? latest.status ?? '•';
      body += `${icon.padEnd(12)} ${section.label}\n`;
      if (latest.reading) body += `             → ${latest.reading}\n`;
      // 额外记录（同一项多次）
      if (records.length > 1) {
        for (const extra of records.slice(0, -1)) {
          if (extra.reading) body += `             → ${extra.reading}\n`;
        }
      }
    } else {
      body += `${'—'.padEnd(12)} ${section.label}\n`;
    }
  }

  // 模板之外的额外记录（operator 做了模板没有的工作）
  const templateIds = new Set(template.sections.map(s => s.id));
  const extras = session.items.filter(i => !templateIds.has(i.check_id ?? 'general') || i.check_id === 'general');
  if (extras.length > 0) {
    body += '\nADDITIONAL WORK / NOTES:\n';
    for (const i of extras) {
      const icon = STATUS_ICON[i.status] ?? '•';
      body += `${icon} [${i.check_id ?? 'note'}] ${i.reading ?? i.raw ?? ''}\n`;
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

  return `📋 ${template.title}\n🕐 ${now}\n🔧 ${vehicleLine}\n${'─'.repeat(40)}\n${body}`;
}
