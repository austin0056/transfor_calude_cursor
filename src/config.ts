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
    // 如需关闭,设置 UPSTREAM_CONTEXT_1M=0 或 false。
    enableContext1M: !/^(0|false|off|no)$/i.test(
      process.env.UPSTREAM_CONTEXT_1M ?? "1",
    ),
  },
  exposedModel: process.env.EXPOSED_MODEL ?? "claude-opus-4-7",
  admin: {
    password: required("ADMIN_PASSWORD", "admin"),
    sessionSecret: required("SESSION_SECRET", "dev-session-secret-change-me"),
  },
} as const;

export type AppConfig = typeof config;
