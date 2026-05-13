import { config } from "../config.js";

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

// 把 OpenAI tool 消息的 content 转成 Anthropic tool_result.content 接受的形式。
// 优先返回 block 数组以保留多模态(图片)结构;退化为字符串时也保证非空。
// Cursor 偶尔会让工具返回带图片的内容(截图、屏幕等),用 block 数组才不丢信息。
function buildToolResultContent(
  content: unknown,
): string | AnthropicContentBlock[] {
  if (content == null) return "[empty tool result]";
  if (typeof content === "string") return content || "[empty tool result]";
  if (Array.isArray(content)) {
    const blocks: AnthropicContentBlock[] = [];
    const textBuf: string[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        textBuf.push(p);
        continue;
      }
      if (!p || typeof p !== "object") continue;
      const obj = p as { type?: string; text?: string; image_url?: { url?: string } };
      if (obj.type === "text" && typeof obj.text === "string") {
        textBuf.push(obj.text);
      } else if (obj.type === "image_url" && obj.image_url?.url) {
        // 先把累积的文本作为一个 text block 提交
        if (textBuf.length > 0) {
          blocks.push({ type: "text", text: textBuf.join("\n") });
          textBuf.length = 0;
        }
        const url = obj.image_url.url;
        if (url.startsWith("data:")) {
          const m = /^data:([^;]+);base64,(.*)$/.exec(url);
          if (m) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: m[1], data: m[2] },
            });
          }
        } else {
          blocks.push({ type: "image", source: { type: "url", url } });
        }
      } else {
        textBuf.push(safeJson(p));
      }
    }
    if (textBuf.length > 0) {
      blocks.push({ type: "text", text: textBuf.join("\n") });
    }
    if (blocks.length === 0) return "[empty tool result]";
    // 如果只剩一个 text block,直接返字符串更简洁
    if (blocks.length === 1 && blocks[0].type === "text") {
      return blocks[0].text || "[empty tool result]";
    }
    return blocks;
  }
  if (typeof content === "object") return safeJson(content) || "[empty tool result]";
  return String(content);
}

// 启发式判断 tool 响应是否是错误。Cursor 偶尔在 content 里塞 {error: "..."} 或带 exit_code。
// 命中 marker 才打 is_error,避免把正常结果误标。
function looksLikeToolError(content: unknown): boolean {
  if (content == null) return false;
  if (typeof content === "object" && !Array.isArray(content)) {
    const o = content as Record<string, unknown>;
    if (typeof o.error === "string" && o.error.length > 0) return true;
    if (o.is_error === true) return true;
    if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
  }
  return false;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// 强制把 tool_use.input 转成 object。Anthropic 要求该字段必须是 object,
// 而 OpenAI 的 arguments 可能解析成 null/array/primitive。
function coerceToolInput(parsed: unknown): Record<string, unknown> {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (parsed === undefined || parsed === null) return {};
  return { value: parsed };
}

// 规范化工具 input_schema,Anthropic 要求 object 类型且至少有 properties 字段。
function normalizeInputSchema(
  parameters: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = { type: "object", properties: {} };
  if (!parameters || typeof parameters !== "object") return base;
  const p = parameters as Record<string, unknown>;
  return {
    ...base,
    ...p,
    type: typeof p.type === "string" ? p.type : "object",
    properties:
      p.properties && typeof p.properties === "object" ? p.properties : {},
  };
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
  const dropped: string[] = [];
  for (const part of content) {
    // Cursor 会把工具调用/结果作为内联 content 块塞在 user/assistant 的 content 数组里
    // (Anthropic 风格,不是 OpenAI 经典的 role:"tool"/tool_calls)。之前这里只认
    // text/image_url 导致整段工具历史被静默丢弃,模型看不到结果一直重复调工具。
    // 现在直接把 tool_use / tool_result 透传成 Anthropic 块。
    const p = part as unknown as {
      type?: string;
      text?: string;
      image_url?: { url?: string };
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (p.type === "text" && typeof p.text === "string" && p.text) {
      blocks.push({ type: "text", text: p.text });
      textParts.push(p.text);
    } else if (p.type === "image_url" && p.image_url?.url) {
      const url = p.image_url.url;
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
    } else if (p.type === "tool_use" && p.id && p.name) {
      blocks.push({
        type: "tool_use",
        id: p.id,
        name: p.name,
        input: coerceToolInput(p.input),
      });
    } else if (p.type === "tool_result" && p.tool_use_id) {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: p.tool_use_id,
        content: buildToolResultContent(p.content),
      };
      if (p.is_error === true || looksLikeToolError(p.content)) block.is_error = true;
      blocks.push(block);
    } else if (p.type) {
      dropped.push(p.type);
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `[req.content] dropped ${dropped.length} unknown part(s): ${dropped.slice(0, 5).join(",")}` +
        (dropped.length > 5 ? ` +${dropped.length - 5}` : ""),
    );
  }
  return { text: textParts.join("\n"), blocks };
}

export function openaiToAnthropic(
  req: OpenAIChatRequest,
  upstreamModel: string,
): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  // 预扫描一次:收集所有 assistant 发出过的 tool_call id,
  // 用于过滤孤儿 tool_result(Anthropic 会对找不到配对的 tool_use_id 直接 400)。
  // 同时扫内联 tool_use 块——Cursor 用 Anthropic 风格内联块时,tool_calls 是空的,
  // id 都在 content 数组里。
  const validToolCallIds = new Set<string>();
  for (const m of req.messages) {
    if (m.role === "assistant") {
      if (m.tool_calls) {
        for (const c of m.tool_calls) if (c.id) validToolCallIds.add(c.id);
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          const pp = p as unknown as { type?: string; id?: string };
          if (pp.type === "tool_use" && pp.id) validToolCallIds.add(pp.id);
        }
      }
    }
  }

  for (const msg of req.messages) {
    // OpenAI 新版协议把 system 拆成 system / developer 两种,后者是给开发者注入指令用,
    // Anthropic 没有对应概念,统一并入 system。
    if (msg.role === "system" || msg.role === "developer") {
      const { text } = normalizeContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const toolUseId = msg.tool_call_id ?? "";
      // 孤儿 tool_result 会导致上游 400,直接丢弃。通常发生在客户端只回放了部分历史、
      // 或上下文被截断把前置 assistant 丢了的时候。
      if (!toolUseId || !validToolCallIds.has(toolUseId)) {
        continue;
      }
      const resultContent = buildToolResultContent(msg.content);
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: resultContent,
      };
      if (looksLikeToolError(msg.content)) block.is_error = true;
      messages.push({ role: "user", content: [block] });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      // normalizeContent 现在已经认 text/image/tool_use/tool_result,
      // assistant 这里直接全收(tool_result 在 assistant 里不合法,但 normalizeContent
      // 不会从 assistant 的 content 里产出 tool_result,因为 Cursor 也不会这样发)。
      const { blocks: contentBlocks } = normalizeContent(msg.content);
      for (const b of contentBlocks) {
        if (b.type === "tool_result") continue; // 防御性丢弃,assistant 不该有 tool_result
        blocks.push(b);
      }
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          let parsed: unknown = {};
          try {
            parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            // 非法 JSON 通常是 Cursor 在极少数情况下没拼完整的片段;丢到空对象更安全,
            // 让模型根据后续 tool_result 自己纠错,避免塞 _raw 污染 input schema。
            parsed = {};
          }
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: coerceToolInput(parsed),
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
    // user 里的 tool_result 块要做孤儿过滤——找不到配对 tool_use 的会被上游 400。
    const filtered: AnthropicContentBlock[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        if (!b.tool_use_id || !validToolCallIds.has(b.tool_use_id)) continue;
      }
      filtered.push(b);
    }
    if (filtered.length === 0) continue;
    messages.push({ role: "user", content: filtered });
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

  const anthropicReq: AnthropicRequest = {
    model: upstreamModel,
    // 客户端显式传的 max_tokens 优先使用;未传时用 config.defaultMaxTokens(默认 8192)。
    // 之前硬给 32000 会被分发层按上限预扣,销售层账单虚高。注意这是输出上限,
    // 和 1M 上下文 beta(输入窗口)是两回事。
    max_tokens: req.max_tokens ?? config.upstream.defaultMaxTokens,
    messages: merged,
    stream: req.stream ?? false,
  };

  if (systemParts.length > 0) anthropicReq.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) anthropicReq.temperature = req.temperature;
  if (req.top_p !== undefined) anthropicReq.top_p = req.top_p;
  if (req.stop !== undefined) {
    // Anthropic 不接受空字符串 stop 序列,过滤掉空值避免 400。
    const seqs = (Array.isArray(req.stop) ? req.stop : [req.stop]).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (seqs.length > 0) anthropicReq.stop_sequences = seqs;
  }
  if (req.tools && req.tools.length > 0) {
    // 之前硬过滤 t.type === "function" 会把 Cursor 发来的工具全部吃掉——
    // 新版 OpenAI/Cursor 协议里 tool 对象可能:
    //   - 没有顶层 type 字段(直接 {function:{...}})
    //   - type 是 "custom" / 空串 / 其它值
    //   - 甚至工具直接展开到顶层 {name, description, parameters}
    // 我们这里只要能拿到工具名就接受,尽量不把 Anthropic 不支持的类型硬塞进去。
    const normalized: AnthropicTool[] = [];
    const dropped: string[] = [];
    for (const t of req.tools) {
      const tt = t as unknown as {
        type?: string;
        name?: string;
        description?: string;
        parameters?: unknown;
        input_schema?: unknown;
        function?: { name?: string; description?: string; parameters?: unknown };
      };
      // 明确声明是非 function 类型(如 code_interpreter / file_search / retrieval)的直接丢弃,
      // Anthropic 没有对应概念,硬转只会被上游 400。
      if (
        tt.type &&
        tt.type !== "function" &&
        tt.type !== "custom" &&
        tt.type !== ""
      ) {
        dropped.push(`${tt.type}:${tt.function?.name ?? tt.name ?? "?"}`);
        continue;
      }
      const fn = tt.function ?? {};
      const name = fn.name ?? tt.name;
      if (!name) {
        dropped.push(`noname:${tt.type ?? "-"}`);
        continue;
      }
      const params = fn.parameters ?? tt.parameters ?? tt.input_schema;
      normalized.push({
        name,
        description: fn.description ?? tt.description,
        input_schema: normalizeInputSchema(params),
      });
    }
    if (normalized.length > 0) anthropicReq.tools = normalized;
    if (dropped.length > 0) {
      console.warn(
        `[req.tools] dropped ${dropped.length} tool(s): ${dropped.slice(0, 5).join(", ")}` +
          (dropped.length > 5 ? ` ...(+${dropped.length - 5})` : ""),
      );
    }
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
