export async function getLarkToken(env) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark Token Error: ${data.msg}`);
  return data.tenant_access_token;
}

export async function sendLarkMessage(chatId, content, token, msgType = 'text', replyId = null) {
  const payload = {
    receive_id: chatId,
    msg_type: msgType,
    content: JSON.stringify(content)
  };

  // reply_message_id 会触发飞书原文引用样式
  if (replyId) payload.reply_message_id = replyId;

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  return res.json();
}

export async function sendGuideCard(chatId, token) {
  const content = {
    header: { title: { tag: 'plain_text', content: '🔍 请选择 Report 类型' }, template: 'blue' },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '当前不在 session 内。\n请点击下面按钮选择进入：**PD** 或 **Service**。'
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'PD' },
            type: 'primary',
            value: { action: 'start', type: 'PD' }
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Service' },
            type: 'default',
            value: { action: 'start', type: 'Service' }
          }
        ]
      }
    ]
  };

  return sendLarkMessage(chatId, content, token, 'interactive');
}

export async function sendConflictCard(chatId, token, existingType) {
  const content = {
    header: { title: { tag: 'plain_text', content: '⚠️ 会话冲突' }, template: 'orange' },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `检测到你有一个进行中的 **${existingType}** session。\n如需重新开始，请先发送 **结束/END**。`
        }
      }
    ]
  };

  return sendLarkMessage(chatId, content, token, 'interactive');
}
