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

  // btoa in Workers supports this pattern for binary data
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const mediaType = contentType.split(';')[0].trim();

  return { base64, mediaType };
}

// ─── Message ──────────────────────────────────────────────────────────────────

export async function sendMessage(chatId, text, env) {
  const token = await getToken(env);

  const res = await fetch(`${env.LARK_API_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
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
