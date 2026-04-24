/**
 * Lark Report Generator - Stable Version (Session Guarded)
 */

// =====================
// 工具函数 (Utils)
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
  const aesKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, data);
  return JSON.parse(new TextDecoder().decode(decrypted).replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
  }
  return btoa(binary);
}

// =====================
// Lark API 交互
// =====================

async function getToken(env) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

// 发送引导卡片 (当无 Session 时)
async function sendGuideCard(chatId, token) {
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        header: { title: { tag: "plain_text", content: "🔍 未检测到进行中的 Report" } },
        elements: [
          { tag: "div", text: { tag: "plain_text", content: "目前没有正在进行的会话，请选择要生成的报告类型以开始：" } },
          {
            tag: "action",
            actions: [
              { tag: "button", text: { tag: "plain_text", content: "PD Report" }, type: "primary", value: { type: "PD", action: "start" } },
              { tag: "button", text: { tag: "plain_text", content: "Service Report" }, type: "default", value: { type: "Service", action: "start" } }
            ]
          }
        ]
      })
    })
  });
}

async function reply(messageId, text, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) })
  });
}

// =====================
// Gemini AI 识别
// =====================

async function askGemini(imageBuffer, env) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const base64Image = arrayBufferToBase64(imageBuffer);
  const prompt = "识别这张工程机械图片，如果是铭牌返回 Model/Serial/VIN，如果是仪表返回 Hours，否则说明部件。简洁返回，不要解释。";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64Image } }] }]
    })
  });
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "识别失败";
}

// =====================
// Worker 主程序
// =====================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Running");

    let body = await request.json();
    if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    const event = body.event;
    // 处理卡片点击 (card.action.trigger)
    const isCardAction = body.action && body.action.value;
    const chatId = event?.message?.chat_id || body.action?.open_chat_id;
    const token = await getToken(env);

    ctx.waitUntil((async () => {
      try {
        // 1. 处理开始指令 (文字或卡片点击)
        let startType = null;
        if (isCardAction && body.action.value.action === "start") {
          startType = body.action.value.type;
        } else if (event?.message?.message_type === "text") {
          const text = JSON.parse(event.message.content).text.toLowerCase();
          if (text.includes("start") || text.includes("开始")) startType = "PD";
        }

        if (startType) {
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify({
            report_type: startType,
            status: "collecting",
            images: [],
            notes: [],
            start_at: Date.now()
          }), { expirationTtl: 86400 });
          
          const msg = `🚀 已开启 ${startType} Report 会话！\n现在您可以发送现场图片或输入备注信息。完成后输入“结束”。`;
          if (event?.message?.message_id) await reply(event.message.message_id, msg, token);
          else await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: msg }) })
          });
          return;
        }

        // 2. 检查 Session 准入
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        if (!sessionRaw && event) {
          await sendGuideCard(chatId, token);
          return;
        }
        const session = JSON.parse(sessionRaw || "{}");

        // 3. 处理结束
        if (event?.message?.message_type === "text") {
          const text = JSON.parse(event.message.content).text;
          if (text === "结束" || text === "end") {
            await reply(event.message.message_id, `✅ Report 已锁定\n类型: ${session.report_type}\n图片: ${session.images?.length || 0}\n备注: ${session.notes?.length || 0}\n(即将生成文档...)`, token);
            await env.REPORT_SESSIONS.delete(chatId);
            return;
          }
          // 记录备注
          session.notes = session.notes || [];
          session.notes.push({ text, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await reply(event.message.message_id, "✍️ 备注已加入 Report", token);
        }

        // 4. 处理图片
        if (event?.message?.message_type === "image") {
          const imageKey = JSON.parse(event.message.content).image_key;
          const imgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${event.message.message_id}/resources/${imageKey}?type=image`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const result = await askGemini(await imgRes.arrayBuffer(), env);
          
          session.images = session.images || [];
          session.images.push({ imageKey, result, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await reply(event.message.message_id, `📸 图片已记录\n识别结果：${result}`, token);
        }

      } catch (e) {
        console.error("Worker Error:", e.message);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};