 一、核心目标
一句话：

在 Lark 聊天里，通过图片 + 人工补充，自动生成结构化 PD / Service Report，并输出为 Lark 文档（含图片）
🧩 二、完整用户流程
1️⃣ 启动
用户输入：开始 / start
↓
bot回复：选择 PD Report / Service Report（按钮）

2️⃣ 创建 session
用户点击：PD 或 Service
↓
bot：
✔ 创建 session
✔ 状态 = collecting
✔ 提示可以发送图片

3️⃣ 图片输入（核心）
用户发送图片（顺序乱）
↓
bot：
✔ 调 Gemini 识别
✔ 提取：
   - model
   - vin / serial
   - hours
   - 内容描述
✔ 回复识别结果（引用图片）
✔ 写入 session

4️⃣ 人工补充（随时）
用户输入文字（details / correction）

例如：
- "这个是mast有漏油"
- "vin是xxx写错了"

↓
bot：
✔ 记录 notes
✔ 不打断流程

5️⃣ 结束流程
用户输入：end / 结束
↓
bot：
✔ 检查关键字段：
   - model
   - vin / serial
   - hours

6️⃣ 缺失检查 + 确认
情况 A：缺字段
bot：
缺失：
- model
- hours

是否继续生成？
[确认生成] [继续补充] [取消]

情况 B：完整
bot：
信息完整，是否生成？
[确认生成]

7️⃣ 生成文档（关键产物）
bot：
✔ 创建 Lark Doc
✔ 插入内容：
   - header
   - machine info
   - notes
   - 图片（按顺序）
   - 每张图片对应识别描述
   - 自动生成 report draft

8️⃣ 输出
bot：
Report 已生成
链接: https://...

🧱 三、数据结构（必须统一）
session（KV 里存）

{
  report_type: "PD" | "Service",
  status: "collecting" | "confirming",

  extracted: {
    model: "",
    vin: "",
    serial_no: "",
    hours: "",
    date: ""
  },

  images: [
    {
      imageKey,
      result,          // Gemini原始识别
      parsed: {
        model,
        vin,
        hours
      }
    }
  ],

  notes: [
    {
      text,
      timestamp
    }
  ]
}

🔍 四、AI识别要求（Gemini）
必须输出结构化信息：


{
  "type": "nameplate / dashboard / part",
  "model": "",
  "vin": "",
  "serial_no": "",
  "hours": "",
  "description": ""
}

规则：


不确定 → 留空

不允许编造

优先铭牌 > 仪表 > 其他
📄 五、生成的文档结构
Title:
PD Report_CAT_123ABC_2026-04-24

--------------------------------

Machine Info
Model:
VIN:
Hours:

--------------------------------

User Notes
1. xxx
2. xxx

--------------------------------

Photos

Photo 1
[图片]
识别说明：
xxx

Photo 2
[图片]
识别说明：
xxx

--------------------------------

Final Report（自动生成）

Machine was inspected...

⚙️ 六、系统架构
Lark Bot
   ↓ webhook
Cloudflare Worker
   ↓
KV（session）
   ↓
Gemini API（识别）
   ↓
Lark API（消息 / 文档）

⚠️ 七、关键难点
1. 图片处理

base64 会爆栈

CF 有 10ms CPU 限制 → 要 chunk
2. session 丢失

user_id 不稳定 ❌

chat_id ✅
3. doc 插图
必须走：

upload media → 拿 token → 插入 block

4. Gemini 不稳定输出
必须：


强制 JSON

做 fallback
5. free tier 限制
CPU时间
请求大小
KV读写延迟

所以：


不要一次处理太多图

不要存大图（只存 key）
