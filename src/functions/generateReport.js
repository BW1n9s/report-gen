import { generateReportWithClaude } from '../services/claude.js';
import { VEHICLE_TYPES, getChecklistForType } from '../data/checklists.js';

export async function generateReport(session, env) {
  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const reportType = session.report_type ?? 'SERVICE';

  const vehicleInfo = [
    session.vehicle.model ?? 'Unknown Model',
    session.vehicle.serial ? `S/N: ${session.vehicle.serial}` : null,
    session.vehicle.hours ? `${session.vehicle.hours}h` : null,
    session.vehicle.type ? VEHICLE_TYPES[session.vehicle.type] : null,
  ].filter(Boolean).join(' | ');

  // 整理所有记录
  const summaries = session.items
    .map((item, i) => {
      if (item.type === 'image') {
        return `[Photo ${i + 1}${item.covered_checks?.length ? ' — ' + item.covered_checks.join(', ') : ''}]\n${item.analysis}`;
      } else {
        return `[Note ${i + 1}]\nOriginal: ${item.original}\nStructured: ${item.analysis}`;
      }
    })
    .join('\n\n');

  // PD 报告追加检查项覆盖摘要
  let checklistSummary = '';
  if (reportType === 'PD' && session.vehicle.type) {
    const checklist = getChecklistForType(session.vehicle.type);
    const lines = checklist.map((item) => {
      const covered = session.covered_checks.includes(item.id);
      return `${covered ? '✓' : '—'} ${item.label}`;
    });
    checklistSummary = `\n\nCHECKLIST COVERAGE (✓ = photo/note recorded, — = not recorded):\n${lines.join('\n')}`;
  }

  const report = await generateReportWithClaude(
    summaries + checklistSummary,
    now,
    reportType,
    vehicleInfo,
    env,
  );

  const typeLabel = reportType === 'PD' ? 'Pre-Delivery Inspection Report' : 'Service Report';
  return `📋 ${typeLabel}\n🕐 ${now}\n${'─'.repeat(32)}\n\n${report}`;
}
