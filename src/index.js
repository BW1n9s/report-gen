/**
 * Lark Report Generator - Stable Version (Free Tier Safe)
 */

// =====================
// Utils
// =====================

function b64ToUint8Array(base64) {
  return new Uint8Array(atob(base64).split("").map(c => c.charCodeAt(0)));
}

async function decrypt(encrypt, key) {
  const encryptedBuffer = b64ToUint8Array(encrypt);
  const iv = encryptedBuffer.slice(0, 16);
  const data = encryptedBuffer.slice(16);

  const encoder = new TextEncoder();
  const keyBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, data);

  return JSON.parse(
    new TextDecoder().decode(decrypted).replace(/[\x00-\x1F\x7F-\x9F]/g, "")
  );
}

// ⭐ 安全 base64（不会爆栈）
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }

  return btoa(binary);
}

// =====================
// Lark API
// =====================

async function getToken(env) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET
    })
  });

  const data = await res.json();
  return data.tenant_access_token;
}

async function reply(messageId, text, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });
}

// =====================
// Session（关键修复：用 chat_id）
// =====================

function getSessionId(event) {
  return (
    event?.message?.chat_id ||
    event?.context?.open_chat_id ||
    "default_session"
  );
}

// =====================
// Gemini
// =====================

async function askGemini(imageBuffer, env) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const base64Image = arrayBufferToBase64(imageBuffer);

  const prompt = `
识别这张工程机械图片，返回简洁信息：

如果是铭牌：Model / Serial / VIN
如果是仪表：Hours
否则说明部件

只返回文本，不要解释
`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: base64Image
            }
          }
        ]
      }]
    })
  });

  const data = await res.json();

  if (data.error) return "❌ Gemini error: " + data.error.message;

  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "识别失败";
}

// =====================
// Worker
// =====================

export default {
  async fetch(request, env, ctx) {

    if (request.method !== "POST") {
      return new Response("Running");
    }

    let body = await request.json();

    // 解密
    if (body.encrypt) {
      body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    }

    // 验证
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    const event = body.event;

    if (!event) {
      return new Response(JSON.stringify({ code: 0 }));
    }

    const token = await getToken(env);
    const messageId = event.message.message_id;
    const sessionId = getSessionId(event);

    ctx.waitUntil((async () => {

      try {

        // =====================
        // TEXT
        // =====================

        if (event.message.message_type === "text") {

          const text = JSON.parse(event.message.content).text.toLowerCase();

          if (text.includes("start") || text.includes("开始")) {

            await env.REPORT_SESSIONS.put(sessionId, JSON.stringify({
              status: "collecting",
              images: [],
              notes: []
            }));

            await reply(messageId, "已开始 Report，请发送图片", token);
            return;
          }

          if (text.includes("end") || text.includes("结束")) {

            const session = JSON.parse(await env.REPORT_SESSIONS.get(sessionId) || "{}");

            await reply(messageId,
              `Report完成\n图片数量: ${session.images?.length || 0}\n备注数量: ${session.notes?.length || 0}`,
              token
            );

            return;
          }

          // 记录备注
          const session = JSON.parse(await env.REPORT_SESSIONS.get(sessionId) || "{}");
          session.notes.push(text);
          await env.REPORT_SESSIONS.put(sessionId, JSON.stringify(session));

          await reply(messageId, "备注已记录", token);
        }

        // =====================
        // IMAGE
        // =====================

        if (event.message.message_type === "image") {

          const content = JSON.parse(event.message.content);
          const imageKey = content.image_key;

          const imgRes = await fetch(
            `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          const buffer = await imgRes.arrayBuffer();

          const result = await askGemini(buffer, env);

          // 存 session
          const session = JSON.parse(await env.REPORT_SESSIONS.get(sessionId) || "{}");

          session.images.push({
            messageId,
            imageKey,
            result
          });

          await env.REPORT_SESSIONS.put(sessionId, JSON.stringify(session));

          await reply(messageId, `识别结果：\n${result}`, token);
        }

      } catch (e) {
        console.log("ERR:", e.message);
      }

    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};