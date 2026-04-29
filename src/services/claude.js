// ─── System Prompts ──────────────────────────────────────────────────────────

const PROMPT_IMAGE = `你是工业设备巡检助手。用户发送设备现场照片，请：
1. 识别设备类型（压缩机、电机、泵、仪表、铭牌等）
2. 读取可见参数（型号、序列号、运行数值、日期等）
3. 判断状态：正常 / 需关注 / 需维修 / 紧急
4. 如有异常，描述位置和现象

输出格式（严格按此格式）：
设备：[类型及型号]
参数：[读取到的数值，无则填"未见"]
状态：[正常/需关注/需维修/紧急]
说明：[简要工程描述，有异常请具体说明]`;

const PROMPT_TEXT = `你是工业设备巡检助手。用户发送口语化的巡检文字（可能是语音转文字），请：
1. 提取：设备名称/编号、问题描述、位置
2. 判断严重程度：正常 / 需关注 / 需维修 / 紧急
3. 整理为标准巡检记录语言

输出格式（严格按此格式）：
设备：[设备名称或编号]
状态：[正常/需关注/需维修/紧急]
描述：[标准化问题描述，简洁工程语言]`;

const PROMPT_REPORT = `你是工业设备巡检助手。请将以下巡检记录整理成简洁的内部巡检日报。

要求：
1. 按设备归类
2. 异常项用"⚠️"标注，紧急项用"🚨"标注
3. 末尾单独列出"待处理事项"（只列需关注/维修/紧急的项目）
4. 格式简洁，适合内部记录，无需客套语`;

// ─── API Call Helper ──────────────────────────────────────────────────────────

async function callClaude(env, systemPrompt, userContent) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─── Exported Functions ───────────────────────────────────────────────────────

export async function analyzeImageWithClaude(imageData, env) {
  const { base64, mediaType } = imageData;
  return callClaude(env, PROMPT_IMAGE, [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 },
    },
    { type: 'text', text: '请分析这张巡检图片。' },
  ]);
}

export async function analyzeTextWithClaude(text, env) {
  return callClaude(env, PROMPT_TEXT, text);
}

export async function generateReportWithClaude(summaries, datetime, typeLabel, env) {
  const prompt = `检查类型：${typeLabel}\n巡检时间：${datetime}\n\n以下是本次巡检的所有记录，请整理成报告：\n\n${summaries}`;
  return callClaude(env, PROMPT_REPORT, prompt);
}
