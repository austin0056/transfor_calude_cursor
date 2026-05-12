import { query } from "./db.js";
import type { UsageStat } from "./protocol/response.js";
import crypto from "node:crypto";

export interface ApiKeyRow {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

export function generateApiKey(): string {
  // sk-bridge- 前缀 + 40 位 base64url,足够熵且方便在面板区分
  const random = crypto.randomBytes(30).toString("base64url");
  return `sk-bridge-${random}`;
}

export async function findApiKey(key: string): Promise<ApiKeyRow | null> {
  const { rows } = await query<ApiKeyRow>(
    `SELECT id, key, name, enabled, created_at, last_used_at
       FROM api_keys WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const { rows } = await query<ApiKeyRow>(
    `SELECT id, key, name, enabled, created_at, last_used_at
       FROM api_keys ORDER BY id DESC`,
  );
  return rows;
}

export async function createApiKey(name: string): Promise<ApiKeyRow> {
  const key = generateApiKey();
  const { rows } = await query<ApiKeyRow>(
    `INSERT INTO api_keys (key, name) VALUES ($1, $2)
       RETURNING id, key, name, enabled, created_at, last_used_at`,
    [key, name],
  );
  return rows[0];
}

export async function setApiKeyEnabled(id: number, enabled: boolean): Promise<void> {
  await query(`UPDATE api_keys SET enabled = $1 WHERE id = $2`, [enabled, id]);
}

export async function deleteApiKey(id: number): Promise<void> {
  await query(`DELETE FROM api_keys WHERE id = $1`, [id]);
}

export async function touchApiKey(id: number): Promise<void> {
  await query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [id]);
}

export interface RecordUsageInput {
  apiKeyId: number | null;
  model: string;
  usage: UsageStat;
  stream: boolean;
  statusCode: number;
  latencyMs: number;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  await query(
    `INSERT INTO usage_logs
       (api_key_id, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        stream, status_code, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.apiKeyId,
      input.model,
      input.usage.input_tokens,
      input.usage.output_tokens,
      input.usage.cache_creation_input_tokens,
      input.usage.cache_read_input_tokens,
      input.stream,
      input.statusCode,
      input.latencyMs,
    ],
  );
}

export interface KeyUsageSummary {
  api_key_id: number | null;
  key: string | null;
  name: string | null;
  enabled: boolean | null;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  last_request_at: Date | null;
}

export async function summarizeUsage(sinceDays = 30): Promise<KeyUsageSummary[]> {
  const { rows } = await query<KeyUsageSummary>(
    `SELECT
        k.id  AS api_key_id,
        k.key AS key,
        k.name AS name,
        k.enabled AS enabled,
        COALESCE(COUNT(l.id), 0)::int AS request_count,
        COALESCE(SUM(l.input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(l.output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(l.cache_creation_input_tokens), 0)::int AS cache_creation_input_tokens,
        COALESCE(SUM(l.cache_read_input_tokens), 0)::int AS cache_read_input_tokens,
        MAX(l.created_at) AS last_request_at
       FROM api_keys k
       LEFT JOIN usage_logs l
         ON l.api_key_id = k.id
        AND l.created_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY k.id
      ORDER BY k.id DESC`,
    [sinceDays],
  );
  return rows;
}

export interface DailyUsageRow {
  day: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
}

export async function dailyUsage(days = 14): Promise<DailyUsageRow[]> {
  const { rows } = await query<DailyUsageRow>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS request_count,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int AS output_tokens
       FROM usage_logs
      WHERE created_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY 1
      ORDER BY 1 DESC`,
    [days],
  );
  return rows;
}
