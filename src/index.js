
/**
 * Lark PD / Service Report Generator
 * Cloudflare Worker Free Tier Test Version
 *
 * Features:
 * - start / 开始
 * - choose PD Report or Service Report by card button
 * - receive images, identify by Gemini
 * - reply recognition result
 * - receive text notes/details
 * - end / 结束
 * - check missing model / vin or serial / hours
 * - confirm generate
 * - create Lark docx document
 * - insert original images into corresponding positions
 *
 * Required KV binding:
 * REPORT_SESSIONS
 *
 * Required ENV:
 * FEISHU_APP_ID
 * FEISHU_APP_SECRET
 * FEISHU_ENCRYPT_KEY
 * GEMINI_API_KEY
 * GEMINI_MODEL optional, default gemini-2.0-flash
 */

// =====================
// Crypto
// =====================

async function decrypt(encrypt, key) {
  const encryptedBuffer = b64ToUint8Array(encrypt);
  const iv = encryptedBuffer.slice(0, 16);
  const data = encryptedBuffer.slice(16);

  const encoder = new TextEncoder();
  const keyBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, data);
  const text = new TextDecoder()
    .decode(decrypted)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");

  return JSON.parse(text);
}

function b64ToUint8Array(base64) {
  return new Uint8Array(atob(base64).split("").map((c) => c.charCodeAt(0)));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// =====================
// Lark API
// =====================

async function getLarkToken(env) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });

  const data = await res.json();

  if (!data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${JSON.stringify(data)}`);
  }

  return data.tenant_access_token;
}

async function larkJsonFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.code !== 0) {
    throw new Error(`Lark API error: ${res.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function replyText(messageId, text, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
}

async function replyCard(messageId, card, token) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
}

async function downloadLarkImage(messageId, imageKey, token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Image download failed: ${res.status}`);
  }

  return await res.arrayBuffer();
}

// =====================
// Cards
// =====================

function startCard() {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Report Generator",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "请选择报告类型：",
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "PD Report",
            },
            value: {
              action: "start_report",
              report_type: "PD",
            },
          },
          {
            tag: "button",
            type: "default",
            text: {
              tag: "plain_text",
              content: "Service Report",
            },
            value: {
              action: "start_report",
              report_type: "Service",
            },
          },
        ],
      },
    ],
  };
}

function confirmEndCard(missingFields) {
  const content =
    missingFields.length > 0
      ? `发现以下关键内容缺失：\n\n${missingFields.map((x) => `- ${x}`).join("\n")}\n\n是否仍然生成报告？`
      : "关键字段已基本完整，是否生成报告？";

  return {
    config: { wide_screen_mode: true },
    header: {
      template: missingFields.length > 0 ? "orange" : "green",
      title: {
        tag: "plain_text",
        content: "Confirm Report Generation",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "确认生成",
            },
            value: {
              action: "confirm_generate",
            },
          },
          {
            tag: "button",
            type: "default",
            text: {
              tag: "plain_text",
              content: "继续补充",
            },
            value: {
              action: "continue_collecting",
            },
          },
          {
            tag: "button",
            type: "danger",
            text: {
              tag: "plain_text",
              content: "取消",
            },
            value: {
              action: "cancel_report",
            },
          },
        ],
      },
    ],
  };
}

// =====================
// Session
// =====================

function getUserId(event) {
  return (
    event?.sender?.sender_id?.open_id ||
    event?.sender?.sender_id?.user_id ||
    event?.operator?.operator_id?.open_id ||
    event?.operator?.operator_id?.user_id ||
    "unknown_user"
  );
}

function sessionKey(userId) {
  return `report_session:${userId}`;
}

async function getSession(env, userId) {
  const raw = await env.REPORT_SESSIONS.get(sessionKey(userId));
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(env, userId, session) {
  session.updated_at = new Date().toISOString();

  await env.REPORT_SESSIONS.put(sessionKey(userId), JSON.stringify(session), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
}

async function deleteSession(env, userId) {
  await env.REPORT_SESSIONS.delete(sessionKey(userId));
}

function createSession(userId, reportType) {
  return {
    user_id: userId,
    report_type: reportType,
    status: "collecting",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    extracted: {
      model: "",
      vin: "",
      serial_no: "",
      hours: "",
      date: "",
    },
    images: [],
    notes: [],
  };
}

function mergeExtracted(session, result) {
  const fields = ["model", "vin", "serial_no", "hours", "date"];

  for (const field of fields) {
    if (!session.extracted[field] && result[field]) {
      session.extracted[field] = result[field];
    }
  }

  return session;
}

function getMissingFields(session) {
  const missing = [];

  if (!session.extracted.model) missing.push("Model");
  if (!session.extracted.vin && !session.extracted.serial_no) missing.push("VIN / Serial No");
  if (!session.extracted.hours) missing.push("Hours");

  return missing;
}

// =====================
// Gemini
// =====================

async function askGemini(imageBuffer, env) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const base64Image = arrayBufferToBase64(imageBuffer);

  const prompt = `
你是一个工程机械 PD / Service Report 图片识别助手。

请识别现场照片，并只返回严格 JSON，不要 markdown，不要解释。

JSON 格式：
{
  "image_type": "铭牌 / 仪表 / 整车外观 / 零部件 / 故障部位 / 维修过程 / 其他",
  "summary_cn": "中文简短说明",
  "summary_en": "English short description",
  "model": "",
  "vin": "",
  "serial_no": "",
  "hours": "",
  "date": "",
  "details_en": "English report sentence based on this photo"
}

规则：
1. 如果是铭牌，提取 model, vin, serial_no, capacity, mast, attachment 等可见信息，放进 details_en。
2. 如果是仪表，提取 hour meter, fault code, battery status。
3. 如果是零部件或故障部位，说明部位和可见状态。
4. 不确定或看不清的字段留空。
5. 不要编造。
`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: base64Image,
              },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return parseGeminiJson(text);
}

function parseGeminiJson(text) {
  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return {
      image_type: "其他",
      summary_cn: cleaned,
      summary_en: cleaned,
      model: "",
      vin: "",
      serial_no: "",
      hours: "",
      date: "",
      details_en: cleaned,
    };
  }
}

// =====================
// Lark Docx
// =====================

async function createLarkDoc(session, token) {
  const today = new Date().toISOString().slice(0, 10);
  const model = safeTitle(session.extracted.model || "UnknownModel");
  const vin = safeTitle(session.extracted.vin || session.extracted.serial_no || "NoVIN");

  const title = `${session.report_type} Report_${model}_${vin}_${today}`;

  const createData = await larkJsonFetch(
    "https://open.feishu.cn/open-apis/docx/v1/documents",
    token,
    {
      method: "POST",
      body: JSON.stringify({ title }),
    }
  );

  const documentId = createData?.data?.document?.document_id;

  if (!documentId) {
    throw new Error(`Cannot get document_id: ${JSON.stringify(createData)}`);
  }

  await appendTextBlocks(documentId, documentId, buildHeaderLines(session, title), token);

  for (let i = 0; i < session.images.length; i++) {
    const img = session.images[i];

    await appendTextBlocks(
      documentId,
      documentId,
      [
        "",
        `Photo ${i + 1}`,
        `Type: ${img.image_type || ""}`,
        `Recognition: ${img.summary_en || img.summary_cn || ""}`,
      ],
      token
    );

    try {
      const imageBuffer = await downloadLarkImage(img.message_id, img.image_key, token);
      const mediaToken = await uploadImageToDoc(documentId, `photo_${i + 1}.jpg`, imageBuffer, token);
      await appendImageBlock(documentId, documentId, mediaToken, token);
    } catch (e) {
      await appendTextBlocks(
        documentId,
        documentId,
        [`[Image insert failed: ${e.message}]`],
        token
      );
    }

    await appendTextBlocks(
      documentId,
      documentId,
      [
        `Details: ${img.details_en || ""}`,
        "",
      ],
      token
    );
  }

  await appendTextBlocks(documentId, documentId, buildFinalReportLines(session), token);

  return {
    title,
    documentId,
    url: `https://feishu.cn/docx/${documentId}`,
  };
}

function safeTitle(text) {
  return String(text || "")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function buildHeaderLines(session, title) {
  const e = session.extracted;

  const notes = session.notes.length
    ? session.notes.map((n, i) => `${i + 1}. ${n.text}`)
    : ["No additional notes provided."];

  return [
    title,
    "",
    "Machine Information",
    `Report Type: ${session.report_type} Report`,
    `Model: ${e.model || ""}`,
    `VIN: ${e.vin || ""}`,
    `Serial No: ${e.serial_no || ""}`,
    `Hours: ${e.hours || ""}`,
    `Date: ${e.date || ""}`,
    "",
    "User Notes / Details",
    ...notes,
    "",
    "Photos and Recognition Results",
  ];
}

function buildFinalReportLines(session) {
  const e = session.extracted;

  const photoDetails = session.images
    .map((img, i) => `${i + 1}. ${img.details_en || img.summary_en || img.summary_cn || ""}`)
    .filter(Boolean);

  if (session.report_type === "PD") {
    return [
      "",
      "Draft PD Report",
      `Machine model ${e.model || "[model not provided]"} was inspected during the pre-delivery process.`,
      `VIN / Serial No: ${e.vin || e.serial_no || "[not provided]"}.`,
      `Hour meter: ${e.hours || "[not provided]"}.`,
      "The supplied photos and notes were reviewed and recorded as follows:",
      ...photoDetails,
      "Further manual inspection is recommended for any item not clearly visible in the supplied photos.",
    ];
  }

  return [
    "",
    "Draft Service Report",
    `Machine model ${e.model || "[model not provided]"} was inspected based on the supplied photos and user notes.`,
    `VIN / Serial No: ${e.vin || e.serial_no || "[not provided]"}.`,
    `Hour meter: ${e.hours || "[not provided]"}.`,
    "Observations and work details recorded from the supplied materials:",
    ...photoDetails,
    "Further diagnosis may be required if the fault cannot be confirmed from the supplied information.",
  ];
}

function textBlock(line) {
  return {
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: line,
            text_element_style: {},
          },
        },
      ],
      style: {},
    },
  };
}

async function appendTextBlocks(documentId, parentBlockId, lines, token) {
  const cleanLines = lines.map((line) => String(line ?? ""));

  const children = cleanLines.map((line) => textBlock(line || " "));

  if (!children.length) return;

  await larkJsonFetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ children }),
    }
  );
}

async function uploadImageToDoc(documentId, fileName, imageBuffer, token) {
  const form = new FormData();

  form.append("file_name", fileName);
  form.append("parent_type", "docx_image");
  form.append("parent_node", documentId);
  form.append("size", String(imageBuffer.byteLength));
  form.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), fileName);

  const res = await fetch("https://open.feishu.cn/open-apis/drive/v1/medias/upload_all", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.code !== 0) {
    throw new Error(`Upload image failed: ${res.status} ${JSON.stringify(data)}`);
  }

  const fileToken = data?.data?.file_token;

  if (!fileToken) {
    throw new Error(`No file_token returned: ${JSON.stringify(data)}`);
  }

  return fileToken;
}

async function appendImageBlock(documentId, parentBlockId, imageToken, token) {
  const children = [
    {
      block_type: 27,
      image: {
        token: imageToken,
      },
    },
  ];

  await larkJsonFetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ children }),
    }
  );
}

// =====================
// Message Handling
// =====================

async function handleTextMessage(event, env, token) {
  const messageId = event.message.message_id;
  const userId = getUserId(event);
  const text = JSON.parse(event.message.content).text.trim();
  const lower = text.toLowerCase();

  let session = await getSession(env, userId);

  if (["start", "开始", "report", "报告"].includes(lower)) {
    await replyCard(messageId, startCard(), token);
    return;
  }

  if (!session) {
    await replyText(
      messageId,
      "当前没有进行中的 report。\n\n请输入 start 或 开始，然后选择 PD Report / Service Report。",
      token
    );
    return;
  }

  if (["end", "结束", "done", "完成"].includes(lower)) {
    session.status = "confirming_end";
    await saveSession(env, userId, session);

    const missing = getMissingFields(session);
    await replyCard(messageId, confirmEndCard(missing), token);
    return;
  }

  if (["cancel", "取消"].includes(lower)) {
    await deleteSession(env, userId);
    await replyText(messageId, "已取消当前 report session。", token);
    return;
  }

  session.notes.push({
    text,
    message_id: messageId,
    created_at: new Date().toISOString(),
  });

  await saveSession(env, userId, session);

  await replyText(
    messageId,
    `已记录备注：\n${text}\n\n可以继续发送图片/文字，或输入 end 结束生成报告。`,
    token
  );
}

async function handleImageMessage(event, env, token) {
  const messageId = event.message.message_id;
  const userId = getUserId(event);

  let session = await getSession(env, userId);

  if (!session) {
    await replyText(
      messageId,
      "当前没有进行中的 report。\n\n请先输入 start 或 开始，然后选择 PD Report / Service Report。",
      token
    );
    return;
  }

  const content = JSON.parse(event.message.content);
  const imageKey = content.image_key;

  const imageBuffer = await downloadLarkImage(messageId, imageKey, token);
  const result = await askGemini(imageBuffer, env);

  session.images.push({
    message_id: messageId,
    image_key: imageKey,
    image_type: result.image_type || "",
    summary_cn: result.summary_cn || "",
    summary_en: result.summary_en || "",
    model: result.model || "",
    vin: result.vin || "",
    serial_no: result.serial_no || "",
    hours: result.hours || "",
    date: result.date || "",
    details_en: result.details_en || "",
    created_at: new Date().toISOString(),
  });

  session = mergeExtracted(session, result);
  await saveSession(env, userId, session);

  const reply = `
🔍 图片识别完成

类型：${result.image_type || "未确定"}
说明：${result.summary_cn || ""}

提取信息：
Model: ${result.model || session.extracted.model || ""}
VIN: ${result.vin || session.extracted.vin || ""}
Serial No: ${result.serial_no || session.extracted.serial_no || ""}
Hours: ${result.hours || session.extracted.hours || ""}
Date: ${result.date || session.extracted.date || ""}

Report Details:
${result.details_en || ""}

如需修正，直接回复文字备注即可。
继续发送图片，或输入 end 结束生成报告。
`;

  await replyText(messageId, reply, token);
}

async function handleCardAction(body, env, token) {
  const action = body?.event?.action?.value || {};
  const actionName = action.action;
  const reportType = action.report_type;

  const userId = getUserId(body.event);
  const openMessageId = body?.event?.context?.open_message_id;

  if (!openMessageId) return;

  if (actionName === "start_report") {
    const session = createSession(userId, reportType);
    await saveSession(env, userId, session);

    await replyText(
      openMessageId,
      `已开始 ${reportType} Report。\n\n现在可以发送现场图片。图片顺序不限，也可以直接发送文字 details。完成后输入 end。`,
      token
    );
    return;
  }

  const session = await getSession(env, userId);

  if (!session) {
    await replyText(openMessageId, "当前没有进行中的 report session。", token);
    return;
  }

  if (actionName === "continue_collecting") {
    session.status = "collecting";
    await saveSession(env, userId, session);

    await replyText(openMessageId, "好的，请继续补充图片或文字。完成后输入 end。", token);
    return;
  }

  if (actionName === "cancel_report") {
    await deleteSession(env, userId);
    await replyText(openMessageId, "已取消当前 report session。", token);
    return;
  }

  if (actionName === "confirm_generate") {
    await replyText(openMessageId, "正在生成 Lark 文档，请稍等...", token);

    const doc = await createLarkDoc(session, token);
    await deleteSession(env, userId);

    await replyText(
      openMessageId,
      `✅ Report 已生成\n\n文档名：${doc.title}\n链接：${doc.url}`,
      token
    );
  }
}

// =====================
// Worker Entry
// =====================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Report Generator Running");
    }

    try {
      let body = await request.json();

      if (body.encrypt) {
        body = await decrypt(body.encrypt, env.FEISHU_ENCRYPT_KEY);
      }

      if (body.type === "url_verification") {
        return new Response(JSON.stringify({ challenge: body.challenge }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const token = await getLarkToken(env);

      ctx.waitUntil(
        (async () => {
          try {
            const eventType = body?.header?.event_type;

            if (eventType === "im.message.receive_v1") {
              const event = body.event;
              const messageType = event.message.message_type;

              if (messageType === "text") {
                await handleTextMessage(event, env, token);
              } else if (messageType === "image") {
                await handleImageMessage(event, env, token);
              }
            }

            if (eventType === "card.action.trigger") {
              await handleCardAction(body, env, token);
            }
          } catch (err) {
            console.log("Async handler error:", err.message);
          }
        })()
      );

      return new Response(JSON.stringify({ code: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.log("Main error:", err.message);

      return new Response(JSON.stringify({ code: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
