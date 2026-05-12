// OpenAI Chat Completions 请求/响应 与 Anthropic Messages 之间的相互转换。
// 只覆盖 Cursor 实际会用到的字段,不追求协议大而全。

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  user?: string;
}

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: "base64" | "url"; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  metadata?: { user_id?: string };
}

function normalizeContent(
  content: OpenAIMessage["content"],
): { text: string; blocks: AnthropicContentBlock[] } {
  if (content == null) return { text: "", blocks: [] };
  if (typeof content === "string") {
    return { text: content, blocks: content ? [{ type: "text", text: content }] : [] };
  }
  const blocks: AnthropicContentBlock[] = [];
  const textParts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
      textParts.push(part.text);
    } else if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      if (url.startsWith("data:")) {
        const match = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (match) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return { text: textParts.join("\n"), blocks };
}

export function openaiToAnthropic(
  req: OpenAIChatRequest,
  upstreamModel: string,
): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  // Buffer assistant tool_calls 直到遇到 tool 响应,方便按顺序拼接
  for (const msg of req.messages) {
    if (msg.role === "system") {
      const { text } = normalizeContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const { text } = normalizeContent(msg.content);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: text,
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const { blocks: textBlocks } = normalizeContent(msg.content);
      blocks.push(...textBlocks);
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          let input: unknown = {};
          try {
            input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            input = { _raw: call.function.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input,
          });
        }
      }
      messages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    // user
    const { blocks } = normalizeContent(msg.content);
    messages.push({
      role: "user",
      content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
    });
  }

  // Anthropic 要求 messages 首条是 user;如果全是 system,则补一条空 user
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "" }] });
  }

  const anthropicReq: AnthropicRequest = {
    model: upstreamModel,
    max_tokens: req.max_tokens ?? 8192,
    messages,
    stream: req.stream ?? false,
  };

  if (systemParts.length > 0) anthropicReq.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) anthropicReq.temperature = req.temperature;
  if (req.top_p !== undefined) anthropicReq.top_p = req.top_p;
  if (req.stop !== undefined) {
    anthropicReq.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.tools && req.tools.length > 0) {
    anthropicReq.tools = req.tools
      .filter((t) => t.type === "function")
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));
  }
  if (req.tool_choice !== undefined) {
    anthropicReq.tool_choice = mapToolChoice(req.tool_choice);
  }
  if (req.user) anthropicReq.metadata = { user_id: req.user };

  return anthropicReq;
}

function mapToolChoice(choice: unknown): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: string; function?: { name?: string } };
    if (c.type === "function" && c.function?.name) {
      return { type: "tool", name: c.function.name };
    }
  }
  return { type: "auto" };
}
