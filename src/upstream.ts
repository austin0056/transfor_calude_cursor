import { config } from "./config.js";
import type { AnthropicRequest } from "./protocol/request.js";

export interface UpstreamCallOptions {
  body: AnthropicRequest;
  signal?: AbortSignal;
}

// 调用上游 Anthropic 兼容端点。返回原始 Response,调用方决定流式或非流式处理。
export async function callUpstream(opts: UpstreamCallOptions): Promise<Response> {
  const url = `${config.upstream.baseUrl}/v1/messages`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": config.upstream.apiKey,
    authorization: `Bearer ${config.upstream.apiKey}`,
  };
  if (opts.body.stream) {
    headers.accept = "text/event-stream";
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
}
