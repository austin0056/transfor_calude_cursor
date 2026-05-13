import type { AnthropicContentBlock } from "./request.js";

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function mapStopReason(reason: string | null | undefined): string {
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

export function anthropicToOpenAI(
  res: AnthropicMessageResponse,
  exposedModel: string,
): OpenAIChatResponse {
  let text = "";
  const toolCalls: NonNullable<
    OpenAIChatResponse["choices"][0]["message"]["tool_calls"]
  > = [];

  for (const block of res.content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const inputTokens = res.usage.input_tokens +
    (res.usage.cache_creation_input_tokens ?? 0) +
    (res.usage.cache_read_input_tokens ?? 0);

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    // Cursor 等客户端对 content === null 处理不稳,统一给空串兜底。
    content: text,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: res.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: exposedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(res.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: inputTokens + res.usage.output_tokens,
    },
  };
}

export interface UsageStat {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function extractUsage(res: AnthropicMessageResponse): UsageStat {
  return {
    input_tokens: res.usage.input_tokens ?? 0,
    output_tokens: res.usage.output_tokens ?? 0,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
}
