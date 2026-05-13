import process from "node:process";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  upstream: {
    baseUrl: (process.env.UPSTREAM_BASE_URL ?? "https://xcapi.top").replace(/\/+$/, ""),
    apiKey: required("UPSTREAM_API_KEY"),
    model: process.env.UPSTREAM_MODEL ?? "claude-opus-4-7",
    // 默认开启 1M 上下文 beta,Cursor plan 模式会塞很长的上下文,不开会被上游拒掉导致中断。
    // 注意:1M 指输入上下文,和输出上限 max_tokens 是两码事。如需关闭,设置 UPSTREAM_CONTEXT_1M=0 或 false。
    enableContext1M: !/^(0|false|off|no)$/i.test(
      process.env.UPSTREAM_CONTEXT_1M ?? "1",
    ),
    // 客户端未显式指定时的默认 max_tokens。
    // 之前给 32000 是为了避免长工具链被截断,但很多分发层会按 max_tokens 预扣额度,
    // 实际只输出几百 token 也按 32k 扣,销售层账单会虚高。
    // 8192 对 Cursor plan 单轮完全够用(一轮通常几百到两三千 token),有超长输出诉求时
    // 再通过 UPSTREAM_MAX_TOKENS 调大。客户端显式传的 max_tokens 永远优先于这里。
    defaultMaxTokens: Number(process.env.UPSTREAM_MAX_TOKENS ?? 8192),
    // 上游请求超时,默认 5 分钟。1M 上下文首包可能很慢,留够余量。
    timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 300_000),
    // 流式保活心跳间隔,毫秒。<=0 关闭。默认 15s,给前置代理(Cloudflare/nginx 60s 空闲)
    // 留够余量,避免 Plan 模式首包慢时连接被掐导致 Cursor 弹「重连」。
    keepaliveMs: Number(process.env.UPSTREAM_KEEPALIVE_MS ?? 15_000),
    // 打开后会把上游 SSE 事件类型和关键字段打到日志,用于排查「只回一句」「断流」类问题。
    debug: /^(1|true|on|yes)$/i.test(process.env.DEBUG_UPSTREAM ?? "0"),
  },
  exposedModel: process.env.EXPOSED_MODEL ?? "claude-opus-4-7",
  admin: {
    password: required("ADMIN_PASSWORD", "admin"),
    sessionSecret: required("SESSION_SECRET", "dev-session-secret-change-me"),
  },
} as const;

export type AppConfig = typeof config;
