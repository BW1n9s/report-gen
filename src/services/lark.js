// ─── Token ────────────────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiresAt = 0;

export async function getToken(env) {
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }
  const res = await fetch(`${env.LARK_API_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id:     env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`getToken failed: ${data.msg}`);
  _cachedToken    = data.tenant_access_token;
  _tokenExpiresAt = Date.now() + 6900 * 1000;
  return _cachedToken;
}

// ─── Image ────────────────────────────────────────────────────────────────────

export async function downloadImage(messageId, imageKey, token, env) {
  const res = await fetch(
    `${env.LARK_API_URL}/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`downloadImage failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const mediaType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
  return { base64, mediaType };
}

// ─── Plain Text Message ───────────────────────────────────────────────────────

export async function sendMessage(chatId, text, env) {
  const token = await getToken(env);
  const res = await fetch(`${env.LARK_API_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) console.error('sendMessage failed:', data);
  return data;
}

// ─── Interactive Card ─────────────────────────────────────────────────────────

const HEADER_COLORS = {
  blue: 'blue', green: 'green', yellow: 'yellow',
  red: 'red', grey: 'grey', gray: 'grey',
};

export async function sendCard(chatId, { header, body, buttons = [] }, env) {
  const token = await getToken(env);

  const elements = [];
  if (body) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: body } });
  }
  if (buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: buttons.map((btn) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: btn.label },
        type: btn.type ?? 'default',
        ...(btn.url ? { url: btn.url } : { value: { action: btn.action } }),
      })),
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title:    { tag: 'plain_text', content: header.title },
      template: HEADER_COLORS[header.style] ?? 'blue',
    },
    elements,
  };

  const res = await fetch(`${env.LARK_API_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) console.error('sendCard failed:', data);
  return data;
}

// ─── Reply to Message ─────────────────────────────────────────────────────────

export async function replyToMessage(messageId, content, msgType = 'text', env) {
  const token = await getToken(env);
  const body = {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    msg_type: msgType,
  };
  const resp = await fetch(`${env.LARK_API_URL}/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.code !== 0) console.error('[lark] replyToMessage failed:', JSON.stringify(data));
  return data;
}

export async function replyCardToMessage(messageId, card, env) {
  return replyToMessage(
    messageId,
    typeof card === 'string' ? card : JSON.stringify(card),
    'interactive',
    env,
  );
}

// ─── Document Helpers ─────────────────────────────────────────────────────────

export async function getWikiNodeObjToken(wikiToken, env) {
  const token = await getToken(env);
  const res = await fetch(`${env.LARK_API_URL}/wiki/v2/spaces/get_node?token=${wikiToken}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`getWikiNodeObjToken failed (${data.code}): ${data.msg}`);
  return data.data.node.obj_token;
}

export async function copyDocumentToRoot(docToken, title, env) {
  const token = await getToken(env);
  const res = await fetch(`${env.LARK_API_URL}/drive/v1/files/${docToken}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: title, type: 'docx', folder_token: '' }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`copyDocumentToRoot failed (${data.code}): ${data.msg}`);

  const permRes = await fetch(
    `${env.LARK_API_URL}/drive/v1/permissions/${data.data.file.token}/public?type=docx`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ link_share_entity: 'tenant_editable', copy_entity: 'tenant_editable' }),
    },
  );
  const permText = await permRes.text();
  try {
    const permData = JSON.parse(permText);
    if (permData.code !== 0) console.error('[lark] set permission failed:', permText);
  } catch (_) {}

  return data.data.file;
}

export async function appendReportBlocks(documentId, reportText, env) {
  const token = await getToken(env);
  const lines = reportText.split('\n').filter(l => l.trim());
  const children = lines.map(line => ({
    block_type: 2,
    text: { elements: [{ text_run: { content: line } }], style: {} },
  }));
  const res = await fetch(
    `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ children, index: -1 }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) console.error('[lark] appendReportBlocks failed:', JSON.stringify(data));
  return data;
}

export function getDocumentUrl(fileToken) {
  return `https://www.larksuite.com/docx/${fileToken}`;
}

export async function uploadImageToLark(base64, mediaType, token, env) {
  const boundary = '----LarkBoundary' + Date.now();
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const size = bytes.length;

  const textEncoder = new TextEncoder();
  const parts = [];
  const addField = (name, value) => {
    parts.push(textEncoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };
  addField('file_name', 'inspection.jpg');
  addField('parent_type', 'docx_image');
  addField('parent_node', '');
  addField('size', String(size));
  parts.push(textEncoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="inspection.jpg"\r\nContent-Type: ${mediaType}\r\n\r\n`
  ));
  parts.push(bytes);
  parts.push(textEncoder.encode(`\r\n--${boundary}--\r\n`));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }

  const res = await fetch(`${env.LARK_API_URL}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body.buffer,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`uploadImageToLark failed: ${data.msg}`);
  return data.data.file_token;
}

// ─── Fill Report Into Doc ─────────────────────────────────────────────────────

export async function fillReportIntoDoc(documentId, items, session, env) {
  const STATUS_ICON = { ok: '✓', ng: '✗ NG', corrected: '✓✏', 'n/a': 'N/A', pending: '—' };

  const token = await getToken(env);
  const v  = session.vehicle    ?? {};
  const pl = session.pickingList ?? {};

  const { getEffectiveSerial }         = await import('../functions/generateReport.js');
  const { HANDWRITTEN_ITEM_CATALOG, ITEM_SECTION_MAP } = await import('../templates/pdi-catalog.js');
  const effectiveSerial = getEffectiveSerial(session);
  console.log('[fillReport] effectiveSerial:', effectiveSerial, 'source:', v.serialSource ?? 'none');

  // ── Block fetch helpers ───────────────────────────────────────────────────

  async function getAllBlocks() {
    const blocks = [];
    let pageToken = null;
    do {
      const url = pageToken
        ? `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks?page_size=500&page_token=${pageToken}`
        : `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks?page_size=500`;
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      if (!text.trim()) break;
      const data = JSON.parse(text);
      blocks.push(...(data.data?.items ?? []));
      pageToken = data.data?.has_more ? data.data.page_token : null;
    } while (pageToken);
    return blocks;
  }

  function getBlockText(block) {
    if (block.block_type === 17) {
      return (block.todo?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
    }
    return (block.text?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
  }

  // Collect pending block updates; flush at the end with a single batch call.
  // Each entry: { blockId, content } for text blocks, or { blockId, done } for todo blocks.
  const pendingText = [];  // { blockId, content }
  const pendingTodo = [];  // { blockId, done }

  function queueText(blockId, content) { pendingText.push({ blockId, content }); }
  function queueTodo(blockId, done)    { pendingTodo.push({ blockId, done }); }

  async function flushUpdates() {
    // Text blocks batch
    for (let i = 0; i < pendingText.length; i += 50) {
      const slice = pendingText.slice(i, i + 50);
      const requests = slice.map(u => ({
        block_id: u.blockId,
        update_text_elements: { elements: [{ text_run: { content: u.content } }] },
      }));
      const res = await fetch(
        `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/batch_update`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ requests }),
        },
      );
      const txt = await res.text();
      if (txt.trim()) {
        try {
          const d = JSON.parse(txt);
          if (d.code !== 0) console.error('[fillReport] batch text update error:', txt.slice(0, 300));
        } catch (_) {}
      }
    }
    // Todo blocks batch
    for (let i = 0; i < pendingTodo.length; i += 50) {
      const slice = pendingTodo.slice(i, i + 50);
      const requests = slice.map(u => ({
        block_id: u.blockId,
        update_todo: { done: u.done },
      }));
      const res = await fetch(
        `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/batch_update`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ requests }),
        },
      );
      const txt = await res.text();
      if (txt.trim()) {
        try {
          const d = JSON.parse(txt);
          if (d.code !== 0) console.error('[fillReport] batch todo update error:', txt.slice(0, 300));
        } catch (_) {}
      }
    }
  }

  // ── Initial block load ────────────────────────────────────────────────────

  const allBlocks    = await getAllBlocks();
  const blockMap     = Object.fromEntries(allBlocks.map(b => [b.block_id, b]));
  const rootChildren = (allBlocks.find(b => b.block_id === documentId) ?? allBlocks[0])?.children ?? [];

  // ── Build section map (with checkbox scanning) ────────────────────────────

  const CHECK_ID_TO_KEYWORD = {
    attachment_accessories: 'Attachment',
    visual_structure:       'Visual',
    fluid_levels:           'Fluid Level',
    engine_mechanical:      'Engine',
    electrical_system:      'Electrical System',
    hydraulic_system:       'Hydraulic System',
    mast_fork_chain:        'Mast, Fork',
    loader_arm_axle:        'Loader Axle',
    steering_brake_dynamic: 'Steering, Brake',
    tyre_wheel:             'Tyre',
    safety_functions:       'Safety Function',
    maintenance_work:       'Maintenance Work',
    final_result:           'Final Test Result',
  };

  // Regex that matches a leading checkbox character (□ ☐ ✓ ✗ or [ ])
  const CHECKBOX_RE = /^[□☐✓✗○\[\]]\s*/;

  const sectionMap = {};
  for (const [checkId, keyword] of Object.entries(CHECK_ID_TO_KEYWORD)) {
    const headingBlock = allBlocks.find(b =>
      (b.block_type === 4 || b.block_type === 3) &&
      (b.heading2?.elements?.[0]?.text_run?.content?.includes(keyword) ||
       b.heading3?.elements?.[0]?.text_run?.content?.includes(keyword))
    );
    if (!headingBlock) continue;

    const headingIdx = rootChildren.indexOf(headingBlock.block_id);
    let resultBlockId = null, notesBlockId = null;
    let endIdx = rootChildren.length;

    for (let i = headingIdx + 1; i < rootChildren.length; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      if (b.block_type === 4 || b.block_type === 3) { endIdx = i; break; }
      const content = b.block_type === 2
        ? (b.text?.elements?.[0]?.text_run?.content ?? '')
        : '';
      if (!resultBlockId && content.includes('Result')) resultBlockId = b.block_id;
      if (!notesBlockId  && content.includes('Notes'))  notesBlockId  = b.block_id;
    }

    // Collect checkbox blocks within this section (block_type 17 = todo; block_type 2 with □)
    const checkboxBlocks = [];
    for (let i = headingIdx + 1; i < endIdx; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      if (b.block_type === 17) {
        const text = (b.todo?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
        checkboxBlocks.push({ blockId: b.block_id, text, blockType: 17 });
      } else if (b.block_type === 2) {
        const text = getBlockText(b);
        if (CHECKBOX_RE.test(text)) {
          checkboxBlocks.push({ blockId: b.block_id, text, blockType: 2 });
        }
      }
    }

    sectionMap[checkId] = { resultBlockId, notesBlockId, headingIdx, endIdx, checkboxBlocks };
  }
  console.log('[fillReport] sectionMap keys:', Object.keys(sectionMap));

  // Find the checkbox block whose text best matches a sub-item label.
  function findCheckboxBlock(checkboxBlocks, label) {
    // Label format: "English description / 中文描述"
    const parts = label.split('/').map(p => p.trim().toLowerCase()).filter(p => p.length > 3);
    for (const cb of checkboxBlocks) {
      const cbLower = cb.text.toLowerCase().replace(CHECKBOX_RE, '');
      if (parts.some(p => cbLower.includes(p))) return cb;
    }
    return null;
  }

  // Queue a checkbox tick (replaces □ in text blocks; sets done flag for todo blocks).
  function queueCheckboxTick(cb, status) {
    if (cb.blockType === 17) {
      const done = status === 'ok' || status === 'corrected';
      queueTodo(cb.blockId, done);
    } else {
      const icon = (status === 'ok' || status === 'corrected') ? '✓'
                 : status === 'ng'  ? '✗'
                 : status === 'n/a' ? '○'
                 : '□';
      const newText = cb.text.replace(CHECKBOX_RE, `${icon} `);
      queueText(cb.blockId, newText);
    }
  }

  // ── Process photo (image) items ───────────────────────────────────────────

  for (const item of items) {
    if (item.type !== 'image') continue;
    if (!item.check_id || item.check_id === 'general') continue;
    if (item.check_id === 'nameplate' || item.check_id === 'picking_list') continue;

    const section = sectionMap[item.check_id];
    if (!section) continue;

    const icon = STATUS_ICON[item.status] ?? '—';
    if (section.resultBlockId) {
      queueText(
        section.resultBlockId,
        `${icon} ${item.reading ?? ''}${item.note ? ' — ' + item.note : ''}`,
      );
    }
    if (section.notesBlockId && item.note) {
      queueText(section.notesBlockId, item.note);
    }
  }

  // ── Process handwritten sub-items (tick individual checkboxes) ────────────

  // Group sub-items by their parent section so we can compute a section-level summary.
  const handwrittenBySection = {};
  for (const item of items) {
    if (item.type !== 'handwritten') continue;
    if (!item.check_id) continue;
    const sectionId = ITEM_SECTION_MAP[item.check_id]    // new format: sub-item ID
                   ?? (sectionMap[item.check_id] ? item.check_id : null); // legacy: section ID
    if (!sectionId) continue;
    if (!handwrittenBySection[sectionId]) handwrittenBySection[sectionId] = [];
    handwrittenBySection[sectionId].push(item);
  }

  for (const [sectionId, sectionItems] of Object.entries(handwrittenBySection)) {
    const section = sectionMap[sectionId];
    if (!section) continue;

    // Tick each recognised sub-item's checkbox block in the document.
    for (const item of sectionItems) {
      const entry = HANDWRITTEN_ITEM_CATALOG.find(c => c.id === item.check_id);
      if (!entry) continue; // legacy section-level item — skip checkbox ticking
      const cb = findCheckboxBlock(section.checkboxBlocks, entry.label);
      if (cb) queueCheckboxTick(cb, item.status);
    }

    // Write section-level Result block summary.
    if (section.resultBlockId) {
      const hasNg  = sectionItems.some(i => i.status === 'ng');
      const allNa  = sectionItems.every(i => i.status === 'n/a' || i.status === 'na');
      const overallStatus = hasNg ? 'ng' : allNa ? 'n/a' : 'ok';
      const icon = STATUS_ICON[overallStatus] ?? '—';

      const ngItems = sectionItems.filter(i => i.status === 'ng');
      const ngText  = ngItems.map(i => {
        const e = HANDWRITTEN_ITEM_CATALOG.find(c => c.id === i.check_id);
        const shortLabel = (e?.label ?? i.check_id).split('/')[0].trim();
        return i.reading ? `${shortLabel}: ${i.reading}` : shortLabel;
      }).join('; ');

      queueText(section.resultBlockId, `${icon}${ngText ? ' ' + ngText : ''}`);
    }
  }

  // ── Fill attachment_accessories from picking list ──────────────────────────

  if (pl.attachments?.length > 0 && sectionMap.attachment_accessories) {
    const attSection = sectionMap.attachment_accessories;
    const attText = pl.attachments
      .map(a => `${a.name}${a.djj_code ? ' (' + a.djj_code + ')' : ''}`)
      .join('\n');

    if (attSection.resultBlockId) {
      const hasPhotoItem = items.some(i => i.check_id === 'attachment_accessories' && i.type === 'image');
      if (!hasPhotoItem) {
        queueText(attSection.resultBlockId, '✓ Per picking list (photo pending)');
      }
    }
    if (attSection.notesBlockId) {
      queueText(attSection.notesBlockId, `Picking list attachments:\n${attText}`);
    }
  }

  // ── Fill basic_info fields ────────────────────────────────────────────────

  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }).split(',')[0];

  const vinMismatch = pl.vin && v.serial && v.serialSource !== 'PICKING_LIST' &&
    pl.vin.replace(/[\s\-]/g, '').toUpperCase() !== v.serial.replace(/[\s\-]/g, '').toUpperCase();
  const serialNote = vinMismatch ? ` ⚠️ PL: ${pl.vin} / NP: ${v.serial}` : '';

  for (const blockId of rootChildren) {
    const block = blockMap[blockId];
    if (!block || block.block_type !== 2) continue;
    const text = getBlockText(block);

    if      (text.includes('Machine Model'))                                                 queueText(blockId, `Machine Model / 设备型号：${v.model ?? ''}`);
    else if (text.includes('Serial No.') || text.includes('VIN No.'))                       queueText(blockId, `Serial No. / VIN No. / 车架号：${effectiveSerial}${serialNote}`);
    else if (text.includes('Date / 日期'))                                                   queueText(blockId, `Date / 日期：${now}`);
    else if (text.includes('Hour Meter'))                                                    queueText(blockId, `Hour Meter / 小时数：${v.hours ?? ''}`);
    else if (text.includes('Customer') || text.includes('客户'))                            queueText(blockId, `Customer / 客户：${pl.customer ?? ''}`);
    else if (text.includes('Invoice') || text.includes('发票') || text.includes('Order No')) queueText(blockId, `Invoice No. / 发票号：${pl.invoiceNumber ?? ''}`);
  }

  // ── Flush all queued updates in batch requests ────────────────────────────
  await flushUpdates();
}

export async function updateTextMessage(messageId, text, env) {
  const token = await getToken(env);
  const resp = await fetch(
    `${env.LARK_API_URL}/im/v1/messages/${messageId}/content`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify({ text }) }),
    },
  );
  const data = await resp.json();
  if (data.code !== 0) console.error('[lark] updateTextMessage failed:', JSON.stringify(data));
  return data;
}

// ─── Item Result Card ─────────────────────────────────────────────────────────

export async function sendItemCard({ messageId, chatId, count, label, reading,
  itemId, status = 'pending', note = null, showInput = null, env }) {

  const token = await getToken(env);
  const card  = buildItemCard({ count, label, reading, itemId, status, note, showInput });

  const res = await fetch(
    `${env.LARK_API_URL}/im/v1/messages/${messageId}/reply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify(card), msg_type: 'interactive' }),
    },
  );
  return res.json();
}

export async function updateItemCard({ cardMsgId, count, label, reading,
  itemId, status, note = null, showInput = null, env }) {

  const token = await getToken(env);
  const card  = buildItemCard({ count, label, reading, itemId, status, note, showInput });

  const res = await fetch(
    `${env.LARK_API_URL}/im/v1/messages/${cardMsgId}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    },
  );
  return res.json();
}

const SECTION_OPTIONS = [
  { text: { tag: 'plain_text', content: '附件配件' },  value: 'attachment_accessories' },
  { text: { tag: 'plain_text', content: '外观结构' },  value: 'visual_structure' },
  { text: { tag: 'plain_text', content: '油液液位' },  value: 'fluid_levels' },
  { text: { tag: 'plain_text', content: '发动机机械' }, value: 'engine_mechanical' },
  { text: { tag: 'plain_text', content: '电气系统' },  value: 'electrical_system' },
  { text: { tag: 'plain_text', content: '液压系统' },  value: 'hydraulic_system' },
  { text: { tag: 'plain_text', content: '门架链条' },  value: 'mast_fork_chain' },
  { text: { tag: 'plain_text', content: '大臂车桥' },  value: 'loader_arm_axle' },
  { text: { tag: 'plain_text', content: '转向刹车' },  value: 'steering_brake_dynamic' },
  { text: { tag: 'plain_text', content: '轮胎车轮' },  value: 'tyre_wheel' },
  { text: { tag: 'plain_text', content: '安全功能' },  value: 'safety_functions' },
  { text: { tag: 'plain_text', content: '保养工作' },  value: 'maintenance_work' },
  { text: { tag: 'plain_text', content: '最终结果' },  value: 'final_result' },
  { text: { tag: 'plain_text', content: '其他' },      value: 'general' },
];

function buildItemCard({ count, label, reading, itemId, status, note, showInput }) {
  const headerMap = {
    pending:   { color: 'blue',   badge: `已分析 ${count} 张` },
    ok:        { color: 'green',  badge: `已分析 ${count} 张 ✓` },
    ng:        { color: 'red',    badge: `已分析 ${count} 张 ✗ NG` },
    corrected: { color: 'yellow', badge: `已分析 ${count} 张 ✏️` },
  };
  const h = headerMap[status] ?? headerMap.pending;

  const elements = [];
  const noteText = note ? `\n📝 ${note}` : '';
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${label}**\n${reading}${noteText}` },
  });

  if (showInput === 'ng') {
    elements.push({
      tag: 'input',
      placeholder: { tag: 'plain_text', content: '描述问题（如：漏油、损坏、缺失）' },
      name: 'ng_note',
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'danger',  text: { tag: 'plain_text', content: '确认 NG' },  value: { action: 'IMG_NG_SUBMIT',      itemId } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '取消' },      value: { action: 'IMG_CANCEL',         itemId } },
      ],
    });
  } else if (showInput === 'correction') {
    elements.push({
      tag: 'input',
      placeholder: { tag: 'plain_text', content: '补充说明（如：这是液压油尺，液位正常）' },
      name: 'correction_note',
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '提交修正' },  value: { action: 'IMG_CORRECT_SUBMIT', itemId } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '取消' },      value: { action: 'IMG_CANCEL',         itemId } },
      ],
    });
  } else if (showInput === 'reassign') {
    elements.push({
      tag: 'select_static',
      placeholder: { tag: 'plain_text', content: '选择正确的检查项目' },
      name: 'new_check_id',
      options: SECTION_OPTIONS,
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认移动' }, value: { action: 'IMG_REASSIGN_SUBMIT', itemId } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '取消' },     value: { action: 'IMG_CANCEL',          itemId } },
      ],
    });
  } else if (status === 'pending' || status === 'ok') {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'OK ✓' },    value: { action: 'IMG_OK',      itemId } },
        { tag: 'button', type: 'danger',  text: { tag: 'plain_text', content: 'NG ✗' },    value: { action: 'IMG_NG',      itemId } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '修正 ✏️' }, value: { action: 'IMG_CORRECT', itemId } },
      ],
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '移到其他项目' }, value: { action: 'IMG_REASSIGN', itemId } },
      ],
    });
  } else if (status === 'ng' || status === 'corrected') {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '重新编辑' }, value: { action: 'IMG_CORRECT', itemId } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '标回 OK' }, value: { action: 'IMG_OK',      itemId } },
      ],
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '移到其他项目' }, value: { action: 'IMG_REASSIGN', itemId } },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: h.badge }, template: h.color },
    elements,
  };
}
