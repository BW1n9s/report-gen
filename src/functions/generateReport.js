import { getTemplate } from '../templates/index.js';
import {
  copyDocumentToRoot,
  getDocumentUrl,
  getWikiNodeObjToken,
} from '../services/lark.js';

const STATUS_ICON = {
  pending:   '✓',
  ok:        '✓',
  ng:        '✗ NG',
  corrected: '✓✏',
  'n/a':     'N/A',
};

function normalizeReportType(raw) {
  if (!raw) return 'PDI';
  if (raw === 'PD') return 'PDI';
  return raw;
}

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
 * Determine the effective serial/VIN for the report.
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

/**
 * Extract a short display model code from the picking list model string.
 *
 * Rules (matching user examples):
 *   Forklift — "CPD35-XAJ4-I"  → "CPD35"   (part BEFORE the first "-")
 *   Loader   — "LM938"          → "LM938"   (already short, use as-is)
 *   Loader   — "LGMA Wheel Loader-LM938" → "LM938"  (part AFTER the last "-")
 *
 * Strategy: if first segment looks like a model code (≤8 chars, starts with
 * letters + digits), use it — this covers forklifts.
 * Otherwise use last segment — this covers loader descriptions.
 */
function getShortModel(plModel, vehicleModel, vehicleType) {
  const raw = (plModel || vehicleModel || '').trim();
  if (!raw) return null;

  const parts = raw.split('-').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];  // already short, e.g. "LM938"

  const first = parts[0];
  const last  = parts[parts.length - 1];

  // Loader: if first part looks like a brand/description word rather than a code
  if (vehicleType === 'WHEEL_LOADER' || /\s/.test(first) || first.length > 8) {
    return last;
  }

  // Forklift / generic: use first segment (e.g. "CPD35" from "CPD35-XAJ4-I")
  return first;
}

/**
 * Build the document/file title in format:  PDI-INV26113B-CPD35
 *   PDI  = report type
 *   INV26113B = invoice number with all hyphens stripped
 *   CPD35 / LM938 = short model code
 */
function buildDocTitle(session, vehicleType) {
  const pl = session.pickingList ?? {};
  const v  = session.vehicle    ?? {};

  // Invoice: strip hyphens — "INV-26113B" → "INV26113B"
  const invoiceStr = pl.invoiceNumber
    ? pl.invoiceNumber.replace(/-/g, '')
    : null;

  const shortModel = getShortModel(pl.model, v.model, vehicleType);

  return ['PDI', invoiceStr, shortModel].filter(Boolean).join('-');
}

// ─── Text report ──────────────────────────────────────────────────────────────

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

  // items from DO; fallback to session.items
  let items = session.items ?? [];
  if (env.IMAGE_DEDUP && session.user_id) {
    try {
      const id   = env.IMAGE_DEDUP.idFromName(session.user_id);
      const stub = env.IMAGE_DEDUP.get(id);
      const res  = await stub.fetch('http://do/get-items');
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length > 0) items = data.items;
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
    } else if (section.id === 'attachment_accessories' && pl.attachments?.length > 0) {
      // No photo for this section, but picking list has accessories — show them
      const attText = pl.attachments.map(a => a.name).join(', ');
      body += `${'—'.padEnd(12)} ${section.label}\n`;
      body += `             → Per PL: ${attText}\n`;
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

  const plHeader = plLines.length > 0 ? plLines.join('\n') + '\n' : '';
  const vinLine  = vinNote ? `${vinNote}\n` : '';

  return `📋 ${template.title}\n🕐 ${now}\n🔧 ${vehicleLine}\n${plHeader}${vinLine}${'─'.repeat(44)}\n\n${body}`;
}

// ─── Lark doc generation ──────────────────────────────────────────────────────

export async function generateReportAsLarkDoc(session, env) {
  const reportType  = normalizeReportType(session.report_type);
  const v           = session.vehicle ?? {};
  const vehicleType = v.type ?? 'UNKNOWN';

  if (reportType !== 'PDI') return null;

  // Prefer wiki tokens (new table-based templates); fall back to direct doc tokens.
  const wikiToken = vehicleType === 'WHEEL_LOADER'
    ? env.LOADER_PDI_WIKI_TOKEN
    : env.FORKLIFT_PDI_WIKI_TOKEN;

  let docToken;
  if (wikiToken) {
    try {
      docToken = await getWikiNodeObjToken(wikiToken, env);
    } catch (e) {
      console.warn('[doc] wiki token resolution failed, falling back to doc token:', e.message);
      docToken = vehicleType === 'WHEEL_LOADER'
        ? env.LOADER_PDI_DOC_TOKEN
        : env.FORKLIFT_PDI_DOC_TOKEN;
    }
  } else {
    docToken = vehicleType === 'WHEEL_LOADER'
      ? env.LOADER_PDI_DOC_TOKEN
      : env.FORKLIFT_PDI_DOC_TOKEN;
  }

  if (!docToken) return null;

  // New filename format: PDI-INV26113B-CPD35
  const title = buildDocTitle(session, vehicleType);

  console.log('[doc] step 1: copying document, docToken=', docToken, 'title=', title);
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

  // Brief pause so the freshly-copied document is ready for block reads/writes.
  await new Promise(r => setTimeout(r, 2000));

  const { fillReportIntoDoc } = await import('../services/lark.js');
  await fillReportIntoDoc(newFile.token, doItems, session, env);
  console.log('[doc] fill done');

  return { url: getDocumentUrl(newFile.token), title };
}
