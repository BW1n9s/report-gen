export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "POST") {
        return json({ ok: true, message: "Lark Report Bot is running" });
      }

      const bodyText = await request.text();
      console.log("RAW BODY:", bodyText);

      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (e) {
        console.log("JSON parse error:", e.message);
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      console.log("EVENT TYPE:", body?.header?.event_type || body?.type);
      console.log("BODY KEYS:", Object.keys(body || {}).join(","));

      // 1. Lark URL verification
      if (body.type === "url_verification") {
        console.log("URL verification received");
        return json({ challenge: body.challenge });
      }

      // 2. 新版 Lark event wrapper
      const eventType = body?.header?.event_type;
      const event = body?.event || {};

      // 3. 收到普通消息：发开始卡片
      if (eventType === "im.message.receive_v1") {
        console.log("Message received");

        const openId = event?.sender?.sender_id?.open_id;
        const chatId = event?.message?.chat_id;

        console.log("openId:", openId);
        console.log("chatId:", chatId);

        if (!chatId) {
          console.log("No chat_id found");
          return json({ ok: true, message: "No chat_id" });
        }

        const token = await getTenantAccessToken(env);

        await sendStartCard(token, chatId);

        return json({ ok: true, handled: "im.message.receive_v1" });
      }

      // 4. 卡片按钮点击事件：新版常见类型
      if (
        eventType === "card.action.trigger" ||
        eventType === "card.action.trigger_v1" ||
        eventType === "im.message.message_card.action_v1"
      ) {
        console.log("Card action event received");

        await handleCardAction(env, body);

        return json({ ok: true, handled: eventType });
      }

      // 5. 有些 Lark 配置里按钮事件结构可能没有标准 event_type
      // 所以这里做兜底识别
      if (body?.event?.action || body?.action || body?.event?.operator) {
        console.log("Fallback card action detected");

        await handleCardAction(env, body);

        return json({ ok: true, handled: "fallback_card_action" });
      }

      console.log("Unhandled event:", JSON.stringify(body).slice(0, 1000));

      return json({
        ok: true,
        message: "Event received but not handled",
        event_type: eventType || body?.type || null,
      });
    } catch (err) {
      console.log("MAIN ERROR:", err?.stack || err?.message || String(err));
      return json(
        {
          ok: false,
          error: err?.message || String(err),
        },
        500
      );
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function getTenantAccessToken(env) {
  if (!env.LARK_APP_ID) {
    throw new Error("Missing env.LARK_APP_ID");
  }

  if (!env.LARK_APP_SECRET) {
    throw new Error("Missing env.LARK_APP_SECRET");
  }

  const res = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: env.LARK_APP_ID,
        app_secret: env.LARK_APP_SECRET,
      }),
    }
  );

  const data = await res.json();
  console.log("TOKEN RESPONSE:", JSON.stringify(data));

  if (!res.ok || data.code !== 0) {
    throw new Error("Failed to get tenant_access_token: " + JSON.stringify(data));
  }

  return data.tenant_access_token;
}

async function sendStartCard(token, chatId) {
  const card = {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Report Generator",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "请选择要生成的报告类型：\n\n- **PD Report**：适合 Pre-delivery / 新车检查\n- **Service Report**：适合维修、保养、故障检查",
        },
      },
      {
        tag: "hr",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "Start PD Report",
            },
            type: "primary",
            value: {
              action: "start_pd_report",
              report_type: "PD",
            },
          },
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "Start Service Report",
            },
            type: "default",
            value: {
              action: "start_service_report",
              report_type: "SERVICE",
            },
          },
        ],
      },
    ],
  };

  const res = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    }
  );

  const data = await res.json();
  console.log("SEND START CARD RESPONSE:", JSON.stringify(data));

  if (!res.ok || data.code !== 0) {
    throw new Error("Failed to send start card: " + JSON.stringify(data));
  }

  return data;
}

async function handleCardAction(env, body) {
  console.log("HANDLE CARD ACTION BODY:", JSON.stringify(body).slice(0, 3000));

  const token = await getTenantAccessToken(env);

  const event = body?.event || {};

  const actionObj =
    event?.action ||
    body?.action ||
    event?.card?.action ||
    body?.card?.action ||
    {};

  const value =
    actionObj?.value ||
    actionObj?.option ||
    actionObj ||
    {};

  const action =
    value?.action ||
    value?.key ||
    actionObj?.trigger_key ||
    actionObj?.name ||
    body?.action ||
    "";

  const reportType =
    value?.report_type ||
    value?.reportType ||
    "";

  const openId =
    event?.operator?.operator_id?.open_id ||
    event?.operator?.open_id ||
    event?.sender?.sender_id?.open_id ||
    body?.operator?.operator_id?.open_id ||
    body?.operator?.open_id ||
    "";

  const chatId =
    event?.context?.open_chat_id ||
    event?.context?.chat_id ||
    event?.open_chat_id ||
    event?.message?.chat_id ||
    body?.open_chat_id ||
    body?.chat_id ||
    "";

  console.log("Parsed action:", action);
  console.log("Parsed reportType:", reportType);
  console.log("Parsed openId:", openId);
  console.log("Parsed chatId:", chatId);

  let selectedType = "";

  if (action === "start_pd_report" || reportType === "PD") {
    selectedType = "PD";
  }

  if (action === "start_service_report" || reportType === "SERVICE") {
    selectedType = "SERVICE";
  }

  if (!selectedType) {
    console.log("Unknown button action");
    if (openId) {
      await sendTextToUser(token, openId, "收到按钮点击，但没有识别出报告类型。请检查 button value。");
    }
    return;
  }

  const displayName =
    selectedType === "PD" ? "PD Report" : "Service Report";

  // 这里先用文字确认按钮逻辑已经通了
  // 后面再接图片识别、状态存储、生成 Lark Doc
  const message =
    `已选择：${displayName}\n\n` +
    `请继续在聊天里发送车辆图片。\n` +
    `可以发送：铭牌、仪表、整车、轮胎、电池、液压部件、损坏部件等。\n\n` +
    `发送完成后，之后可以再加一个“生成报告”按钮或文字指令来生成文档。`;

  if (openId) {
    await sendTextToUser(token, openId, message);
  } else if (chatId) {
    await sendTextToChat(token, chatId, message);
  } else {
    console.log("No openId or chatId available, cannot reply.");
  }
}

async function sendTextToUser(token, openId, text) {
  console.log("sendTextToUser:", openId, text);

  const res = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({
          text,
        }),
      }),
    }
  );

  const data = await res.json();
  console.log("SEND TEXT USER RESPONSE:", JSON.stringify(data));

  if (!res.ok || data.code !== 0) {
    throw new Error("Failed to send text to user: " + JSON.stringify(data));
  }

  return data;
}

async function sendTextToChat(token, chatId, text) {
  console.log("sendTextToChat:", chatId, text);

  const res = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({
          text,
        }),
      }),
    }
  );

  const data = await res.json();
  console.log("SEND TEXT CHAT RESPONSE:", JSON.stringify(data));

  if (!res.ok || data.code !== 0) {
    throw new Error("Failed to send text to chat: " + JSON.stringify(data));
  }

  return data;
}