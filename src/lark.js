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

// 增加了 replyId 参数支持
export async function sendLarkMessage(chatId, content, token, msgType = "text", replyId = null) {
  const body = {
    receive_id: chatId,
    msg_type: msgType,
    content: JSON.stringify(content)
  };
  
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
 * 引导卡片
 */
export async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: "plain_text", content: "🔍 任务助手" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "当前没有进行中的任务，请选择类型开始：" } },
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
 * 会话冲突检查卡片
 */
export async function sendConflictCard(chatId, token, existingType) {
  const content = {
    header: { title: { tag: "plain_text", content: "⚠️ 会话冲突" }, template: "orange" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `检测到你有一个正在进行的 **${existingType}** 任务。\n直接发送图片即可继续，是否要放弃它并开启新任务？` } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "继续当前任务" }, type: "primary", value: { action: "continue" } },
          { tag: "button", text: { tag: "plain_text", content: "覆盖并开启新任务" }, type: "danger", value: { action: "force_start" } }
        ]
      }
    ]
  };
  return await sendLarkMessage(chatId, content, token, "interactive");
}