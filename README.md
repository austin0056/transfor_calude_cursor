# Anthropic → OpenAI Bridge (for Cursor, on Zeabur)

把 Anthropic `messages` 协议的上游(这里是 `xcapi.top`)包装成 OpenAI `chat/completions` 协议,
让 Cursor 可以直接调用。附带一个最小管理面板,用于生成 / 禁用 API Key,并按 key 统计 token 用量。

## 功能

- `POST /v1/chat/completions` — OpenAI 兼容,支持流式 SSE 与工具调用
- `GET  /v1/models` — 返回已暴露模型,满足 Cursor 模型发现
- `GET  /admin` — 密码登录的单页管理面板
  - 创建 / 禁用 / 删除 API key
  - 按 key 统计 30 天内请求数、input/output/cache token
  - 最近 14 天每日用量
- 每次请求落库 `usage_logs`,不做扣费(计费由上游负责)

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 监听端口,Zeabur 自动注入,默认 8080 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `UPSTREAM_BASE_URL` | 上游 base url,默认 `https://xcapi.top` |
| `UPSTREAM_API_KEY` | 上游 key(作为 `x-api-key` 和 `Authorization: Bearer` 同时发) |
| `UPSTREAM_MODEL` | 上游模型名,默认 `claude-opus-4-7` |
| `EXPOSED_MODEL` | 对外暴露的模型名(Cursor 里填这个),默认 `claude-opus-4-7` |
| `ADMIN_PASSWORD` | 管理面板登录密码 |
| `SESSION_SECRET` | session cookie 签名密钥,随便一段长字符串 |

## Zeabur 部署步骤

1. 新建 Zeabur 项目,添加 **PostgreSQL** 服务。
2. 把本仓库推上 GitHub,在同一项目里 **Deploy from Git Repository** 选中它。Zeabur 会识别 `Dockerfile` 自动构建。
3. 在服务的 **Variables** 里:
   - `DATABASE_URL` 用变量引用指向 Postgres 服务,例如:
     `${POSTGRES_CONNECTION_STRING}` 或按 Zeabur 的实际变量名填。
   - 填入 `UPSTREAM_API_KEY`、`ADMIN_PASSWORD`、`SESSION_SECRET`。
   - 其他变量按需覆盖。
4. 绑定域名,打开 `https://<你的域名>/admin`,用 `ADMIN_PASSWORD` 登录,创建一个 key。

## 在 Cursor 里使用

打开 **Cursor → Settings → Models → OpenAI API Key**:

- **Override OpenAI Base URL**: `https://<你的域名>/v1`
- **OpenAI API Key**: 填在管理面板里创建的 `sk-bridge-xxxx`
- 在 **Custom Models** 里添加模型名 `claude-opus-4-7`(与 `EXPOSED_MODEL` 一致)
- 勾选 **Verify**,应返回成功

之后把 `claude-opus-4-7` 设为默认模型即可。

## 本地开发

```bash
npm install
cp .env.example .env   # 改成你的真实值
npm run dev
```

访问:

- `http://localhost:8080/admin` — 管理面板
- `http://localhost:8080/v1/models` — 模型列表
- `POST http://localhost:8080/v1/chat/completions` — 对话接口

## 请求路径

```
Cursor
  └─ POST /v1/chat/completions (OpenAI 格式)
        └─ openaiToAnthropic()         → 重写成 Anthropic messages
              └─ fetch xcapi.top/v1/messages
                    └─ 非流式: anthropicToOpenAI()
                    └─ 流式:   AnthropicStreamToOpenAI (SSE 重写)
              └─ recordUsage() → usage_logs
```

## 计费说明

本服务**不做扣费**,只做 token 统计。真正的计费由上游 `xcapi.top` 完成。
管理面板里的数字可以用于分摊、审计或对账。
