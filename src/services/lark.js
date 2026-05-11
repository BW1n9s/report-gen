// ─── Token ────────────────────────────────────────────────────────────────────

// Module-level token cache（热实例复用，冷启动重新拿）
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
  _tokenExpiresAt = Date.now() + 6900 * 1000; // 6900s（token有效期7200s，留5分钟缓冲）
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
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  red: 'red',
  grey: 'grey',
  gray: 'grey',
};

export async function sendCard(chatId, { header, body, buttons = [] }, env) {
  const token = await getToken(env);

  const elements = [];

  if (body) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: body },
    });
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
      title: { tag: 'plain_text', content: header.title },
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
  const url = `${env.LARK_API_URL}/im/v1/messages/${messageId}/reply`;

  const body = {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    msg_type: msgType,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (data.code !== 0) {
    console.error('[lark] replyToMessage failed:', JSON.stringify(data));
  }
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

// ─── Update Existing Message ──────────────────────────────────────────────────

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
      body: JSON.stringify({
        link_share_entity: 'tenant_editable',
        copy_entity:       'tenant_editable',
      }),
    },
  );
  const permText = await permRes.text();
  try {
    const permData = JSON.parse(permText);
    if (permData.code !== 0) console.error('[lark] set permission failed:', permText);
  } catch (_) {
    console.log('[lark] set permission response:', permText);
  }

  return data.data.file; // { token, url, name, ... }
}

export async function appendReportBlocks(documentId, reportText, env) {
  const token = await getToken(env);
  const lines = reportText.split('\n').filter(l => l.trim());
  const children = lines.map(line => ({
    block_type: 2, // paragraph
    text: {
      elements: [{ text_run: { content: line } }],
      style: {},
    },
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

/** Return the public URL for a Lark docx file token. */
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
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`uploadImageToLark failed: ${data.msg}`);
  return data.data.file_token;
}

// ─── Fill Report Into Doc ─────────────────────────────────────────────────────

export async function fillReportIntoDoc(documentId, items, session, env) {
  const STATUS_ICON = { ok: '✓', ng: '✗ NG', corrected: '✓✏', pending: '—' };

  const token = await getToken(env);

  // ── Effective values with priority logic ─────────────────────────────────
  const v  = session.vehicle    ?? {};
  const pl = session.pickingList ?? {};

  // VIN priority: manual user input > picking list > nameplate OCR
  const { getEffectiveSerial } = await import('../functions/generateReport.js');
  const effectiveSerial = getEffectiveSerial(session);

  const serialSource = v.serialSource === 'MANUAL'  ? 'MANUAL'
                     : pl.vin                        ? 'PICKING_LIST'
                     : v.serial                      ? 'NAMEPLATE'
                     : 'none';
  console.log('[fillReport] effectiveSerial:', effectiveSerial, 'source:', serialSource);

  async function getAllBlocks() {
    const blocks = [];
    let pageToken = null;
    do {
      const url = pageToken
        ? `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks?page_size=500&page_token=${pageToken}`
        : `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks?page_size=500`;
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      console.log('[fillReport] getAllBlocks response:', text.slice(0, 200));
      if (!text.trim()) break;
      const data = JSON.parse(text);
      blocks.push(...(data.data?.items ?? []));
      pageToken = data.data?.has_more ? data.data.page_token : null;
    } while (pageToken);
    return blocks;
  }

  function getBlockText(block) {
    return (block.text?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
  }

  async function putBlock(blockId, content) {
    const res  = await fetch(
      `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          update_text_elements: { elements: [{ text_run: { content } }] },
        }),
      },
    );
    const text = await res.text();
    if (text.trim()) {
      try {
        const data = JSON.parse(text);
        if (data.code !== 0) console.error('[fillReport] putBlock error:', text.slice(0, 200));
      } catch (_) {
        console.log('[fillReport] putBlock non-JSON response:', text.slice(0, 100));
      }
    }
  }

  async function uploadImage(base64, mediaType, parentNode) {
    const boundary = '----LarkBoundary' + Date.now();
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const size = bytes.length;

    const enc = new TextEncoder();
    const parts = [];
    const addField = (name, value) => {
      parts.push(enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    };
    console.log('[uploadImage] parent_node:', parentNode, 'parent_type: docx_image');
    addField('file_name', 'inspection.jpg');
    addField('parent_type', 'docx_image');
    addField('parent_node', parentNode);
    addField('size', String(size));
    parts.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="inspection.jpg"\r\nContent-Type: ${mediaType}\r\n\r\n`
    ));
    parts.push(bytes);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.length; }

    const res  = await fetch(`${env.LARK_API_URL}/drive/v1/medias/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
    });
    const text = await res.text();
    console.log('[fillReport] uploadImage response:', text.slice(0, 200));
    const data = JSON.parse(text);
    if (data.code !== 0) throw new Error(`uploadImage failed: ${data.msg}`);
    return data.data.file_token;
  }

  async function replaceImageBlock(imageBlockId, fileToken) {
    const updateRes = await fetch(
      `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${imageBlockId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ replace_image: { token: fileToken } }),
      },
    );
    const updateText = await updateRes.text();
    console.log('[fillReport] replace_image response:', updateText.slice(0, 200));
  }

  let allBlocks    = await getAllBlocks();
  const blockMap   = Object.fromEntries(allBlocks.map(b => [b.block_id, b]));
  let rootChildren = (allBlocks.find(b => b.block_id === documentId) ?? allBlocks[0])?.children ?? [];

  async function refreshBlocks() {
    allBlocks    = await getAllBlocks();
    rootChildren = (allBlocks.find(b => b.block_id === documentId) ?? allBlocks[0])?.children ?? [];
  }

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

  const sectionMap = {};
  for (const [checkId, keyword] of Object.entries(CHECK_ID_TO_KEYWORD)) {
    const headingBlock = allBlocks.find(b =>
      (b.block_type === 4 || b.block_type === 3) &&
      (b.heading2?.elements?.[0]?.text_run?.content?.includes(keyword) ||
       b.heading3?.elements?.[0]?.text_run?.content?.includes(keyword))
    );
    if (!headingBlock) continue;

    const headingIdx = rootChildren.indexOf(headingBlock.block_id);
    let resultBlockId = null, notesBlockId = null, dividerIdx = -1;
    for (let i = headingIdx + 1; i < rootChildren.length; i++) {
      const b = blockMap[rootChildren[i]];
      if (!b) continue;
      if (b.block_type === 4 || b.block_type === 3) break;
      const content = b.text?.elements?.[0]?.text_run?.content ?? '';
      if (!resultBlockId && content.includes('Result')) resultBlockId = b.block_id;
      if (!notesBlockId && content.includes('Notes')) notesBlockId = b.block_id;
      if (b.block_type === 22 && dividerIdx === -1) { dividerIdx = i; break; }
    }
    sectionMap[checkId] = { resultBlockId, notesBlockId, dividerIdx };
  }
  console.log('[fillReport] sectionMap keys:', Object.keys(sectionMap));

  // ── Helper: find Basic Information section divider ────────────────────────

  function findBasicSectionDividerIdx() {
    const basicHeadingBlock = allBlocks.find(b =>
      (b.block_type === 4 || b.block_type === 3) &&
      (b.heading2?.elements?.[0]?.text_run?.content?.includes('Basic') ||
       b.heading3?.elements?.[0]?.text_run?.content?.includes('Basic'))
    );
    if (!basicHeadingBlock) return -1;
    const basicHeadingIdx = rootChildren.indexOf(basicHeadingBlock.block_id);
    if (basicHeadingIdx === -1) return -1;
    for (let i = basicHeadingIdx + 1; i < rootChildren.length; i++) {
      const b = blockMap[rootChildren[i]];
      if (b?.block_type === 22) return i;
      if (b?.block_type === 3 || b?.block_type === 4) return -1;
    }
    return -1;
  }

  // ── Process image items ───────────────────────────────────────────────────

  for (const item of items) {
    if (item.type !== 'image') continue;
    if (!item.check_id || item.check_id === 'general') continue;

    // ── Nameplate / picking_list: insert into Basic Information section ────
    if (item.check_id === 'nameplate' || item.check_id === 'picking_list') {
      if (!item.originalMsgId || !item.imageKey) continue;
      const dividerIdx = findBasicSectionDividerIdx();
      if (dividerIdx === -1) {
        console.warn('[fillReport] Basic Information divider not found for:', item.check_id);
        continue;
      }
      try {
        const createRes = await fetch(
          `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ children: [{ block_type: 27, image: {} }], index: dividerIdx }),
          },
        );
        const createData = JSON.parse(await createRes.text());
        const imageBlockId = createData.data?.children?.[0]?.block_id;
        if (!imageBlockId) throw new Error('Failed to create image block');

        const imageData = await downloadImage(item.originalMsgId, item.imageKey, token, env);
        const fileToken = await uploadImage(imageData.base64, imageData.mediaType, imageBlockId);
        console.log('[fillReport] image uploaded:', item.check_id, 'block:', imageBlockId, 'token:', fileToken);
        await replaceImageBlock(imageBlockId, fileToken);
        await refreshBlocks();
      } catch (e) {
        console.error(`[fillReport] ${item.check_id} image insert failed:`, e.message);
      }
      continue;
    }

    // ── Regular section items ─────────────────────────────────────────────
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

    if (item.originalMsgId && item.imageKey) {
      try {
        const insertIndex = section.dividerIdx ?? -1;

        const createRes = await fetch(
          `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ children: [{ block_type: 27, image: {} }], index: insertIndex }),
          },
        );
        const createData = JSON.parse(await createRes.text());
        const imageBlockId = createData.data?.children?.[0]?.block_id;
        if (!imageBlockId) throw new Error('Failed to create image block');

        const imageData = await downloadImage(item.originalMsgId, item.imageKey, token, env);
        const fileToken = await uploadImage(imageData.base64, imageData.mediaType, imageBlockId);
        console.log('[fillReport] image uploaded:', item.check_id, 'block:', imageBlockId, 'token:', fileToken);
        await replaceImageBlock(imageBlockId, fileToken);
        await refreshBlocks();
      } catch (e) {
        console.error('[lark] image insert failed:', e.message);
      }
    }
  }

  // ── Fill basic_info fields ────────────────────────────────────────────────
  const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }).split(',')[0];

  // VIN cross-check note (appended to serial field if there's a mismatch)
  const vinMismatch = (pl.vin && v.serial && v.serialSource !== 'PICKING_LIST')
    && pl.vin.replace(/[\s\-]/g, '').toUpperCase() !== v.serial.replace(/[\s\-]/g, '').toUpperCase();
  const serialNote = vinMismatch ? ` ⚠️ PL: ${pl.vin} / NP: ${v.serial}` : '';

  for (const blockId of rootChildren) {
    const block = blockMap[blockId];
    if (!block || block.block_type !== 2) continue;
    const text = getBlockText(block);

    if (text.includes('Machine Model')) {
      await putBlock(blockId, `Machine Model / 设备型号：${v.model ?? ''}`);
    } else if (text.includes('Serial No.') || text.includes('VIN No.')) {
      await putBlock(blockId, `Serial No. / VIN No. / 车架号：${effectiveSerial}${serialNote}`);
    } else if (text.includes('Date / 日期')) {
      await putBlock(blockId, `Date / 日期：${now}`);
    } else if (text.includes('Hour Meter')) {
      await putBlock(blockId, `Hour Meter / 小时数：${v.hours ?? ''}`);
    } else if (text.includes('Customer') || text.includes('客户')) {
      await putBlock(blockId, `Customer / 客户：${pl.customer ?? ''}`);
    } else if (text.includes('Invoice') || text.includes('发票') || text.includes('Order No')) {
      await putBlock(blockId, `Invoice No. / 发票号：${pl.invoiceNumber ?? ''}`);
    }
  }
}

export async function updateTextMessage(messageId, text, env) {
  const token = await getToken(env);
  const resp = await fetch(
    `${env.LARK_API_URL}/im/v1/messages/${messageId}/content`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: JSON.stringify({ text }),
      }),
    },
  );
  const data = await resp.json();
  if (data.code !== 0) console.error('[lark] updateTextMessage failed:', JSON.stringify(data));
  return data;
}

// ─── Item Result Card ─────────────────────────────────────────────────────────

/**
 * 发送单张图片的分析结果卡片（引用原图，带 OK/NG/Correction 按键）
 */
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

/**
 * 更新已发送的 item 卡片
 */
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
        {
          tag: 'button', type: 'danger',
          text: { tag: 'plain_text', content: '确认 NG' },
          value: { action: 'IMG_NG_SUBMIT', itemId },
          form_value: { ng_note: '' },
        },
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: '取消' },
          value: { action: 'IMG_CANCEL', itemId },
        },
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
        {
          tag: 'button', type: 'primary',
          text: { tag: 'plain_text', content: '提交修正' },
          value: { action: 'IMG_CORRECT_SUBMIT', itemId },
          form_value: { correction_note: '' },
        },
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: '取消' },
          value: { action: 'IMG_CANCEL', itemId },
        },
      ],
    });
  } else if (status === 'pending' || status === 'ok') {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: 'OK ✓' },
          value: { action: 'IMG_OK', itemId },
        },
        {
          tag: 'button', type: 'danger',
          text: { tag: 'plain_text', content: 'NG ✗' },
          value: { action: 'IMG_NG', itemId },
        },
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: '修正 ✏️' },
          value: { action: 'IMG_CORRECT', itemId },
        },
      ],
    });
  } else if (status === 'ng' || status === 'corrected') {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: '重新编辑' },
          value: { action: 'IMG_CORRECT', itemId },
        },
        {
          tag: 'button', type: 'default',
          text: { tag: 'plain_text', content: '标回 OK' },
          value: { action: 'IMG_OK', itemId },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title:    { tag: 'plain_text', content: h.badge },
      template: h.color,
    },
    elements,
  };
}
