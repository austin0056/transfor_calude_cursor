import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "../config.js";
import {
  findApiKey,
  recordUsage,
  touchApiKey,
  type ApiKeyRow,
} from "../keys.js";
import type { OpenAIChatRequest } from "../protocol/request.js";
import { openaiToAnthropic } from "../protocol/request.js";
import {
  anthropicToOpenAI,
  extractUsage,
  type AnthropicMessageResponse,
} from "../protocol/response.js";
import { AnthropicStreamToOpenAI, parseSSE } from "../protocol/stream.js";
import { callUpstream } from "../upstream.js";

export const v1Router = new Hono();

function extractBearer(auth: string | undefined): string | null {
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : auth.trim();
}

async function authenticate(
  authHeader: string | undefined,
): Promise<ApiKeyRow | { error: string; status: number }> {
  const token = extractBearer(authHeader);
  if (!token) return { error: "missing api key", status: 401 };
  const row = await findApiKey(token);
  if (!row) return { error: "invalid api key", status: 401 };
  if (!row.enabled) return { error: "api key disabled", status: 403 };
  return row;
}

v1Router.get("/models", (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: config.exposedModel,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic-bridge",
      },
    ],
  });
});

v1Router.post("/chat/completions", async (c) => {
  const authResult = await authenticate(c.req.header("authorization"));
  if ("error" in authResult) {
    return c.json(
      { error: { message: authResult.error, type: "invalid_request_error" } },
      authResult.status as 401 | 403,
    );
  }
  const apiKey = authResult;

  let payload: OpenAIChatRequest;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(
      { error: { message: "invalid json body", type: "invalid_request_error" } },
      400,
    );
  }

  if (!payload.messages || !Array.isArray(payload.messages)) {
    return c.json(
      { error: { message: "messages is required", type: "invalid_request_error" } },
      400,
    );
  }

  const upstreamReq = openaiToAnthropic(payload, config.upstream.model);
  const startedAt = Date.now();
  touchApiKey(apiKey.id).catch(() => {});

  if (config.upstream.debug) {
    const summary = upstreamReq.messages.map((m) => {
      const blocks = Array.isArray(m.content)
        ? m.content.map((b) => b.type).join(",")
        : "string";
      return `${m.role}[${blocks}]`;
    });
    const incoming = payload.messages.map((m) => {
      const tc = m.tool_calls ? `+tc${m.tool_calls.length}` : "";
      const tid = m.tool_call_id ? `(tid=${m.tool_call_id.slice(0, 8)})` : "";
      return `${m.role}${tc}${tid}`;
    });
    // tools 数量 + tool_choice 是排查"只回一句"的关键证据:
    // 若 in_tools=0 说明客户端压根没带工具,模型只能文字回答;这是客户端侧问题,网关无法修复。
    const inTools = Array.isArray(payload.tools) ? payload.tools.length : 0;
    const outTools = upstreamReq.tools?.length ?? 0;
    const toolChoice =
      typeof payload.tool_choice === "string"
        ? payload.tool_choice
        : payload.tool_choice
          ? JSON.stringify(payload.tool_choice).slice(0, 80)
          : "-";
    console.log(`[req.in]  ${incoming.join(" | ")}`);
    console.log(`[req.out] ${summary.join(" | ")}`);
    console.log(
      `[req.meta] in_tools=${inTools} out_tools=${outTools} tool_choice=${toolChoice} ` +
        `stream=${!!payload.stream} max_tokens=${upstreamReq.max_tokens}`,
    );
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await callUpstream({ body: upstreamReq });
  } catch (err) {
    const latency = Date.now() - startedAt;
    recordUsage({
      apiKeyId: apiKey.id,
      model: config.exposedModel,
      usage: zeroUsage(),
      stream: !!payload.stream,
      statusCode: 502,
      latencyMs: latency,
    }).catch(() => {});
    return c.json(
      {
        error: {
          message: `upstream request failed: ${(err as Error).message}`,
          type: "upstream_error",
        },
      },
      502,
    );
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    const latency = Date.now() - startedAt;
    recordUsage({
      apiKeyId: apiKey.id,
      model: config.exposedModel,
      usage: zeroUsage(),
      stream: !!payload.stream,
      statusCode: upstreamRes.status,
      latencyMs: latency,
    }).catch(() => {});
    return c.json(
      {
        error: {
          message: `upstream returned ${upstreamRes.status}: ${text.slice(0, 500)}`,
          type: "upstream_error",
        },
      },
      upstreamRes.status as 400,
    );
  }

  if (payload.stream) {
    return streamSSE(c, async (sse) => {
      if (!upstreamRes.body) {
        await sse.write("data: [DONE]\n\n");
        return;
      }
      let usageRecorded = false;
      const handler = new AnthropicStreamToOpenAI({
        exposedModel: config.exposedModel,
        hasTools: !!(upstreamReq.tools && upstreamReq.tools.length > 0),
        onUsage: (usage) => {
          usageRecorded = true;
          recordUsage({
            apiKeyId: apiKey.id,
            model: config.exposedModel,
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
            },
            stream: true,
            statusCode: 200,
            latencyMs: Date.now() - startedAt,
          }).catch(() => {});
        },
      });

      try {
        // 主动心跳:上游 thinking / 长首包期间完全静默,前置代理(Cloudflare/nginx
        // 空闲 60s)会掐连接,Cursor 弹「重连」。定期写一行 SSE comment 保活,
        // 任何真实帧写入时重置计时,避免心跳和真实数据打架。
        let lastWrite = Date.now();
        const keepaliveMs = config.upstream.keepaliveMs;
        const keepaliveTimer =
          keepaliveMs > 0
            ? setInterval(() => {
                if (Date.now() - lastWrite >= keepaliveMs) {
                  sse.write(": keepalive\n\n").catch(() => {});
                  lastWrite = Date.now();
                }
              }, Math.max(1000, Math.floor(keepaliveMs / 2)))
            : null;
        try {
          for await (const { event, data } of parseSSE(upstreamRes.body)) {
            const frames = handler.handleFrame(event, data);
            for (const frame of frames) {
              // streamSSE 期望 payload/event,这里直接裸写 SSE 帧
              await sse.write(frame);
              lastWrite = Date.now();
            }
          }
          // 兜底:上游流正常结束但没发 message_stop(中转断连、上游提前 close 等)。
          // 不补发 finish + [DONE] 会让客户端永远卡在"等最后一帧"。
          const tail = handler.finalize();
          for (const frame of tail) {
            await sse.write(frame);
            lastWrite = Date.now();
          }
        } finally {
          if (keepaliveTimer) clearInterval(keepaliveTimer);
        }
      } catch (err) {
        console.error("[stream] aborted:", (err as Error).message);
        await sse.write(
          `data: ${JSON.stringify({
            error: { message: (err as Error).message, type: "stream_error" },
          })}\n\n`,
        );
        await sse.write("data: [DONE]\n\n");
        if (!usageRecorded) {
          recordUsage({
            apiKeyId: apiKey.id,
            model: config.exposedModel,
            usage: zeroUsage(),
            stream: true,
            statusCode: 599,
            latencyMs: Date.now() - startedAt,
          }).catch(() => {});
        }
      }
    });
  }

  const rawBody = await upstreamRes.text();
  let json: AnthropicMessageResponse;
  try {
    json = JSON.parse(rawBody) as AnthropicMessageResponse;
  } catch {
    // 上游偶尔在 200 下返回 HTML 错误页(网关超时、WAF 拦截等)。
    // 不容错会让 Hono 默认 500 且漏 recordUsage,排查时很难看出是上游问题。
    const latency = Date.now() - startedAt;
    recordUsage({
      apiKeyId: apiKey.id,
      model: config.exposedModel,
      usage: zeroUsage(),
      stream: false,
      statusCode: 502,
      latencyMs: latency,
    }).catch(() => {});
    return c.json(
      {
        error: {
          message: `upstream returned non-JSON body: ${rawBody.slice(0, 500)}`,
          type: "upstream_error",
        },
      },
      502,
    );
  }
  const openaiRes = anthropicToOpenAI(json, config.exposedModel);
  const usage = extractUsage(json);
  recordUsage({
    apiKeyId: apiKey.id,
    model: config.exposedModel,
    usage,
    stream: false,
    statusCode: 200,
    latencyMs: Date.now() - startedAt,
  }).catch(() => {});
  return c.json(openaiRes);
});

function zeroUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
