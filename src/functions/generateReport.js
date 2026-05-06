import { getTemplate } from '../templates/index.js';
import {
  getWikiNodeObjToken,
  copyDocumentToRoot,
  appendReportBlocks,
  getDocumentUrl,
} from '../services/lark.js';

const STATUS_ICON = {
  ok:          '✓',
  low:         '⚠ Low',
  leak:        '⚠ Leak',
  dirty:       '⚠ Dirty',
  missing:     '✗ Missing',
  unreadable:  '—',
  'n/a':       'N/A',
  noted:       '✓',
};

// 兼容旧 session（report_type 可能是 'PD'）
function normalizeReportType(raw) {
  if (!raw) return 'PDI';
  if (raw === 'PD') return 'PDI';
  return raw;
}

// session.items → { check_id: [items] }
function buildItemMap(items) {
  const map = {};
  for (const item of items) {
    const id = item.check_id || 'general';
    if (!map[id]) map[id] = [];
    map[id].push(item);
  }
  return map;
}

// 生成纯文本报告
export async function generateReport(session, env) {
  const now         = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const reportType  = normalizeReportType(session.report_type);
  const v           = session.vehicle ?? {};
  const vehicleType = v.type ?? 'UNKNOWN';

  const vehicleLine = [
    v.model,
    v.serial ? `S/N: ${v.serial}` : null,
    v.hours  ? `${v.hours}h`       : null,
  ].filter(Boolean).join(' | ') || 'Vehicle not identified';

  const template = getTemplate(reportType, vehicleType);

  // items 从 DO 读取（单线程写入，无并发丢失）；fallback 到 session.items
  let items = session.items ?? [];
  if (env.IMAGE_DEDUP && session.user_id) {
    try {
      const id   = env.IMAGE_DEDUP.idFromName(session.user_id);
      const stub = env.IMAGE_DEDUP.get(id);
      const res  = await stub.fetch('http://do/get-items');
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
      }
    } catch (e) {
      console.warn('[generateReport] DO read failed, using session.items:', e.message);
    }
  }

  const itemMap  = buildItemMap(items);
  const issues   = [];
  const SKIP_IDS = new Set(['nameplate', 'general']);

  let body = '';

  for (const section of template.sections) {
    if (section.id === 'basic_info') continue;

    if (Array.isArray(section.na_for) && section.na_for.includes(vehicleType)) {
      body += `N/A          ${section.label}\n`;
      continue;
    }

    const records = itemMap[section.id] ?? [];
    const latest  = records[records.length - 1];

    if (latest) {
      const icon = STATUS_ICON[latest.status] ?? latest.status ?? '•';
      body += `${icon.padEnd(12)} ${section.label}\n`;
      if (latest.reading) body += `             → ${latest.reading}\n`;
      for (const extra of records.slice(0, -1)) {
        if (extra.reading) body += `             → ${extra.reading}\n`;
      }
      if (['low', 'leak', 'dirty', 'missing'].includes(latest.status)) {
        issues.push(`[${section.id}] ${latest.reading}`);
      }
    } else {
      body += `${'—'.padEnd(12)} ${section.label}\n`;
    }
  }

  const templateIds = new Set(template.sections.map(s => s.id));
  const extras = items.filter(
    i => !SKIP_IDS.has(i.check_id ?? 'general') && !templateIds.has(i.check_id ?? 'general'),
  );
  if (extras.length > 0) {
    body += '\nADDITIONAL WORK / NOTES:\n';
    for (const i of extras) {
      body += `• [${i.check_id}] ${i.reading ?? i.raw ?? ''}\n`;
    }
  }

  if (issues.length > 0) {
    body += '\nISSUES NOTED:\n';
    for (const issue of issues) body += `⚠ ${issue}\n`;
  }

  return `📋 ${template.title}\n🕐 ${now}\n🔧 ${vehicleLine}\n${'─'.repeat(44)}\n\n${body}`;
}

// Lark 文档生成（PDI 专用，复制 Wiki 模板 → 写入报告内容）
export async function generateReportAsLarkDoc(session, env) {
  const reportType  = normalizeReportType(session.report_type);
  const v           = session.vehicle ?? {};
  const vehicleType = v.type ?? 'UNKNOWN';

  if (reportType !== 'PDI') return null;

  const wikiToken = vehicleType === 'WHEEL_LOADER'
    ? env.LOADER_PDI_WIKI_TOKEN
    : env.FORKLIFT_PDI_WIKI_TOKEN;

  if (!wikiToken) return null;

  const now   = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const title = [
    v.model ?? 'Unknown',
    v.serial ?? '',
    `PDI ${now.split(',')[0]}`,
  ].filter(Boolean).join(' — ');

  // wiki token → docx obj_token → 复制文档 → 写入报告
  const objToken   = await getWikiNodeObjToken(wikiToken, env);
  const newFile    = await copyDocumentToRoot(objToken, title, env);
  const reportText = await generateReport(session, env);
  await appendReportBlocks(newFile.token, reportText, env);

  return { url: getDocumentUrl(newFile.token), title };
}
