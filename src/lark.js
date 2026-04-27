// src/lark.js

export async function getLarkToken(env) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark Token Error: ${data.msg}`);
  return data.tenant_access_token;
}

// 核心修改：接收 replyId 並傳給 Lark API
export async function sendLarkMessage(chatId, content, token, msgType = "text", replyId = null) {
  const body = {
    receive_id: chatId,
    msg_type: msgType,
    content: JSON.stringify(content)
  };
  
  // 如果有 replyId，Lark 會自動將這條訊息識別為引用回覆
  if (replyId) {
    body.reply_message_id = replyId;
  }

  return await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

/**
 * 引導卡片
 */
export async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: "plain_text", content: "🔍 任務助手" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "當前沒有進行中的任務，請選擇類型開始：" } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "PD Report" }, type: "primary", value: { action: "start", type: "PD" } },
          { tag: "button", text: { tag: "plain_text", content: "Service Report" }, type: "default", value: { action: "start", type: "Service" } }
        ]
      }
    ]
  };
  return await sendLarkMessage(chatId, content, token, "interactive");
}

/**
 * 會話衝突檢查卡片
 */
export async function sendConflictCard(chatId, token, existingType) {
  const content = {
    header: { title: { tag: "plain_text", content: "⚠️ 會話衝突" }, template: "orange" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `檢測到你有一個正在進行的 **${existingType}** 任務。\n直接發送圖片即可繼續，是否要放棄它並開啟新任務？` } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "繼續當前任務" }, type: "primary", value: { action: "continue" } },
          { tag: "button", text: { tag: "plain_text", content: "覆蓋並開啟新任務" }, type: "danger", value: { action: "force_start" } }
        ]
      }
    ]
  };
  return await sendLarkMessage(chatId, content, token, "interactive");
}