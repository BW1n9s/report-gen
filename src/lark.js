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

export async function sendLarkMessage(chatId, content, token, msgType = "text") {
  return await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) })
  });
}

export async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: "plain_text", content: "🔍 未检测到进行中的 Report" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "目前没有正在进行的会话，请点击按钮开始：" } },
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