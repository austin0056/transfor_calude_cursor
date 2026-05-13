// Anthropic SSE → OpenAI SSE chunk 转换器。
// 以累积状态机形式处理 message_start、content_block_start/delta/stop、message_delta、message_stop。
// 输出符合 OpenAI chat.completion.chunk 格式。

import { config } from "../config.js";
import type { UsageStat } from "./response.js";

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  argsBuffer: string;
}

type BlockKind = "text" | "tool_use" | "thinking" | "other";

export interface StreamHandlerOptions {
  exposedModel: string;
  onUsage?: (usage: UsageStat) => void;
}

export class AnthropicStreamToOpenAI {
  private readonly id: string;
  private readonly created: number;
  private readonly model: string;
  private readonly onUsage?: (usage: UsageStat) => void;

  private roleSent = false;
  private anyContentSent = false;
  private toolCalls: Map<number, ToolCallState> = new Map();
  private blockKinds: Map<number, BlockKind> = new Map();
  private nextToolIndex = 0;
  private finishReason: string | null = null;

  private usage: UsageStat = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  constructor(opts: StreamHandlerOptions) {
    this.id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = opts.exposedModel;
    this.onUsage = opts.onUsage;
  }

  // 解析 Anthropic SSE 原始文本帧,产出若干 OpenAI SSE 帧字符串(含 "data: " 前缀和双换行)
  handleFrame(event: string, data: string): string[] {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      if (config.upstream.debug) {
        console.log(`[upstream.sse] bad json event=${event} data=${data.slice(0, 200)}`);
      }
      return [];
    }

    const type = (parsed.type as string) ?? event;
    if (config.upstream.debug) {
      const block = parsed.content_block as { type?: string } | undefined;
      const delta = parsed.delta as { type?: string; stop_reason?: string } | undefined;
      console.log(
        `[upstream.sse] type=${type} block=${block?.type ?? "-"} delta=${delta?.type ?? "-"} stop=${delta?.stop_reason ?? "-"}`,
      );
    }
    switch (type) {
      case "message_start":
        return this.onMessageStart(parsed);
      case "content_block_start":
        return this.onBlockStart(parsed);
      case "content_block_delta":
        return this.onBlockDelta(parsed);
      case "content_block_stop":
        return [];
      case "message_delta":
        return this.onMessageDelta(parsed);
      case "message_stop":
        return this.onMessageStop();
      case "ping":
        return [];
      case "error":
        return this.onError(parsed);
      default:
        return [];
    }
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private onMessageStart(parsed: Record<string, unknown>): string[] {
    const message = parsed.message as
      | { usage?: Partial<UsageStat> }
      | undefined;
    if (message?.usage) {
      this.usage.input_tokens = message.usage.input_tokens ?? 0;
      this.usage.cache_creation_input_tokens =
        message.usage.cache_creation_input_tokens ?? 0;
      this.usage.cache_read_input_tokens =
        message.usage.cache_read_input_tokens ?? 0;
    }
    this.roleSent = true;
    return [this.chunk({ role: "assistant", content: "" })];
  }

  private onBlockStart(parsed: Record<string, unknown>): string[] {
    const block = parsed.content_block as
      | { type?: string; id?: string; name?: string }
      | undefined;
    const blockIdx = Number(parsed.index ?? 0);
    const kind: BlockKind =
      block?.type === "text"
        ? "text"
        : block?.type === "tool_use"
          ? "tool_use"
          : block?.type === "thinking"
            ? "thinking"
            : "other";
    this.blockKinds.set(blockIdx, kind);

    if (kind === "tool_use") {
      const idx = this.nextToolIndex++;
      this.toolCalls.set(blockIdx, {
        index: idx,
        id: block?.id ?? "",
        name: block?.name ?? "",
        argsBuffer: "",
      });
      return [
        this.chunk({
          tool_calls: [
            {
              index: idx,
              id: block?.id ?? "",
              type: "function",
              function: { name: block?.name ?? "", arguments: "" },
            },
          ],
        }),
      ];
    }
    return [];
  }

  private onBlockDelta(parsed: Record<string, unknown>): string[] {
    const delta = parsed.delta as
      | { type?: string; text?: string; partial_json?: string }
      | undefined;
    if (!delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const chunks: string[] = [];
      if (!this.roleSent) {
        chunks.push(this.chunk({ role: "assistant", content: "" }));
        this.roleSent = true;
      }
      chunks.push(this.chunk({ content: delta.text }));
      this.anyContentSent = true;
      return chunks;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const blockIdx = Number(parsed.index ?? 0);
      const state = this.toolCalls.get(blockIdx);
      if (!state) return [];
      state.argsBuffer += delta.partial_json;
      this.anyContentSent = true;
      return [
        this.chunk({
          tool_calls: [
            {
              index: state.index,
              function: { arguments: delta.partial_json },
            },
          ],
        }),
      ];
    }
    // thinking_delta / signature_delta / 其他:当前静默丢弃。
    // Anthropic extended thinking 的内容对 OpenAI 客户端没有对应字段,
    // 强行塞到 content 会污染输出;保留兜底 (message_stop 时若没任何内容再发空串)。
    return [];
  }

  private onMessageDelta(parsed: Record<string, unknown>): string[] {
    const delta = parsed.delta as { stop_reason?: string } | undefined;
    const usage = parsed.usage as { output_tokens?: number } | undefined;
    if (usage?.output_tokens !== undefined) {
      this.usage.output_tokens = usage.output_tokens;
    }
    if (delta?.stop_reason) {
      this.finishReason = mapStop(delta.stop_reason);
    }
    return [];
  }

  private onMessageStop(): string[] {
    this.onUsage?.(this.usage);
    const finish = this.finishReason ?? "stop";
    const frames: string[] = [];
    // 兜底:整条消息没发过任何文本/工具块,至少补一个空字符串 delta,
    // 避免 Cursor 等客户端拿到「只有 role、没有 content」的流直接判定为空回复。
    if (!this.anyContentSent) {
      frames.push(this.chunk({ content: "" }));
    }
    frames.push(this.chunk({}, finish));
    frames.push("data: [DONE]\n\n");
    return frames;
  }

  private onError(parsed: Record<string, unknown>): string[] {
    // 上游 error 事件之前被静默丢弃,导致客户端看到「讲一半突然停」。
    // 这里把错误消息透传成一段文本 + 显式 finish_reason=stop + [DONE],
    // 至少让用户能看到原因。
    const err = parsed.error as { type?: string; message?: string } | undefined;
    const msg = err?.message ?? "upstream error";
    const frames: string[] = [];
    if (!this.roleSent) {
      frames.push(this.chunk({ role: "assistant", content: "" }));
      this.roleSent = true;
    }
    frames.push(this.chunk({ content: `\n\n[upstream error: ${msg}]` }));
    this.anyContentSent = true;
    frames.push(this.chunk({}, "stop"));
    frames.push("data: [DONE]\n\n");
    this.onUsage?.(this.usage);
    console.error(`[upstream.sse] error event: ${err?.type ?? "unknown"} ${msg}`);
    return frames;
  }
}

function mapStop(reason: string): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

// 从 ReadableStream<Uint8Array> 的分块数据中解析 SSE 帧:yield { event, data }
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
