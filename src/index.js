/**
 * Lark Report Generator - v2.1 修复 Session 丢失与识别为空问题
 */

// =====================
// 1. 基础工具 (保持高效)
// =====================
const b64ToUint8Array = (base) => new Uint8Array(atob(base).split("").map(c => c.charCodeAt(0)));
const arrayBufferToBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

// =====================
// 2. 核心逻辑：ID 提取器 (解决找不到 Session 的关键)
// =====================
function getUnifiedId(body) {
  // 1. 消息事件中的 ID
  if (body.event?.message?.chat_id) return body.event.message.chat_id;
  // 2. 卡片交互中的 ID
  if (body.event?.context?.open_chat_id) return body.event.context.open_chat_id;
  if (body.open_chat_id) return body.open_chat_id;
  // 3. 其他操作者 ID 兜底
  if (body.event?.operator?.open_id) return body.event.operator.open_id;
  return null;
}

// =====================
// 3. AI 识别优化 (针对铭牌图片)
// =====================
async function askGemini(imageBuffer, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-1.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const prompt = `你是一个工程机械专家。请识别图片中的铭牌信息或仪表盘数据。
必须返回 JSON 格式，字段如下：
{
  "type": "nameplate/dashboard/other",
  "model": "型号/Model",
  "vin": "序列号/VIN/Serial No",
  "hours": "小时数/Hours",
  "description": "简短描述内容"
}
注意：如果某个字段无法辨认，请填空字符串 ""。不要编造数据。`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: arrayBufferToBase64(imageBuffer) } }] }],
        generationConfig: { response_mime_type: "application/json" } // 强制 JSON
      })
    });
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(text);
  } catch (e) {
    return { description: "识别失败", error: e.message };
  }
}

// =====================
// 4. Worker 主程序
// =====================
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");
    
    let body = await request.json();
    if (body.encrypt) {
      // 这里的 decrypt 函数需要配合你的 FEISHU_ENCRYPT_KEY
      const b64ToUint8Array = (base64) => new Uint8Array(atob(base64).split("").map(c => c.charCodeAt(0)));
      // ... (解密逻辑保持你之前的版本)
    }
    
    if (body.type === "url_verification") return new Response(JSON.stringify({ challenge: body.challenge }));

    const chatId = getUnifiedId(body);
    if (!chatId) return new Response("No ID", { status: 200 });

    const token = await (async () => {
      const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
      });
      const d = await res.json();
      return d.tenant_access_token;
    })();

    ctx.waitUntil((async () => {
      try {
        // --- 1. 处理卡片点击开始 ---
        const action = body.event?.action || body.action;
        if (action?.value?.action === "start") {
          const session = {
            report_type: action.value.type,
            status: "collecting",
            extracted: { model: "", vin: "", hours: "", date: new Date().toLocaleDateString() },
            images: [],
            notes: []
          };
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), { expirationTtl: 86400 });
          await sendText(chatId, `✅ ${action.value.type} 会话已开启！\n\n请发送：\n1. 铭牌照片（提取型号/VIN）\n2. 仪表盘照片（提取小时数）\n3. 备注文字\n\n完成后输入“结束”。`, token);
          return;
        }

        // --- 2. 检查 Session ---
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        
        // 如果没有 Session 且用户发送了非开始指令，弹出引导
        if (!sessionRaw) {
          const text = body.event?.message?.content ? JSON.parse(body.event.message.content).text : "";
          if (!text.includes("start")) {
            await sendGuideCard(chatId, token);
          }
          return;
        }

        let session = JSON.parse(sessionRaw);

        // --- 3. 处理具体消息 ---
        if (body.event?.message) {
          const msg = body.event.message;
          const messageId = msg.message_id;

          // 处理文本消息
          if (msg.message_type === "text") {
            const text = JSON.parse(msg.content).text.trim();

            if (text === "结束" || text === "end") {
              // 结束前汇总
              const summary = `🏁 收集完成！\n型号: ${session.extracted.model || '未识别'}\nVIN: ${session.extracted.vin || '未识别'}\n小时: ${session.extracted.hours || '未识别'}\n照片数: ${session.images.length}`;
              await sendText(chatId, summary + "\n\n正在生成 Lark 文档...", token);
              
              // TODO: 调用文档生成逻辑
              
              await env.REPORT_SESSIONS.delete(chatId);
              return;
            }

            // 记录备注
            session.notes.push({ text, ts: Date.now() });
            await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
            await replyMsg(messageId, "✍️ 已记录备注", token);
          }

          // 处理图片消息
          if (msg.message_type === "image") {
            const imageKey = JSON.parse(msg.content).image_key;
            await replyMsg(messageId, "🔍 正在识别图片，请稍候...", token);
            
            // 获取图片
            const imgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            
            const aiRes = await askGemini(await imgRes.arrayBuffer(), env);
            
            // 合并数据
            if (aiRes.model) session.extracted.model = aiRes.model;
            if (aiRes.vin) session.extracted.vin = aiRes.vin;
            if (aiRes.hours) session.extracted.hours = aiRes.hours;
            session.images.push({ imageKey, result: aiRes });
            
            await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
            
            const aiText = `📸 图片记录成功\n类型: ${aiRes.type}\n识别: ${aiRes.model || ''} ${aiRes.vin || ''}\n描述: ${aiRes.description}`;
            await replyMsg(messageId, aiText, token);
          }
        }
      } catch (err) {
        console.error("Critical Error:", err);
      }
    })());

    return new Response(JSON.stringify({ code: 0 }));
  }
};

// =====================
// 5. 辅助函数 (保持简单)
// =====================
async function sendText(chatId, text, token) {
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) })
  });
}

async function replyMsg(messageId, text, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) })
  });
}

async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: "plain_text", content: "🔍 任务助手" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "当前没有进行中的任务。请选择报告类型开始：" } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "PD Report" }, type: "primary", value: { action: "start", type: "PD" } },
          { tag: "button", text: { tag: "plain_text", content: "Service Report" }, type: "default", value: { action: "start", type: "Service" } }
        ]
      }
    ]
  };
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(content) })
  });
}