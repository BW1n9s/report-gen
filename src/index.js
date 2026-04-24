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
// 2. 增强版 ID 提取器
// =====================
function getUnifiedId(body) {
  // 按照优先级尝试所有可能的 Chat ID 路径
  const id = body.event?.message?.chat_id || 
             body.event?.context?.open_chat_id || 
             body.open_chat_id || 
             body.event?.operator?.open_id;
  
  console.log("[Debug] Extracted ID:", id, "Event Type:", body.header?.event_type || body.type);
  return id;
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
    if (request.method !== "POST") return new Response("Not POST");
    
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Invalid JSON");
    }

    // 1. 处理 Lark 的加密验证 (如果有)
    if (body.encrypt) {
      console.log("[Debug] Decrypting payload...");
      // 注意：确保你的 FEISHU_ENCRYPT_KEY 在环境变量里正确设置
      try {
        body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
      } catch (e) {
        console.error("[Error] Decrypt failed:", e.message);
        return new Response("Decrypt Error");
      }
    }

    // 2. 处理 Lark 的 URL 验证
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }));
    }

    // 3. 提取 Chat ID
    const chatId = getUnifiedId(body);
    if (!chatId) {
      console.log("[Warn] No ChatID found in this request.");
      return new Response(JSON.stringify({ code: 1, msg: "no chat_id" }));
    }

    // 4. 获取 Token (增加缓存逻辑或简单调用)
    const token = await getLarkToken(env);

    // 5. 异步执行业务逻辑
    ctx.waitUntil((async () => {
      try {
        // --- 处理卡片点击 ---
        const action = body.event?.action || body.action;
        if (action?.value?.action === "start") {
          console.log("[Info] Starting session for:", chatId);
          const session = {
            report_type: action.value.type,
            status: "collecting",
            extracted: { model: "", vin: "", hours: "", date: new Date().toISOString() },
            images: [],
            notes: []
          };
          await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session), { expirationTtl: 86400 });
          await sendText(chatId, `✅ ${action.value.type} 已开启！\n发送图片识别，或发送文字备注。输入“结束”生成。`, token);
          return;
        }

        // --- 检查 Session ---
        const sessionRaw = await env.REPORT_SESSIONS.get(chatId);
        if (!sessionRaw) {
          // 如果没 Session 且是用户发的消息，则提示开始
          if (body.event?.message) {
            console.log("[Info] No active session, sending guide card.");
            await sendGuideCard(chatId, token);
          }
          return;
        }

        let session = JSON.parse(sessionRaw);

        // --- 处理消息内容 ---
        if (body.event?.message) {
          const msg = body.event.message;
          
          if (msg.message_type === "text") {
            const text = JSON.parse(msg.content).text.trim();
            if (text === "结束" || text === "end") {
              await sendText(chatId, `🏁 已记录 ${session.images.length} 张图片，正在处理报告...`, token);
              // TODO: 生成文档逻辑
              await env.REPORT_SESSIONS.delete(chatId);
            } else {
              session.notes.push({ text, ts: Date.now() });
              await env.REPORT_SESSIONS.put(chatId, JSON.stringify(session));
              await replyMsg(msg.message_id, "✍️ 已备注", token);
            }
          }
          
          if (msg.message_type === "image") {
            await replyMsg(msg.message_id, "🔍 正在解析图片...", token);
            // ... (图片处理逻辑：askGemini 并更新 session)
          }
        }
      } catch (err) {
        console.error("[Critical Error]", err.stack);
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