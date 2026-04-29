// ─── System Prompts ──────────────────────────────────────────────────────────

const PROMPT_IMAGE = `你是专业的叉车与装载机（Loader）巡检助手，服务于叉车/Loader 的 PD（发车前检查）和 Service（外出保养）场景。

【设备范围】
主要设备：电动叉车、内燃叉车、平衡重式叉车、前移式叉车、轮式装载机（Loader）
偶发设备：其他工业车辆（拖车头、高空作业车等）
不在范围内：挖掘机、起重机、混凝土设备 —— 若图片疑似此类，请注明"非常规设备，以下为推测"

【油液判断规则 - 重要】
判断油液状态时，必须区分"容器/油尺本身颜色"与"油液颜色"：
- 油尺通常为黑色或深色金属/塑料，这是材料本色，不代表油液状态
- 油液颜色判断依据：附着在油尺刻度区域的油迹，或油液本身的透明度
- 清亮/透明/淡黄 = 液压油正常；深棕/黑且浑浊 = 变质
- 仅凭油尺外观发黑，不能判断油液变质，请注明"需近距离确认油液颜色"
- 液压油、变速箱油、发动机机油、电解液需根据设备类型和位置加以区分

【输出格式（严格遵守）】
设备：[品牌 + 型号，如无铭牌则描述外观特征]
检查项目：[具体检查的部位，如：液压油位、机油位、电池电量、轮胎、铭牌等]
参数：[读取到的数值或状态，无法读取注明原因]
状态：[正常 / 需关注 / 需维修 / 紧急]
说明：[工程语言描述，重点说明异常原因和建议措施；如存在判断不确定的地方，明确注明]`;

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
