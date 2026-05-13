// OpenAI Chat Completions 请求/响应 与 Anthropic Messages 之间的相互转换。
// 只覆盖 Cursor 实际会用到的字段,不追求协议大而全。

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
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

// 把 OpenAI tool 消息的 content 稳健地转成一段非空字符串。
// 客户端(包括 Cursor)可能把工具返回塞成:字符串、null、OpenAI content parts、甚至直接的 JSON 对象。
// Anthropic tool_result 要求字符串或 block 数组;给空串会让模型误以为工具啥都没返回,导致反复重试。
function stringifyToolContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push(p);
      } else if (p && typeof p === "object") {
        const obj = p as { type?: string; text?: string };
        if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
        else parts.push(safeJson(p));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") return safeJson(content);
  return String(content);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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
    // OpenAI 新版协议把 system 拆成 system / developer 两种,后者是给开发者注入指令用,
    // Anthropic 没有对应概念,统一并入 system。
    if (msg.role === "system" || msg.role === "developer") {
      const { text } = normalizeContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      // 用专用的兜底序列化:即使上游把工具结果塞成 JSON 对象或数组,也能稳定输出非空字符串。
      // 给空串会让模型以为工具没返回任何内容,进而在 agent 循环里反复调用同一个工具。
      const text = stringifyToolContent(msg.content) || "[empty tool result]";
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
      // assistant 既无文本也无 tool_calls 时跳过,避免合并阶段产生空块。
      if (blocks.length === 0) continue;
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    // user
    const { blocks } = normalizeContent(msg.content);
    if (blocks.length === 0) continue;
    messages.push({ role: "user", content: blocks });
  }

  // 关键修复:Anthropic 要求 user/assistant 严格交替。
  // OpenAI 协议里多个 tool 响应 + 后续 user 提问会产生多条连续 user 消息,
  // 直接发上游会被 400 或被部分中转网关静默处理成上下文混乱(常见表现:模型只回一句)。
  // 这里把连续同角色的消息合并成一条,content blocks 顺序拼接。
  const merged: AnthropicMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      const lastBlocks = Array.isArray(last.content)
        ? last.content
        : [{ type: "text" as const, text: last.content }];
      const curBlocks = Array.isArray(m.content)
        ? m.content
        : [{ type: "text" as const, text: m.content }];
      last.content = [...lastBlocks, ...curBlocks];
    } else {
      merged.push({
        role: m.role,
        content: Array.isArray(m.content) ? [...m.content] : m.content,
      });
    }
  }

  // Anthropic 要求 messages 首条是 user;如果全是 system 或为空,则补一条空 user
  if (merged.length === 0 || merged[0].role !== "user") {
    merged.unshift({ role: "user", content: [{ type: "text", text: "" }] });
  }
  // 末尾若是 assistant,Anthropic 视为 prefill 模式,Cursor 不会发这种序列;
  // 但若出现也不报错,这里保持原样。

  const anthropicReq: AnthropicRequest = {
    model: upstreamModel,
    // 客户端未指定时给一个大值,避免 Cursor agent 的长工具链或 plan 模式被 max_tokens 截断。
    // Opus 4.x 输出上限通常为 32k,给 32000 作为兜底;客户端显式传更小值会覆盖。
    max_tokens: req.max_tokens ?? 32_000,
    messages: merged,
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
    if (c.type === "required" || c.type === "any") return { type: "any" };
    if (c.type === "auto") return { type: "auto" };
    if (c.type === "none") return { type: "none" };
    if (c.type === "function" && c.function?.name) {
      return { type: "tool", name: c.function.name };
    }
  }
  return { type: "auto" };
}
