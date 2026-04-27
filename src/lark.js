// src/lark.js
export async function getLarkToken(env) {
  const res = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

export async function sendLarkMessage(chatId, content, token, msgType = "text") {
  return await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) })
  });
}

// TODO: 实现 README 中的生成 Lark Doc 逻辑
export async function createLarkDoc(session, token) {
  // 按照 README 第七步实现：upload media -> 拿 token -> 插入 block
}