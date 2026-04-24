/**
 * Lark Report Generator - Multi-path ID Recovery (Final)
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
// Lark API
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
          { tag: "div", text: { tag: "plain_text", content: "目前没有正在进行的会话，请点击按钮开始：" } },
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

async function sendTextMsg(chatId, text, token) {
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) })
  });
}

// =====================
// Gemini AI
// =====================

async function askGemini(imageBuffer, env) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const base64Image = arrayBufferToBase64(imageBuffer);
  const prompt = "识别这张工程机械图片，返回 Model/Serial/VIN 或 Hours，简洁返回。";
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
// Worker
// =====================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");

    let body = await request.json();

    if (body.encrypt) {
      try {
        body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
      } catch (e) {
        return new Response("Decrypt Failed", { status: 500 });
      }
    }

    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    // ⭐ 最终极的 ID 搜寻路径 (按优先级排序)
    const chatId = 
      body.action?.open_chat_id || 
      body.open_chat_id || 
      body.context?.open_chat_id || 
      body.action?.context?.open_chat_id || 
      body.event?.message?.chat_id;

    const isCardAction = !!(body.action || body.schema === "2.0");
    const messageId = body.event?.message?.message_id;

    console.log(`[Debug] isCard=${isCardAction}, ChatID=${chatId}`);

    if (!chatId) {
      console.log("[Critical] ID still missing. Full Body:", JSON.stringify(body));
      return new Response(JSON.stringify({ code: 0 }));
    }

    const token = await getToken(env);

    ctx.waitUntil((async () => {
      try {
        // --- 逻辑 1: 处理卡片按钮点击 ---
        // 兼容 body.action.value 或直接 body.action (取决于飞书协议版本)
        const actionValue = body.action?.value || body.action;
        
        if (isCardAction && actionValue?.action === "start") {
          const startType = actionValue.type;
          console.log(`[Flow] Initializing ${startType} session for ${chatId}`);
          
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify({
            report_type: startType,
            status: "collecting",
            images: [],
            notes: [],
            start_at: Date.now()
          }), { expirationTtl: 86400 });
          
          await sendTextMsg(chatId, `🚀 已开启 ${startType} Report 会话！\n请发送图片或备注，完成后输入“结束”。`, token);
          return;
        }

        // --- 逻辑 2: 准入与业务流程 ---
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        if (!sessionRaw) {
          await sendGuideCard(chatId, token);
          return;
        }
        const session = JSON.parse(sessionRaw);

        // 文字处理
        if (body.event?.message?.message_type === "text") {
          const text = JSON.parse(body.event.message.content).text;
          if (text === "结束" || text === "end") {
            await sendTextMsg(chatId, `✅ 结束！已记录 ${session.images?.length || 0} 图。`, token);
            await env.REPORT_SESSIONS.delete(chatId);
            return;
          }
          session.notes = session.notes || [];
          session.notes.push({ text, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: "✍️ 已记录" }) })
          });
        }

        // 图片处理
        if (body.event?.message?.message_type === "image") {
          const imageKey = JSON.parse(body.event.message.content).image_key;
          const imgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const result = await askGemini(await imgRes.arrayBuffer(), env);
          session.images = session.images || [];
          session.images.push({ imageKey, result, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: `📸 已记录\n识别：${result}` }) })
          });
        }
      } catch (e) {
        console.error("Runtime Error:", e.message);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};