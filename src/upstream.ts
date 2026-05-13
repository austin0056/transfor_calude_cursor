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
  if (config.upstream.enableContext1M) {
    headers["anthropic-beta"] = "context-1m-2025-08-07";
  }
  if (opts.body.stream) {
    headers.accept = "text/event-stream";
  }

  // 自带超时:即使外层没传 signal 也强制有上限,避免上游假死时连接永久挂着。
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`upstream timeout after ${config.upstream.timeoutMs}ms`)),
    config.upstream.timeoutMs,
  );
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => controller.abort(opts.signal?.reason), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (config.upstream.debug) {
      console.log(
        `[upstream] ${res.status} ${res.statusText} stream=${!!opts.body.stream} ` +
          `model=${opts.body.model} msgs=${opts.body.messages.length} max_tokens=${opts.body.max_tokens}`,
      );
    }
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
