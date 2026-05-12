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
  },
  exposedModel: process.env.EXPOSED_MODEL ?? "claude-opus-4-7",
  admin: {
    password: required("ADMIN_PASSWORD", "admin"),
    sessionSecret: required("SESSION_SECRET", "dev-session-secret-change-me"),
  },
} as const;

export type AppConfig = typeof config;
