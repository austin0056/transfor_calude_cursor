// Anthropic SSE → OpenAI SSE chunk 转换器。
// 以累积状态机形式处理 message_start、content_block_start/delta/stop、message_delta、message_stop。
// 输出符合 OpenAI chat.completion.chunk 格式。

import type { UsageStat } from "./response.js";

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  argsBuffer: string;
}

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
  private toolCalls: Map<number, ToolCallState> = new Map();
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
      return [];
    }

    const type = (parsed.type as string) ?? event;
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
      case "error":
        return [];
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
    if (block?.type === "tool_use") {
      const idx = this.nextToolIndex++;
      this.toolCalls.set(Number(parsed.index ?? idx), {
        index: idx,
        id: block.id ?? "",
        name: block.name ?? "",
        argsBuffer: "",
      });
      return [
        this.chunk({
          tool_calls: [
            {
              index: idx,
              id: block.id ?? "",
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
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
      return chunks;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const blockIdx = Number(parsed.index ?? 0);
      const state = this.toolCalls.get(blockIdx);
      if (!state) return [];
      state.argsBuffer += delta.partial_json;
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
    return [this.chunk({}, finish), "data: [DONE]\n\n"];
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
