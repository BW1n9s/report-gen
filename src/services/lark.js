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

export async function uploadImageToLark(base64, mediaType, token, env, parentNode = '') {
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
  addField('parent_node', parentNode);
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

  const { getEffectiveSerial }                         = await import('../functions/generateReport.js');
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
      if (data.code !== 0) {
        throw new Error(`[fillReport] getAllBlocks API error ${data.code}: ${data.msg ?? text.slice(0, 300)}`);
      }
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

  let _firstPatch = true;
  async function patchBlock(blockId, body) {
    const res = await fetch(
      `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    if (_firstPatch) {
      _firstPatch = false;
      console.log('[fillReport] first patchBlock blockId:', blockId, 'body:', JSON.stringify(body).slice(0, 200), 'response:', text.slice(0, 300));
    }
    if (text.trim()) {
      try {
        const data = JSON.parse(text);
        if (data.code !== 0) console.error('[fillReport] patchBlock error blockId:', blockId, ':', text.slice(0, 300));
      } catch (_) {}
    }
  }

  const putBlock = (blockId, content) =>
    patchBlock(blockId, { update_text_elements: { elements: [{ text_run: { content } }] } });

  const putTextBlockStyled = (blockId, content, strikethrough = false) =>
    patchBlock(blockId, {
      update_text_elements: {
        elements: [{ text_run: { content, ...(strikethrough ? { text_element_style: { strikethrough: true } } : {}) } }],
      },
    });

  // For todo blocks (block_type 17): done=true → ✅, done=false → ☐
  // existingText is needed when applying strikethrough to preserve content.
  const putTodoBlock = (blockId, done, existingText = '', strikethrough = false) => {
    const body = { update_todo: { done } };
    if (strikethrough && existingText) {
      body.update_todo.elements = [{ text_run: { content: existingText, text_element_style: { strikethrough: true } } }];
    }
    return patchBlock(blockId, body);
  };

  // ── Initial block load ────────────────────────────────────────────────────

  const allBlocks = await getAllBlocks();
  const blockMap  = Object.fromEntries(allBlocks.map(b => [b.block_id, b]));

  // Lark Docs structure: Document block (block_id=documentId) → Page block (type=1) → Content.
  // Descend through type-1 wrapper blocks until we reach actual content.
  const docBlock = allBlocks.find(b => b.block_id === documentId) ?? allBlocks[0];
  let contentParentId = docBlock?.block_id ?? documentId;
  let rootChildren = docBlock?.children ?? [];
  for (let depth = 0; depth < 3 && rootChildren.length === 1; depth++) {
    const only = blockMap[rootChildren[0]];
    if (only?.block_type === 1 && only.children?.length > 0) {
      contentParentId = only.block_id;
      rootChildren = only.children;
    } else break;
  }
  console.log('[fillReport] allBlocks:', allBlocks.length,
    'rootChildren:', rootChildren.length,
    'contentParentId:', contentParentId,
    'first-child-type:', blockMap[rootChildren[0]]?.block_type ?? 'none');

  // ── Build section map ─────────────────────────────────────────────────────

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

  // Matches a leading checkbox character: □ ☐ ✓ ✗ ○ or [ ]
  const CHECKBOX_RE = /^[□☐✓✗○\[\]]\s*/;

  function getHeadingText(b) {
    for (let level = 1; level <= 9; level++) {
      const txt = b[`heading${level}`]?.elements?.[0]?.text_run?.content;
      if (txt) return txt;
    }
    return null;
  }
  const isHeading = (b) => b.block_type >= 3 && b.block_type <= 11 && getHeadingText(b) !== null;

  const sectionMap = {};
  for (const [checkId, keyword] of Object.entries(CHECK_ID_TO_KEYWORD)) {
    const headingBlock = allBlocks.find(b => isHeading(b) && getHeadingText(b)?.includes(keyword));
    if (!headingBlock) continue;

    const headingIdx = rootChildren.indexOf(headingBlock.block_id);
    if (headingIdx === -1) {
      console.warn('[fillReport] heading not in rootChildren:', keyword, headingBlock.block_id);
      continue;
    }
    let resultBlockId = null, notesBlockId = null;
    let endIdx = rootChildren.length;

    for (let i = headingIdx + 1; i < rootChildren.length; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      if (isHeading(b)) { endIdx = i; break; }
      const content = b.block_type === 2
        ? (b.text?.elements?.[0]?.text_run?.content ?? '')
        : '';
      if (!resultBlockId && content.includes('Result')) resultBlockId = b.block_id;
      if (!notesBlockId  && content.includes('Notes'))  notesBlockId  = b.block_id;
    }

    // Collect checkbox blocks and "(对应图片)" photo placeholder blocks.
    // blockType 17 = native todo; blockType 2 starting with □ = text checkbox.
    // rootIdx is the position in rootChildren — used for insertion offset tracking.
    const checkboxBlocks = [];
    const photoPlaceholders = [];
    for (let i = headingIdx + 1; i < endIdx; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      if (b.block_type === 17) {
        const text = (b.todo?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
        checkboxBlocks.push({ blockId: b.block_id, text, blockType: 17, rootIdx: i });
      } else if (b.block_type === 2) {
        const text = getBlockText(b);
        if (CHECKBOX_RE.test(text)) {
          checkboxBlocks.push({ blockId: b.block_id, text, blockType: 2, rootIdx: i });
        } else if (text.includes('对应图片') || text.trim() === '(Photo)') {
          photoPlaceholders.push({ blockId: b.block_id, rootIdx: i, used: false });
        }
      }
    }

    sectionMap[checkId] = { resultBlockId, notesBlockId, headingIdx, endIdx, checkboxBlocks, photoPlaceholders };
  }
  console.log('[fillReport] sectionMap keys:', Object.keys(sectionMap));

  function findCheckboxBlock(checkboxBlocks, label) {
    const parts = label.split('/').map(p => p.trim().toLowerCase()).filter(p => p.length > 3);
    for (const cb of checkboxBlocks) {
      const cbLower = cb.text.toLowerCase().replace(CHECKBOX_RE, '');
      if (parts.some(p => cbLower.includes(p))) return cb;
    }
    return null;
  }

  // ── Process handwritten sub-items (all statuses) ──────────────────────────

  const handwrittenBySection = {};
  for (const item of items) {
    if (item.type !== 'handwritten') continue;
    if (!item.check_id) continue;
    const sectionId = ITEM_SECTION_MAP[item.check_id]
                   ?? (sectionMap[item.check_id] ? item.check_id : null);
    if (!sectionId) continue;
    if (!handwrittenBySection[sectionId]) handwrittenBySection[sectionId] = [];
    handwrittenBySection[sectionId].push(item);
  }

  for (const [sectionId, sectionItems] of Object.entries(handwrittenBySection)) {
    const section = sectionMap[sectionId];
    if (!section) continue;

    for (const item of sectionItems) {
      const entry = HANDWRITTEN_ITEM_CATALOG.find(c => c.id === item.check_id);
      if (!entry) continue;
      const cb = findCheckboxBlock(section.checkboxBlocks, entry.label);
      if (!cb) continue;

      if (cb.blockType === 17) {
        if (item.status === 'ok' || item.status === 'corrected') {
          await putTodoBlock(cb.blockId, true);
        } else if (item.status === 'n/a' || item.status === 'na') {
          await putTodoBlock(cb.blockId, false, cb.text, true);
        }
        // NG: done stays false (default) — no update needed
      } else if (cb.blockType === 2) {
        const baseText = cb.text.replace(CHECKBOX_RE, '');
        if (item.status === 'ok' || item.status === 'corrected') {
          await putTextBlockStyled(cb.blockId, `✓ ${baseText}`);
        } else if (item.status === 'ng') {
          await putTextBlockStyled(cb.blockId, `✗ ${baseText}`);
        } else if (item.status === 'n/a' || item.status === 'na') {
          await putTextBlockStyled(cb.blockId, baseText, true);
        }
      }
    }

    if (section.resultBlockId) {
      const hasNg        = sectionItems.some(i => i.status === 'ng');
      const allNa        = sectionItems.every(i => i.status === 'n/a' || i.status === 'na');
      const overallStatus = hasNg ? 'ng' : allNa ? 'n/a' : 'ok';
      const icon         = STATUS_ICON[overallStatus] ?? '—';
      const ngItems = sectionItems.filter(i => i.status === 'ng');
      const ngText  = ngItems.map(i => {
        const e = HANDWRITTEN_ITEM_CATALOG.find(c => c.id === i.check_id);
        const shortLabel = (e?.label ?? i.check_id).split('/')[0].trim();
        return i.reading ? `${shortLabel}: ${i.reading}` : shortLabel;
      }).join('; ');
      await putBlock(section.resultBlockId, `${icon}${ngText ? ' ' + ngText : ''}`);
    }
  }

  // ── Process photo (image) items ───────────────────────────────────────────
  // 1. Update result/notes text blocks.
  // 2. Collect photo insertion tasks (download + upload + insert image block).
  //    Execute insertions in rootIdx order with a running offset so indices stay correct.

  const photoInsertTasks = [];

  for (const item of items) {
    if (item.type !== 'image') continue;
    if (!item.check_id || item.check_id === 'general') continue;
    if (item.check_id === 'nameplate' || item.check_id === 'picking_list') continue;

    const section = sectionMap[item.check_id];
    if (!section) continue;

    const icon = STATUS_ICON[item.status] ?? '—';
    if (section.resultBlockId) {
      await putBlock(
        section.resultBlockId,
        `${icon} ${item.reading ?? ''}${item.note ? ' — ' + item.note : ''}`,
      );
    }
    if (section.notesBlockId && item.note) {
      await putBlock(section.notesBlockId, item.note);
    }

    if (item.imageKey && item.originalMsgId) {
      const placeholder = section.photoPlaceholders.find(p => !p.used);
      if (placeholder) {
        placeholder.used = true;
        photoInsertTasks.push({ item, placeholderRootIdx: placeholder.rootIdx });
      }
    }
  }

  // ── Fill attachment_accessories PDI section from picking list ────────────────

  if (pl.attachments?.length > 0 && sectionMap.attachment_accessories) {
    const attSection = sectionMap.attachment_accessories;
    if (attSection.resultBlockId) {
      const hasPhotoItem = items.some(i => i.check_id === 'attachment_accessories' && i.type === 'image');
      if (!hasPhotoItem) {
        await putBlock(attSection.resultBlockId, '✓ Per picking list (photo pending)');
      }
    }
    if (attSection.notesBlockId) {
      const attText = pl.attachments
        .map(a => `${a.name}${a.djj_code ? ' (' + a.djj_code + ')' : ''}`)
        .join('\n');
      await putBlock(attSection.notesBlockId, `Picking list attachments:\n${attText}`);
    }
  }

  // ── Fill basic_info fields (record indices for photo insertion later) ─────

  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }).split(',')[0];

  const vinMismatch = pl.vin && v.serial && v.serialSource !== 'PICKING_LIST' &&
    pl.vin.replace(/[\s\-]/g, '').toUpperCase() !== v.serial.replace(/[\s\-]/g, '').toUpperCase();
  const serialNote = vinMismatch ? ` ⚠️ PL: ${pl.vin} / NP: ${v.serial}` : '';

  let serialRootIdx    = -1;
  let hourMeterRootIdx = -1;

  for (let i = 0; i < rootChildren.length; i++) {
    const block = blockMap[rootChildren[i]];
    if (!block || block.block_type !== 2) continue;
    const text = getBlockText(block);

    if (text.includes('Machine Model')) {
      await putBlock(rootChildren[i], `Machine Model / 设备型号：${v.model ?? ''}`);
    } else if (text.includes('Serial No.') || text.includes('VIN No.')) {
      serialRootIdx = i;
      await putBlock(rootChildren[i], `Serial No. / VIN No. / 车架号：${effectiveSerial}${serialNote}`);
    } else if (text.includes('Date / 日期')) {
      await putBlock(rootChildren[i], `Date / 日期：${now}`);
    } else if (text.includes('Hour Meter')) {
      hourMeterRootIdx = i;
      await putBlock(rootChildren[i], `Hour Meter / 小时数：${v.hours ?? ''}`);
    } else if (text.includes('Customer') || text.includes('客户')) {
      await putBlock(rootChildren[i], `Customer / 客户：${pl.customer ?? ''}`);
    } else if (text.includes('Invoice') || text.includes('发票') || text.includes('Order No')) {
      await putBlock(rootChildren[i], `Invoice No. / 发票号：${pl.invoiceNumber ?? ''}`);
    }
  }

  // ── Helpers: find checkbox section range ──────────────────────────────────
  // Returns { start, end } indices in rootChildren (end exclusive).
  // Starts searching from headerIdx+1 and collects consecutive checkbox / empty blocks.

  function findCheckboxSectionRange(headerIdx) {
    let start = headerIdx + 1;
    let end   = start;
    for (let i = start; i < rootChildren.length; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      const text = getBlockText(b);
      const isCb = b.block_type === 17 || (b.block_type === 2 && CHECKBOX_RE.test(text));
      const isEmpty = !text.trim();
      if (isCb || isEmpty) {
        if (isCb) end = i + 1;  // extend end only on actual checkbox
      } else {
        break;  // non-checkbox non-empty block terminates the section
      }
    }
    return { start, end };
  }

  const toDeleteIndices = [];

  // ── Machine type option selection ─────────────────────────────────────────

  const MACHINE_TYPE_OPTIONS = [
    { keyword: 'Diesel Forklift',   types: ['FORKLIFT_ICE', 'FORKLIFT_DIESEL'] },
    { keyword: 'Duel Fuel',         types: ['FORKLIFT_LPG', 'FORKLIFT_PETROL', 'FORKLIFT_GAS'] },
    { keyword: 'Electric Forklift', types: ['FORKLIFT_ELECTRIC'] },
    { keyword: 'Walkie',            types: ['FORKLIFT_WALKIE'] },
    { keyword: 'Order Picker',      types: ['ORDER_PICKER'] },
    { keyword: 'Reach Truck',       types: ['REACH_TRUCK'] },
    { keyword: 'Other',             types: [] },  // catch-all
  ];

  const vehicleType = v.type ?? '';
  const mtHeaderIdx = rootChildren.findIndex(id => {
    const b = blockMap[id];
    return b && getBlockText(b).includes('Machine Type Options');
  });

  if (mtHeaderIdx !== -1 && vehicleType && vehicleType !== 'UNKNOWN') {
    const { start: mtStart, end: mtEnd } = findCheckboxSectionRange(mtHeaderIdx);
    const matchedMtKw = MACHINE_TYPE_OPTIONS.find(o => o.types.includes(vehicleType))?.keyword ?? 'Other';

    for (let i = mtStart; i < mtEnd; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      const text = getBlockText(b);
      const isCb = b.block_type === 17 || (b.block_type === 2 && CHECKBOX_RE.test(text));
      if (!isCb) continue;

      const opt = MACHINE_TYPE_OPTIONS.find(o => text.includes(o.keyword));
      if (!opt) continue;

      if (opt.keyword === matchedMtKw) {
        if (b.block_type === 17) await putTodoBlock(b.block_id, true);
        else await putTextBlockStyled(b.block_id, `✓ ${text.replace(CHECKBOX_RE, '')}`);
      } else {
        toDeleteIndices.push(i);
      }
    }
  }

  // ── Attachment equipment selection ────────────────────────────────────────

  const ATT_OPTIONS = [
    { keyword: 'Side Shift',  match: n => n.includes('side shift') || n.includes('sideshift') },
    { keyword: 'Positioner',  match: n => n.includes('positioner') },
    { keyword: 'Charger',     match: n => n.includes('charger') },
    { keyword: 'Forks',       match: n => /\bfork/.test(n) },
  ];

  const plAttachments = session.pickingList?.attachments;
  if (Array.isArray(plAttachments)) {
    // Find section by locating the first attachment-specific block
    const attAnchorIdx = rootChildren.findIndex(id => {
      const b = blockMap[id];
      if (!b) return false;
      const t = getBlockText(b).toLowerCase();
      return ATT_OPTIONS.some(o => t.includes(o.keyword.toLowerCase()));
    });

    if (attAnchorIdx !== -1) {
      // Walk back to find true section start (in case Side Shift isn't first)
      let attStart = attAnchorIdx;
      while (attStart > 0) {
        const prev = blockMap[rootChildren[attStart - 1]];
        if (!prev) break;
        const prevText = getBlockText(prev);
        const isPrevCb = prev.block_type === 17 || (prev.block_type === 2 && CHECKBOX_RE.test(prevText));
        if (isPrevCb) attStart--;
        else break;
      }
      const { end: attEnd } = findCheckboxSectionRange(attStart - 1);

      const unmatched = plAttachments.filter(
        att => !ATT_OPTIONS.some(o => o.match(att.name.toLowerCase()))
      );

      for (let i = attStart; i < attEnd; i++) {
        const b = blockMap[rootChildren[i]];
        if (!b) continue;
        const text  = getBlockText(b);
        const isCb  = b.block_type === 17 || (b.block_type === 2 && CHECKBOX_RE.test(text));
        if (!isCb) continue;

        const stdOpt = ATT_OPTIONS.find(o => text.toLowerCase().includes(o.keyword.toLowerCase()));
        if (stdOpt) {
          const keep = plAttachments.some(a => stdOpt.match(a.name.toLowerCase()));
          if (keep) {
            if (b.block_type === 17) await putTodoBlock(b.block_id, true);
            else await putTextBlockStyled(b.block_id, `✓ ${text.replace(CHECKBOX_RE, '')}`);
          } else {
            toDeleteIndices.push(i);
          }
        } else if (text.includes('Other')) {
          if (unmatched.length > 0) {
            const otherNames = unmatched.map(a => a.name).join(', ');
            const newText = `Other / 其他：${otherNames}`;
            if (b.block_type === 17) await putTodoBlock(b.block_id, true, newText);
            else await putTextBlockStyled(b.block_id, `✓ ${newText}`);
          } else {
            toDeleteIndices.push(i);
          }
        }
      }
    }
  }

  // ── Execute block deletions (high → low to preserve lower indices) ────────

  const deletedSet = new Set();
  if (toDeleteIndices.length > 0) {
    const sorted = [...new Set(toDeleteIndices)].sort((a, b) => b - a);
    for (const idx of sorted) {
      const res = await fetch(
        `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${contentParentId}/children`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ start_index: idx, end_index: idx + 1 }),
        },
      );
      const txt = await res.text();
      if (txt.trim()) {
        try {
          const d = JSON.parse(txt);
          if (d.code === 0) deletedSet.add(idx);
          else console.error('[fillReport] deleteBlock err at idx', idx, ':', txt.slice(0, 200));
        } catch (_) { deletedSet.add(idx); }
      } else {
        deletedSet.add(idx);
      }
    }
    console.log('[fillReport] deleted', deletedSet.size, 'option blocks');
  }

  // ── Photo insertions (PDI placeholders + nameplate + hour_meter) ──────────
  // Adjust original rootChildren indices for any blocks deleted above, then
  // insert from top to bottom with a running offset.

  function toAdjIdx(origIdx) {
    let shift = 0;
    for (const d of deletedSet) { if (d < origIdx) shift++; }
    return origIdx - shift;
  }

  // Add nameplate photo tasks → insert after Serial No. block
  if (serialRootIdx !== -1) {
    for (const item of items.filter(i => i.type === 'image' && i.check_id === 'nameplate' && i.imageKey && i.originalMsgId)) {
      photoInsertTasks.push({ item, placeholderRootIdx: serialRootIdx });
    }
  }

  // Add hour-meter photo tasks → insert after Hour Meter block
  if (hourMeterRootIdx !== -1) {
    for (const item of items.filter(i => i.type === 'image' && i.check_id === 'hour_meter' && i.imageKey && i.originalMsgId)) {
      photoInsertTasks.push({ item, placeholderRootIdx: hourMeterRootIdx });
    }
  }

  // Sort all insertions by adjusted position (top → bottom), insert with running offset
  photoInsertTasks.sort((a, b) => toAdjIdx(a.placeholderRootIdx) - toAdjIdx(b.placeholderRootIdx));
  let insertOffset = 0;
  for (const { item, placeholderRootIdx } of photoInsertTasks) {
    try {
      const imgData   = await downloadImage(item.originalMsgId, item.imageKey, token, env);
      const fileToken = await uploadImageToLark(imgData.base64, imgData.mediaType, token, env, documentId);
      const actualIdx = toAdjIdx(placeholderRootIdx) + insertOffset + 1;
      const res = await fetch(
        `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${contentParentId}/children`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            children: [{ block_type: 27, image: { token: fileToken } }],
            index: actualIdx,
          }),
        },
      );
      const data = await res.json();
      if (data.code === 0) {
        insertOffset++;
        console.log('[fillReport] photo inserted for', item.check_id, 'at idx', actualIdx);
      } else {
        console.error('[fillReport] insertImageBlock failed:', JSON.stringify(data).slice(0, 300));
      }
    } catch (e) {
      console.error('[fillReport] photo insert error:', item.check_id, e.message);
    }
  }
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
