/**
 * Lark Report Generator - Fixed Card Interaction Version
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

// 发送引导卡片
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
          { tag: "div", text: { tag: "plain_text", content: "目前没有正在进行的会话，请点击下方按钮开始：" } },
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
    // 1. 解密
    if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    
    // 2. URL 验证
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    // 3. 提取核心 ID (兼容事件流和卡片交互流)
    const isCardAction = !!body.action;
    const chatId = isCardAction ? body.open_chat_id : body.event?.message?.chat_id;
    const messageId = body.event?.message?.message_id;

    if (!chatId) return new Response(JSON.stringify({ code: 0 }));

    const token = await getToken(env);

    // 使用 waitUntil 异步处理耗时任务
    ctx.waitUntil((async () => {
      try {
        // --- A. 处理开始指令 (卡片点击或文字) ---
        let startType = null;
        if (isCardAction && body.action.value?.action === "start") {
          startType = body.action.value.type;
        } else if (body.event?.message?.message_type === "text") {
          const text = JSON.parse(body.event.message.content).text.toLowerCase();
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
          
          const msg = `🚀 已开启 ${startType} Report 会话！\n请发送图片或备注信息，完成后输入“结束”。`;
          await sendTextMsg(chatId, msg, token);
          return;
        }

        // --- B. 准入检查 ---
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        if (!sessionRaw) {
          // 如果没有 Session 且不是正在尝试“开始”，则发送引导
          await sendGuideCard(chatId, token);
          return;
        }
        const session = JSON.parse(sessionRaw);

        // --- C. 处理结束 ---
        if (body.event?.message?.message_type === "text") {
          const text = JSON.parse(body.event.message.content).text;
          if (text === "结束" || text === "end") {
            await reply(messageId, `✅ 会话已结束\n记录了 ${session.images?.length || 0} 张图片和 ${session.notes?.length || 0} 条备注。\n(正在清理会话...)`, token);
            await env.REPORT_SESSIONS.delete(chatId);
            return;
          }
          // 记录备注
          session.notes = session.notes || [];
          session.notes.push({ text, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await reply(messageId, "✍️ 备注已加入 Report", token);
        }

        // --- D. 处理图片 ---
        if (body.event?.message?.message_type === "image") {
          const imageKey = JSON.parse(body.event.message.content).image_key;
          const imgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const result = await askGemini(await imgRes.arrayBuffer(), env);
          
          session.images = session.images || [];
          session.images.push({ imageKey, result, ts: Date.now() });
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
          await reply(messageId, `📸 图片已记录\n识别结果：${result}`, token);
        }

      } catch (e) {
        console.error("Worker Execution Error:", e.message);
      }
    })());

    // 必须立即返回，否则 Lark 会认为超时
    return new Response(JSON.stringify({ code: 0 }));
  }
};