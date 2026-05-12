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
      const handler = new AnthropicStreamToOpenAI({
        exposedModel: config.exposedModel,
        onUsage: (usage) => {
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
        for await (const { event, data } of parseSSE(upstreamRes.body)) {
          const frames = handler.handleFrame(event, data);
          for (const frame of frames) {
            // streamSSE 期望 payload/event,这里直接裸写 SSE 帧
            await sse.write(frame);
          }
        }
      } catch (err) {
        await sse.write(
          `data: ${JSON.stringify({
            error: { message: (err as Error).message, type: "stream_error" },
          })}\n\n`,
        );
        await sse.write("data: [DONE]\n\n");
      }
    });
  }

  const json = (await upstreamRes.json()) as AnthropicMessageResponse;
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
