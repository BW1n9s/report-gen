import { getTemplate } from '../templates/index.js';
import {
  copyDocumentToRoot,
  getDocumentUrl,
} from '../services/lark.js';

const STATUS_ICON = {
  pending:   '✓',
  ok:        '✓',
  ng:        '✗ NG',
  corrected: '✓✏',
  'n/a':     'N/A',
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

/**
 * Determine the effective serial/VIN to use in the report.
 * Priority: manual user input > picking list > nameplate OCR
 */
export function getEffectiveSerial(session) {
  const v  = session.vehicle ?? {};
  const pl = session.pickingList ?? {};

  if (v.serialSource === 'MANUAL' && v.serial)  return v.serial;
  if (pl.vin)                                    return pl.vin;
  if (v.serial)                                  return v.serial;
  return '';
}

// 生成纯文本报告
export async function generateReport(session, env) {
  const now         = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const reportType  = normalizeReportType(session.report_type);
  const v           = session.vehicle ?? {};
  const pl          = session.pickingList ?? {};
  const vehicleType = v.type ?? 'UNKNOWN';

  const effectiveSerial = getEffectiveSerial(session);

  const vehicleLine = [
    v.model,
    effectiveSerial ? `S/N: ${effectiveSerial}` : null,
    v.hours ? `${v.hours}h` : null,
  ].filter(Boolean).join(' | ') || 'Vehicle not identified';

  // Picking list header info
  const plLines = [];
  if (pl.customer)       plLines.push(`Customer:  ${pl.customer}`);
  if (pl.invoiceNumber)  plLines.push(`Invoice:   ${pl.invoiceNumber}`);
  if (pl.invoiceDate)    plLines.push(`Inv. Date: ${pl.invoiceDate}`);
  if (pl.contact)        plLines.push(`Contact:   ${pl.contact}`);

  // VIN cross-check note
  const vinNote = (pl.vin && v.serial && v.serialSource !== 'PICKING_LIST')
    ? (pl.vin.replace(/[\s\-]/g, '').toUpperCase() === v.serial.replace(/[\s\-]/g, '').toUpperCase()
        ? `✅ VIN confirmed: ${pl.vin}`
        : `⚠️  VIN MISMATCH — PL: ${pl.vin}  /  Nameplate: ${v.serial}`)
    : null;

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
  const SKIP_IDS = new Set(['nameplate', 'picking_list', 'general']);

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
      if (latest.status === 'ng') {
        issues.push(`[${section.id}] ${latest.reading}${latest.note ? ' — ' + latest.note : ''}`);
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

  const plHeader = plLines.length > 0
    ? plLines.join('\n') + '\n'
    : '';
  const vinLine = vinNote ? `${vinNote}\n` : '';

  return `📋 ${template.title}\n🕐 ${now}\n🔧 ${vehicleLine}\n${plHeader}${vinLine}${'─'.repeat(44)}\n\n${body}`;
}

// Lark 文档生成（PDI 专用，复制模板 → 写入报告内容）
export async function generateReportAsLarkDoc(session, env) {
  const reportType  = normalizeReportType(session.report_type);
  const v           = session.vehicle ?? {};
  const vehicleType = v.type ?? 'UNKNOWN';

  if (reportType !== 'PDI') return null;

  const docToken = vehicleType === 'WHEEL_LOADER'
    ? env.LOADER_PDI_DOC_TOKEN
    : env.FORKLIFT_PDI_DOC_TOKEN;

  if (!docToken) return null;

  const now   = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const effectiveSerial = getEffectiveSerial(session);

  const title = [
    v.model ?? 'Unknown',
    effectiveSerial ?? '',
    `PDI ${now.split(',')[0]}`,
  ].filter(Boolean).join(' — ');

  console.log('[doc] step 1: copying document, docToken=', docToken);
  const newFile = await copyDocumentToRoot(docToken, title, env);
  console.log('[doc] step 2: copy done, newFile=', JSON.stringify(newFile));

  let doItems = [];
  if (env.IMAGE_DEDUP && session.user_id) {
    try {
      const id   = env.IMAGE_DEDUP.idFromName(session.user_id);
      const stub = env.IMAGE_DEDUP.get(id);
      const res  = await stub.fetch('http://do/get-items');
      const data = await res.json();
      if (Array.isArray(data.items)) doItems = data.items;
      console.log('[doc] step 3: DO items count=', doItems.length);
    } catch (e) {
      console.warn('[doc] DO read failed:', e.message);
    }
  }

  console.log('[doc] calling fillReportIntoDoc with documentId:', newFile.token);
  const { fillReportIntoDoc } = await import('../services/lark.js');
  await fillReportIntoDoc(newFile.token, doItems, session, env);
  console.log('[doc] step 5: fill done');

  return { url: getDocumentUrl(newFile.token), title };
}
