const LARK_API = "https://open.feishu.cn/open-apis";

export async function getLarkToken(env) {
  const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark Token Error: ${data.msg}`);
  return data.tenant_access_token;
}

// Send a new message to a chat (no quote)
export async function sendLarkMessage(chatId, content, token, msgType = "text") {
  const res = await fetch(`${LARK_API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content)
    })
  });
  return await res.json();
}

// Reply to a specific message — Lark shows the original message quoted above the reply
export async function replyLarkMessage(messageId, content, token, msgType = "text") {
  if (!messageId) return null;
  const res = await fetch(`${LARK_API}/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      content: JSON.stringify(content),
      msg_type: msgType
    })
  });
  return await res.json();
}

export async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: "plain_text", content: "🔍 任务助手" } },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: "当前没有进行中的任务，请选择报告类型：" }
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "PD Report" },
            type: "primary",
            value: { action: "start", type: "PD" }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Service Report" },
            type: "default",
            value: { action: "start", type: "Service" }
          }
        ]
      }
    ]
  };
  return await sendLarkMessage(chatId, content, token, "interactive");
}

// existingType: the session already running; newType: what the user just tried to start
export async function sendConflictCard(chatId, token, existingType, newType) {
  const content = {
    header: { title: { tag: "plain_text", content: "⚠️ 会话冲突" }, template: "orange" },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `检测到你有一个正在进行的 **${existingType}** 任务。\n是否要放弃它并开启新的 **${newType}** 任务？`
        }
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "继续当前任务" },
            type: "primary",
            value: { action: "continue" }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: `放弃并开启 ${newType}` },
            type: "danger",
            value: { action: "force_start", type: newType }
          }
        ]
      }
    ]
  };
  return await sendLarkMessage(chatId, content, token, "interactive");
}
