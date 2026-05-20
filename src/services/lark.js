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
      if (!resultBlockId && (content.includes('Result') || content.includes('对应图片分析'))) resultBlockId = b.block_id;
      if (!notesBlockId  && (content.includes('Notes')  || content.includes('备注')))       notesBlockId  = b.block_id;
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
        } else if ((text.includes('对应图片') && !text.includes('分析')) || text.trim() === '(Photo)') {
          photoPlaceholders.push({ blockId: b.block_id, rootIdx: i, used: false });
        }
      }
    }

    sectionMap[checkId] = { resultBlockId, notesBlockId, headingIdx, endIdx, checkboxBlocks, photoPlaceholders };
  }
  console.log('[fillReport] sectionMap keys:', Object.keys(sectionMap));

  // ── Table-format detection & filling ────────────────────────────────────────
  // New templates use a 3-column table: OK | NG | Items/检查项目
  // Each data row is one inspection item; we tick OK or NG and strikethrough the
  // description half of the cell text when an item passes.

  const tableBlockIds = rootChildren.filter(id => blockMap[id]?.block_type === 31);
  const isTableFormat  = tableBlockIds.length > 0;

  if (isTableFormat) {
    console.log('[fillReport] table format detected, tables:', tableBlockIds.length);

    // ── Section heading → check_id mapping ────────────────────────────────
    const SECTION_PATTERNS = [
      { checkId: 'basic_info',             kws: ['Basic Info', '基本信息'] },
      { checkId: 'attachment_accessories', kws: ['Attachment', '附件'] },
      { checkId: 'visual_structure',       kws: ['Visual', 'Structure', '外观'] },
      { checkId: 'fluid_levels',           kws: ['Fluid', '油液'] },
      { checkId: 'engine_mechanical',      kws: ['Engine', '发动机'] },
      { checkId: 'electrical_system',      kws: ['Electrical', '电气'] },
      { checkId: 'hydraulic_system',       kws: ['Hydraulic', '液压'] },
      { checkId: 'mast_fork_chain',        kws: ['Mast', '门架'] },
      { checkId: 'loader_arm_axle',        kws: ['Loader', '大臂', '车桥'] },
      { checkId: 'steering_brake_dynamic', kws: ['Steering', '转向'] },
      { checkId: 'tyre_wheel',             kws: ['Tyre', 'Tire', '轮胎'] },
      { checkId: 'safety_functions',       kws: ['Safety', '安全'] },
      { checkId: 'maintenance_work',       kws: ['Maintenance', '保养'] },
      { checkId: 'final_result',           kws: ['Final', '最终'] },
    ];

    function headingTextToCheckId(text) {
      const t = text.toLowerCase();
      for (const p of SECTION_PATTERNS) {
        if (p.kws.some(k => t.includes(k.toLowerCase()))) return p.checkId;
      }
      return null;
    }

    function findHeadingBeforeTable(tblRootIdx) {
      for (let i = tblRootIdx - 1; i >= 0; i--) {
        const b = blockMap[rootChildren[i]];
        if (!b) continue;
        if (b.block_type >= 3 && b.block_type <= 11) {
          const text = getHeadingText(b);
          if (text) return { text, idx: i };
        }
        if (b.block_type === 31) break; // hit another table — stop
      }
      return null;
    }

    // ── Index DO items by section ──────────────────────────────────────────
    const doItemBySection = {};
    for (const it of items) {
      if (it.type === 'image' && it.check_id) {
        const prev = doItemBySection[it.check_id];
        if (!prev || (it.status !== 'pending' && prev.status === 'pending'))
          doItemBySection[it.check_id] = it;
      }
    }
    for (const it of items) {
      if (it.type === 'handwritten' && it.check_id) {
        const sid = ITEM_SECTION_MAP[it.check_id] ?? it.check_id;
        if (!doItemBySection[sid]) doItemBySection[sid] = it;
      }
    }

    // ── Table cell helpers ─────────────────────────────────────────────────

    async function getCellText(cellId) {
      const cell = blockMap[cellId];
      if (!cell) return '';
      return (cell.children ?? []).map(cid => getBlockText(blockMap[cid] ?? {})).join(' ').trim();
    }

    async function tickCell(cellId, done) {
      const cell = blockMap[cellId];
      if (!cell) return;
      for (const cid of (cell.children ?? [])) {
        const cb = blockMap[cid];
        if (!cb) continue;
        if (cb.block_type === 17) { await putTodoBlock(cid, done); return; }
        if (cb.block_type === 2) {
          await patchBlock(cid, { update_text_elements: { elements: [{ text_run: { content: done ? '☑' : '□' } }] } });
          return;
        }
      }
    }

    async function strikethroughCell(cellId) {
      const cell = blockMap[cellId];
      if (!cell) return;
      for (const cid of (cell.children ?? [])) {
        const cb = blockMap[cid];
        if (!cb || cb.block_type !== 2) continue;
        const text = getBlockText(cb);
        if (!text.trim()) continue;
        const sep = Math.max(text.indexOf('：'), text.indexOf(':'));
        if (sep > 0) {
          await patchBlock(cid, {
            update_text_elements: { elements: [
              { text_run: { content: text.substring(0, sep + 1) } },
              { text_run: { content: text.substring(sep + 1), text_element_style: { strikethrough: true } } },
            ]},
          });
        } else {
          await putTextBlockStyled(cid, text, true);
        }
        break;
      }
    }

    // ── Vehicle type map ───────────────────────────────────────────────────
    const vehicleTypeForTable = v.type ?? '';
    const VTYPE_MAP = [
      { keywords: ['Diesel Forklift', '柴油叉车'],   types: ['FORKLIFT_ICE', 'FORKLIFT_DIESEL'] },
      { keywords: ['LPG', 'Petrol', '汽油'],          types: ['FORKLIFT_LPG', 'FORKLIFT_PETROL', 'FORKLIFT_GAS'] },
      { keywords: ['Electric Forklift', '电动叉车'],  types: ['FORKLIFT_ELECTRIC'] },
      { keywords: ['Order Picker', '拣选'],           types: ['ORDER_PICKER'] },
      { keywords: ['Reach Truck', '前移'],            types: ['REACH_TRUCK'] },
      { keywords: ['Wheel Loader', '装载机'],         types: ['WHEEL_LOADER'] },
      { keywords: ['Walkie', '步行'],                 types: ['FORKLIFT_WALKIE'] },
    ];

    // Overall NG status (for final result table)
    const hasAnyNg = items.some(i => i.status === 'ng');

    // Photo tasks: collected here, inserted after all tables are processed
    const tablePhotoTasks = []; // { item, afterRootIdx }

    // ── Process each table ─────────────────────────────────────────────────
    for (const tableId of tableBlockIds) {
      const tblRootIdx = rootChildren.indexOf(tableId);
      const tbl = blockMap[tableId];
      if (!tbl) continue;

      const colSize = tbl.table?.property?.column_size ?? 2;
      const rowSize = tbl.table?.property?.row_size ?? Math.ceil((tbl.children?.length ?? 0) / colSize);
      const cells   = tbl.children ?? [];
      if (cells.length < colSize) continue;

      // Section check_id from heading above this table
      const hdg     = findHeadingBeforeTable(tblRootIdx);
      const checkId = hdg ? headingTextToCheckId(hdg.text) : null;
      console.log('[fillReport] table', tableId, 'checkId=', checkId, 'hdg=', hdg?.text?.slice(0, 40));

      // Table type from header row
      const hdrTexts = [];
      for (let c = 0; c < colSize; c++) hdrTexts.push((await getCellText(cells[c])).trim());
      const hdrJoined = hdrTexts.join('|').toLowerCase();

      let tableType = 'unknown';
      if      (hdrJoined.includes('ok') && hdrJoined.includes('ng')) tableType = 'inspection';
      else if (hdrJoined.includes('done'))                            tableType = 'maintenance';
      else if (hdrJoined.includes('result') || hdrJoined.includes('结果')) tableType = 'final_result';
      else if (hdrJoined.includes('detail') || hdrJoined.includes('内容'))  tableType = 'basic_info';
      console.log('[fillReport] tableType=', tableType, 'headers=', hdrTexts);

      // Column indices
      let okCol = -1, ngCol = -1, itemCol = -1, doneCol = -1, detailCol = -1, resultCol = -1;
      for (let c = 0; c < colSize; c++) {
        const h = hdrTexts[c].toLowerCase();
        if      (h === 'ok')                                                   okCol     = c;
        else if (h === 'ng')                                                   ngCol     = c;
        else if (h.startsWith('done'))                                         doneCol   = c;
        else if (h.includes('detail') || h.includes('内容'))                  detailCol = c;
        else if (h.includes('result') || h.includes('结果'))                  resultCol = c;
        else if (h.includes('item') || h.includes('检查') || h.includes('项目')) itemCol = c;
      }

      // ── Inspection table: OK | NG | Items ─────────────────────────────────
      if (tableType === 'inspection') {
        if (okCol   === -1) okCol   = 0;
        if (ngCol   === -1) ngCol   = 1;
        if (itemCol === -1) itemCol = 2;
        const doItem = checkId ? (doItemBySection[checkId] ?? null) : null;

        for (let r = 1; r < rowSize; r++) {
          const base = r * colSize;
          if (base + Math.max(okCol, ngCol, itemCol) >= cells.length) break;
          if (!doItem) continue;
          const okCellId   = cells[base + okCol];
          const ngCellId   = cells[base + ngCol];
          const itemCellId = cells[base + itemCol];
          if (doItem.status === 'ok' || doItem.status === 'corrected') {
            await tickCell(okCellId, true);
            await strikethroughCell(itemCellId);
          } else if (doItem.status === 'ng') {
            await tickCell(ngCellId, true);
          } else if (doItem.status === 'n/a' || doItem.status === 'na') {
            await strikethroughCell(itemCellId);
          }
        }
      }

      // ── Basic info table: Item | Details ──────────────────────────────────
      else if (tableType === 'basic_info') {
        if (itemCol   === -1) itemCol   = 0;
        if (detailCol === -1) detailCol = 1;

        const nowDate      = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }).split(',')[0];
        const vinMis       = pl.vin && v.serial && v.serialSource !== 'PICKING_LIST' &&
          pl.vin.replace(/[\s\-]/g, '').toUpperCase() !== v.serial.replace(/[\s\-]/g, '').toUpperCase();
        const serialSuffix = vinMis ? ` ⚠️ PL: ${pl.vin} / NP: ${v.serial}` : '';

        for (let r = 1; r < rowSize; r++) {
          const base       = r * colSize;
          if (base + detailCol >= cells.length) break;
          const rowLabel   = (await getCellText(cells[base + itemCol])).toLowerCase();
          const detailCell = blockMap[cells[base + detailCol]];
          if (!detailCell) continue;
          const childIds   = detailCell.children ?? [];

          const fillDetail = async (val) => { if (childIds[0]) await putBlock(childIds[0], val); };

          if      (rowLabel.includes('customer') || rowLabel.includes('客户')) {
            await fillDetail(pl.customer ?? '');
          } else if (rowLabel.includes('invoice') || rowLabel.includes('order') || rowLabel.includes('发票') || rowLabel.includes('订单')) {
            await fillDetail(pl.invoiceNumber ?? '');
          } else if (rowLabel.includes('model') || rowLabel.includes('型号')) {
            await fillDetail(v.model ?? '');
          } else if (rowLabel.includes('serial') || rowLabel.includes('vin') || rowLabel.includes('车架')) {
            await fillDetail(`${effectiveSerial}${serialSuffix}`);
          } else if (rowLabel.includes('hour') || rowLabel.includes('小时')) {
            await fillDetail(v.hours ? `${v.hours}h` : '');
          } else if (rowLabel.includes('date') || rowLabel.includes('日期')) {
            await fillDetail(nowDate);
          } else if (rowLabel.includes('type') || rowLabel.includes('类型')) {
            // Vehicle type — tick the matching inline checkbox option
            const matchedEntry = VTYPE_MAP.find(o => o.types.includes(vehicleTypeForTable));
            if (matchedEntry) {
              const todoKids = childIds.map(cid => blockMap[cid]).filter(b => b?.block_type === 17);
              const textKids = childIds.map(cid => blockMap[cid]).filter(b => b?.block_type === 2);

              if (todoKids.length > 0) {
                // One todo block per option
                for (const tb of todoKids) {
                  if (matchedEntry.keywords.some(kw => getBlockText(tb).includes(kw)))
                    await putTodoBlock(tb.block_id, true);
                }
              } else if (textKids.length === 1) {
                // All options in a single text block with ☐ markers
                const tb       = textKids[0];
                const fullText = getBlockText(tb);
                let newText    = fullText;
                for (const kw of matchedEntry.keywords) {
                  const re = new RegExp('☐([^☐]*?' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
                  if (re.test(newText)) { newText = newText.replace(re, '☑$1'); break; }
                }
                if (newText !== fullText) await putBlock(tb.block_id, newText);
              } else {
                // One text block per option
                for (const tb of textKids) {
                  const tbText = getBlockText(tb);
                  if (tbText.includes('☐') && matchedEntry.keywords.some(kw => tbText.includes(kw))) {
                    await putBlock(tb.block_id, tbText.replace('☐', '☑'));
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // ── Maintenance table: Done | Items ────────────────────────────────────
      else if (tableType === 'maintenance') {
        if (doneCol === -1) doneCol = 0;
        if (itemCol === -1) itemCol = 1;
        const doItem = checkId ? (doItemBySection[checkId] ?? null) : null;
        if (doItem && (doItem.status === 'ok' || doItem.status === 'corrected')) {
          for (let r = 1; r < rowSize; r++) {
            const base = r * colSize;
            if (base + doneCol >= cells.length) break;
            await tickCell(cells[base + doneCol], true);
          }
        }
      }

      // ── Final result table: Item | Result ──────────────────────────────────
      else if (tableType === 'final_result') {
        if (itemCol   === -1) itemCol   = 0;
        if (resultCol === -1) resultCol = 1;

        for (let r = 1; r < rowSize; r++) {
          const base       = r * colSize;
          if (base + resultCol >= cells.length) break;
          const resultCell = blockMap[cells[base + resultCol]];
          if (!resultCell) continue;

          for (const cid of (resultCell.children ?? [])) {
            const cb = blockMap[cid];
            if (!cb || cb.block_type !== 2) continue;
            const text = getBlockText(cb);
            if (!text.includes('☐') && !text.includes('☑')) continue;

            let newText = text;
            if (!hasAnyNg) {
              // Tick Yes, clear No
              newText = newText
                .replace(/☐(\s*(?:Yes|是))/g, '☑$1')
                .replace(/☑(\s*(?:No|否))/g,  '☐$1')
                .replace(/(Yes|是)(\s*)☐/g,    '$1$2☑')
                .replace(/(No|否)(\s*)☑/g,     '$1$2☐');
            } else {
              // Tick No, clear Yes
              newText = newText
                .replace(/☐(\s*(?:No|否))/g,  '☑$1')
                .replace(/☑(\s*(?:Yes|是))/g, '☐$1')
                .replace(/(No|否)(\s*)☐/g,    '$1$2☑')
                .replace(/(Yes|是)(\s*)☑/g,   '$1$2☐');
            }
            if (newText !== text) await putBlock(cid, newText);
            break;
          }
        }
      }

      // ── Remarks and Photos blocks between this table and the next ──────────
      const nextTblRootIdx = tableBlockIds
        .map(id => rootChildren.indexOf(id))
        .filter(idx => idx > tblRootIdx)
        .reduce((min, idx) => Math.min(min, idx), rootChildren.length);

      for (let i = tblRootIdx + 1; i < nextTblRootIdx; i++) {
        const b = blockMap[rootChildren[i]];
        if (!b || b.block_type !== 2) continue;
        const text = getBlockText(b);

        if ((text.includes('Remarks') || text.includes('备注')) && checkId) {
          const doItem = doItemBySection[checkId];
          if (doItem?.reading) {
            const sep   = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'));
            const label = sep >= 0 ? text.substring(0, sep + 1) : text + '：';
            await putBlock(rootChildren[i], label + doItem.reading);
          }
        } else if ((text.includes('Photos') || text.includes('照片')) && checkId) {
          for (const it of items) {
            if (it.type !== 'image' || !it.imageKey || !it.originalMsgId) continue;
            if (it.check_id === checkId || (checkId === 'basic_info' && it.check_id === 'nameplate'))
              tablePhotoTasks.push({ item: it, afterRootIdx: i });
          }
        }
      }
    } // end for tableId

    // ── Insert photos top-to-bottom with running offset ────────────────────
    tablePhotoTasks.sort((a, b) => a.afterRootIdx - b.afterRootIdx);
    let tblPhotoOffset = 0;
    for (const { item, afterRootIdx } of tablePhotoTasks) {
      try {
        const imgData   = await downloadImage(item.originalMsgId, item.imageKey, token, env);
        const fileToken = await uploadImageToLark(imgData.base64, imgData.mediaType, token, env, documentId);
        const insertIdx = afterRootIdx + tblPhotoOffset + 1;
        const res = await fetch(
          `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${contentParentId}/children`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ children: [{ block_type: 27, image: { token: fileToken } }], index: insertIdx }),
          },
        );
        const data = await res.json();
        if (data.code === 0) {
          tblPhotoOffset++;
          console.log('[fillReport] table photo inserted for', item.check_id, 'at', insertIdx);
        } else {
          console.error('[fillReport] table photo insert failed:', JSON.stringify(data).slice(0, 200));
        }
      } catch (e) {
        console.error('[fillReport] table photo error:', item.check_id, e.message);
      }
    }

  } // end isTableFormat

  function findCheckboxBlock(checkboxBlocks, label) {
    const parts = label.split('/').map(p => p.trim().toLowerCase()).filter(p => p.length > 3);
    for (const cb of checkboxBlocks) {
      const cbLower = cb.text.toLowerCase().replace(CHECKBOX_RE, '');
      if (parts.some(p => cbLower.includes(p))) return cb;
    }
    return null;
  }

  // ── Heading-based filling (skip when the template uses tables) ──────────────

  if (!isTableFormat) {

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
        photoInsertTasks.push({ item, placeholderRootIdx: placeholder.rootIdx, placeholderBlockId: placeholder.blockId });
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

  } // end if (!isTableFormat) — heading-based inspection filling

  // ── Fill basic_info fields — heading/text format only (table format handled above) ──

  let serialRootIdx    = -1;
  let hourMeterRootIdx = -1;

  if (!isTableFormat) {
    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }).split(',')[0];

    const vinMismatch = pl.vin && v.serial && v.serialSource !== 'PICKING_LIST' &&
      pl.vin.replace(/[\s\-]/g, '').toUpperCase() !== v.serial.replace(/[\s\-]/g, '').toUpperCase();
    const serialNote = vinMismatch ? ` ⚠️ PL: ${pl.vin} / NP: ${v.serial}` : '';

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

  // ── Heading-format photo insertions (skip for table format — handled above) ──

  if (!isTableFormat) {

  // Adjust original rootChildren indices for any blocks deleted above, then
  // insert from top to bottom with a running offset.

  function toAdjIdx(origIdx) {
    let shift = 0;
    for (const d of deletedSet) { if (d < origIdx) shift++; }
    return origIdx - shift;
  }

  // Add nameplate photo tasks → insert after Serial No. block (no placeholder to delete)
  if (serialRootIdx !== -1) {
    for (const item of items.filter(i => i.type === 'image' && i.check_id === 'nameplate' && i.imageKey && i.originalMsgId)) {
      photoInsertTasks.push({ item, placeholderRootIdx: serialRootIdx, placeholderBlockId: null });
    }
  }

  // Add hour-meter photo tasks → insert after Hour Meter block (no placeholder to delete)
  if (hourMeterRootIdx !== -1) {
    for (const item of items.filter(i => i.type === 'image' && i.check_id === 'hour_meter' && i.imageKey && i.originalMsgId)) {
      photoInsertTasks.push({ item, placeholderRootIdx: hourMeterRootIdx, placeholderBlockId: null });
    }
  }

  // Sort all insertions by adjusted position (top → bottom), insert with running offset.
  // PDI placeholder tasks (placeholderBlockId set): insert AT the placeholder position then
  // delete the placeholder text block — net index change is 0 when both succeed.
  // Nameplate/hour-meter tasks (placeholderBlockId null): insert AFTER the label block.
  photoInsertTasks.sort((a, b) => toAdjIdx(a.placeholderRootIdx) - toAdjIdx(b.placeholderRootIdx));
  let insertOffset = 0;
  for (const { item, placeholderRootIdx, placeholderBlockId } of photoInsertTasks) {
    try {
      const imgData   = await downloadImage(item.originalMsgId, item.imageKey, token, env);
      const fileToken = await uploadImageToLark(imgData.base64, imgData.mediaType, token, env, documentId);

      // For PDI placeholders: insert AT the placeholder index so image takes its place.
      // For nameplate/hour-meter labels: insert AFTER (+1) to keep the text line.
      const actualIdx = placeholderBlockId
        ? toAdjIdx(placeholderRootIdx) + insertOffset
        : toAdjIdx(placeholderRootIdx) + insertOffset + 1;

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

        if (placeholderBlockId) {
          // Delete the placeholder text block (shifted to actualIdx + 1 after insertion)
          const delRes = await fetch(
            `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${contentParentId}/children`,
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ start_index: actualIdx + 1, end_index: actualIdx + 2 }),
            },
          );
          const delTxt = await delRes.text();
          let delOk = false;
          try { delOk = JSON.parse(delTxt).code === 0; } catch (_) { delOk = true; }
          if (delOk) {
            insertOffset--;  // insert +1 and delete -1 = net 0 for subsequent tasks
          } else {
            console.error('[fillReport] placeholder delete failed:', delTxt.slice(0, 200));
          }
        }
      } else {
        console.error('[fillReport] insertImageBlock failed:', JSON.stringify(data).slice(0, 300));
      }
    } catch (e) {
      console.error('[fillReport] photo insert error:', item.check_id, e.message);
    }
  }

  } // end if (!isTableFormat) — heading-format photo insertions
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
