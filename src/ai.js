// src/ai.js
import { arrayBufferToBase64 } from './utils.js';

export async function askGemini(imageBuffer, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-1.5-flash"}:generateContent?key=${env.GEMINI_API_KEY}`;
  
  // 严格遵循 README 中的 JSON 结构定义
  const prompt = `你是一个工程机械专家。请识别图片中的铭牌信息或仪表盘数据。
必须返回 JSON 格式，字段如下：
{
  "type": "nameplate/dashboard/other",
  "model": "",
  "vin": "",
  "serial_no": "",
  "hours": "",
  "description": ""
}
注意：不确定则留空，不要编造。优先铭牌数据。`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: arrayBufferToBase64(imageBuffer) } }] }],
      generationConfig: { response_mime_type: "application/json" }
    })
  });
  return await res.json();
}