# PD助手 · Lark 工业设备巡检 Bot

> 巡检员只需发送图片或文字，Bot 自动完成识别、分析、归档和报告生成。

---

## 架构概览

```
Lark Bot
  └─ 发消息 → Cloudflare Worker
                  ├─ Claude API（图片识别 / 文字解析 / 报告生成）
                  ├─ Cloudflare KV（session 临时存储）
                  └─ 回复 Lark 消息
```

```
src/
  index.js                 # 入口：解密、去重、路由
  router.js                # 消息类型判断，分发到对应函数
  functions/
    analyzeImage.js        # 图片识别
    analyzeText.js         # 文字解析
    commands.js            # 指令处理（/报告 /状态 /清除）
    generateReport.js      # 汇总生成巡检报告
  services/
    claude.js              # Claude API 封装
    lark.js                # Lark API 封装（token / 下载 / 发送）
    session.js             # KV 读写
  utils/
    crypto.js              # Lark 事件解密（AES-256-CBC）
```

---

## 使用方式

| 操作 | Bot 响应 |
|------|---------|
| 发送图片 | 识别设备类型、读取参数、标注异常 |
| 发送文字 | 结构化解析，提取设备名、状态、问题描述 |
| 图片 + 文字混发 | 合并为一条完整记录 |
| `/报告` | 汇总本次所有记录，生成巡检日报 |
| `/状态` | 查看当前记录条数和开始时间 |
| `/清除` | 清空当前记录，开始新一轮巡检 |

---

## 环境变量

在 Cloudflare Dashboard → Workers → lark-report-bot → Settings → Variables and Secrets 中配置：

| 类型 | 名称 | 说明 |
|------|------|------|
| Secret | `ANTHROPIC_API_KEY` | Claude API Key |
| Secret | `FEISHU_APP_ID` | Lark 应用 App ID |
| Secret | `FEISHU_APP_SECRET` | Lark 应用 App Secret |
| Secret | `FEISHU_ENCRYPT_KEY` | Lark 事件加密 Key |
| Secret | `FEISHU_VERIFICATION_TOKEN` | Lark 事件验证 Token |
| Plaintext | `CLAUDE_MODEL` | `claude-sonnet-4-6` |
| Plaintext | `LARK_API_URL` | `https://open.feishu.cn/open-apis` |

> Secrets 不写入 `wrangler.toml`，只在 Dashboard 中维护。

---

## 本地开发

```bash
npm install
npx wrangler dev
```

## 部署

推送到 `main` 分支后 Cloudflare 自动部署，或手动执行：

```bash
npx wrangler deploy
```

---

## 扩展新功能

每个功能是独立的函数文件，添加新能力只需两步：

**1. 在 `src/functions/` 新建函数文件**

```js
// src/functions/myNewFeature.js
export async function handleMyFeature({ userId, chatId, content, env }) {
  // 实现逻辑
}
```

**2. 在 `src/router.js` 注册路由**

```js
import { handleMyFeature } from './functions/myNewFeature.js';

// 在 routeMessage 中添加判断
if (messageType === 'my_type') {
  await handleMyFeature(ctx);
}
```

---

## Lark 开发者后台配置

- **事件订阅**：`im.message.receive_v1`
- **回调**：`card.action.trigger`
- **Webhook URL**：`https://lark-report-bot.john-wang-9f9.workers.dev`
- **权限**：`im:message`、`im:resource`、`im:message:send_as_bot`、`docx:document`

---

## Session 机制

每个用户有一个独立的 KV session，TTL 24 小时。用户可在一次巡检中多次发送图片和文字，Bot 会累积收集，直到用户发送 `/报告` 后汇总生成并自动清除 session。

```json
{
  "user_id": "ou_xxxxxx",
  "status": "collecting",
  "created_at": "2026-04-29T10:00:00.000Z",
  "updated_at": "2026-04-29T10:05:00.000Z",
  "items": [
    { "type": "image", "imageKey": "...", "analysis": "...", "timestamp": "..." },
    { "type": "text",  "original": "...", "analysis": "...", "timestamp": "..." }
  ]
}
```