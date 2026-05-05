// ─── Token ────────────────────────────────────────────────────────────────────

export async function getToken(env) {
  const res = await fetch(`${env.LARK_API_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`getToken failed: ${data.msg}`);
  return data.tenant_access_token;
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
// sendCard({ header: { title, style }, body, buttons: [{ label, action, type }] })
// style: blue | green | yellow | red | grey
// button type: primary | default | danger

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
        value: { action: btn.action },
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

/**
 * Update the text content of an existing message in-place.
 * Lark API: PUT /im/v1/messages/{message_id}/content
 */
// ─── Lark Docs (docx) ─────────────────────────────────────────────────────────

/**
 * Copy a docx template into the bot's root folder with a new title.
 * Requires drive:file permission and the template shared to the bot.
 * Returns { token, url, name } from the Lark Drive API response.
 */
export async function copyDocumentToRoot(docToken, title, env) {
  const token = await getToken(env);
  const res = await fetch(`${env.LARK_API_URL}/drive/v1/files/${docToken}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: title, type: 'docx', folder_token: '' }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`copyDocumentToRoot failed (${data.code}): ${data.msg}`);
  return data.data.file; // { token, url, name, ... }
}

/**
 * Append plain-text report lines as paragraph blocks to a docx document.
 * Uses the Lark docx v1 batch_create blocks API.
 */
export async function appendReportBlocks(documentId, reportText, env) {
  const token = await getToken(env);
  const lines = reportText.split('\n').filter(l => l.trim());
  const children = lines.map(line => ({
    block_type: 2, // paragraph
    paragraph: {
      elements: [{ type: 'text_run', text_run: { content: line } }],
    },
  }));

  const res = await fetch(
    `${env.LARK_API_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_create`,
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
