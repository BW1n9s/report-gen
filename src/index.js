/**
 * Lark Report Generator - Schema 2.0 完整实现版
 */

// =====================
// 1. 工具函数
// =====================
function b64ToUint8Array(base64) { return new Uint8Array(atob(base64).split("").map(c => c.charCodeAt(0))); }
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
  }
  return btoa(binary);
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

// =====================
// 2. Lark API 调用封装
// =====================
async function getLarkToken(env) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

async function sendLarkMsg(chatId, content, token, isCard = false) {
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: isCard ? "interactive" : "text",
      content: isCard ? JSON.stringify(content) : JSON.stringify({ text: content })
    })
  });
}

// =====================
// 3. AI 识别逻辑 (Gemini)
// =====================
async function askGemini(imageBuffer, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-1.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const prompt = `你是工程机械专家。识别图片中的铭牌或仪表。
必须返回严格的JSON格式，包含以下字段：
{
  "type": "nameplate/dashboard/part",
  "model": "型号",
  "vin": "VIN码或序列号",
  "hours": "小时数",
  "description": "内容描述"
}
如果没有识别到某项，请留空。不准编造。`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: arrayBufferToBase64(imageBuffer) } }
          ]
        }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });
    const data = await res.json();
    return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  } catch (e) {
    console.error("Gemini Error:", e);
    return { description: "识别失败" };
  }
}

// =====================
// 4. Worker 主逻辑
// =====================
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    
    let body = await request.json();
    if (body.encrypt) body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    // 精准提取 Chat ID (兼容卡片动作与消息)
    const chatId = body.event?.message?.chat_id || body.event?.operator?.open_id || body.open_chat_id;
    const token = await getLarkToken(env);

    if (!chatId) return new Response("No Chat ID", { status: 200 });

    ctx.waitUntil((async () => {
      try {
        // --- 场景 A: 处理卡片点击（开始会话） ---
        const cardAction = body.event?.action || body.action;
        if (cardAction?.value?.action === "start") {
          const type = cardAction.value.type;
          const initialSession = {
            report_type: type,
            status: "collecting",
            extracted: { model: "", vin: "", hours: "", date: new Date().toISOString().split('T')[0] },
            images: [],
            notes: []
          };
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(initialSession), { expirationTtl: 86400 });
          await sendLarkMsg(chatId, `✅ 已开启 ${type} 会话！\n请发送设备照片（铭牌/仪表/外观）或直接回复文字备注。输入“结束”完成。`, token);
          return;
        }

        // --- 场景 B: 检查 Session 状态 ---
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        if (!sessionRaw) {
          // 如果没有进行中的 session，且不是开始命令，则下发引导卡片
          if (body.event?.message?.content?.includes("start") || body.event?.message?.content?.includes("开始")) {
            await sendGuideCard(chatId, token);
          }
          return;
        }
        let session = JSON.parse(sessionRaw);

        // --- 场景 C: 处理用户消息 ---
        if (body.event?.message) {
          const msg = body.event.message;
          const messageId = msg.message_id;

          // 1. 处理文字消息
          if (msg.message_type === "text") {
            const text = JSON.parse(msg.content).text.trim();

            if (text === "结束" || text === "end") {
              // 检查关键字段完整性
              const missing = [];
              if (!session.extracted.model) missing.push("Model");
              if (!session.extracted.vin) missing.push("VIN");
              if (!session.extracted.hours) missing.push("Hours");

              if (missing.length > 0) {
                await sendLarkMsg(chatId, `⚠️ 信息未完整，缺失：${missing.join(", ")}\n是否强制生成文档？（目前已记录 ${session.images.length} 张图）`, token);
                // 这里可以后续对接确认生成的按钮
              } else {
                await sendLarkMsg(chatId, `🚀 信息完整！正在生成 Lark 文档，请稍后...`, token);
              }
              
              // 模拟文档生成结束（此处应调用文档 API）
              // await generateLarkDoc(session, env, token);
              await env.REPORT_SESSIONS.delete(chatId);
              return;
            }

            // 记录为 Notes
            session.notes.push({ text, ts: Date.now() });
            // 简单逻辑：如果文字包含 "vin:" 或 "model:" 则手动更新 extracted
            if (text.toLowerCase().includes("vin")) session.extracted.vin = text.split(/[:：]/)[1] || session.extracted.vin;
            
            await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
            await replyLark(messageId, "✍️ 已记录备注", token);
          }

          // 2. 处理图片消息
          if (msg.message_type === "image") {
            const imageKey = JSON.parse(msg.content).image_key;
            // 获取图片流
            const imgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            
            const aiResult = await askGemini(await imgRes.arrayBuffer(), env);
            
            // 更新 session 数据
            session.images.push({ imageKey, result: aiResult, ts: Date.now() });
            // 合并提取出的字段（若 AI 识别到了新字段则填充）
            if (aiResult.model) session.extracted.model = aiResult.model;
            if (aiResult.vin) session.extracted.vin = aiResult.vin;
            if (aiResult.hours) session.extracted.hours = aiResult.hours;

            await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
            
            const replyText = `📸 图片已收录\n识别类型: ${aiResult.type || '未知'}\n识别结果: ${aiResult.model || ''} ${aiResult.vin || ''}\n说明: ${aiResult.description || '无'}`;
            await replyLark(messageId, replyText, token);
          }
        }
      } catch (err) {
        console.error("Worker Execution Error:", err);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};

// =====================
// 5. 辅助 UI 函数
// =====================
async function sendGuideCard(chatId, token) {
  const card = {
    header: { title: { tag: "plain_text", content: "🔍 Report 生成助手" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "当前没有正在进行的会话，请选择报告类型开始：" } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "PD Report" }, type: "primary", value: { action: "start", type: "PD" } },
          { tag: "button", text: { tag: "plain_text", content: "Service Report" }, type: "default", value: { action: "start", type: "Service" } }
        ]
      }
    ]
  };
  await sendLarkMsg(chatId, card, token, true);
}

async function replyLark(messageId, text, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) })
  });
}