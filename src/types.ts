// ===== 通用 Gemini (official REST) 类型 =====

import type { RacingConfig } from "./racing.ts";
import type { ThinkingConfig } from "./thinking.ts";

export interface GPartText { text: string }
export interface GPartFunctionCall { functionCall: { name: string; args?: Record<string, unknown> } }
export interface GPartFunctionResponse { functionResponse: { name: string; response: Record<string, unknown> } }
export interface GInlineData { mime_type: string; data: string } // data = base64
export interface GPartInlineData { inlineData: GInlineData }
export interface GPartFileData { fileData: { mime_type?: string; fileUri: string } }
export interface GPartExecutableCode { executableCode?: unknown; codeExecutionResult?: unknown }

export type GPart =
  | GPartText
  | GPartFunctionCall
  | GPartFunctionResponse
  | GPartInlineData
  | GPartFileData
  | Record<string, unknown>;

export interface GContent {
  role?: "user" | "model";
  parts: GPart[];
}

export interface GSchemaLike extends Record<string, unknown> {}

export interface GTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: GSchemaLike;
  }>;
}

export interface GToolConfig {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE";
    allowedFunctionNames?: string[];
  };
}

export interface GGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  seed?: number;
  responseMimeType?: string;
  responseSchema?: GSchemaLike;
  responseJsonSchema?: GSchemaLike;
  presencePenalty?: number;
  frequencyPenalty?: number;
  thinkingConfig?: ThinkingConfig;
  responseModalities?: string[];
  imageConfig?: Record<string, unknown>;
  speechConfig?: Record<string, unknown>;
}

export interface GSafetySetting { category: string; threshold: string }

export interface GRequest {
  contents: GContent[];
  systemInstruction?: GContent;
  tools?: GTool[];
  toolConfig?: GToolConfig;
  generationConfig?: GGenerationConfig;
  safetySettings?: GSafetySetting[];
  labels?: Record<string, string>;
}

export interface GUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GCandidate {
  content?: GContent;
  finishReason?: string;
  index?: number;
  safetyRatings?: unknown[];
  citationMetadata?: unknown;
}

export interface GResponse {
  candidates?: GCandidate[];
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
  usageMetadata?: GUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  createTime?: string;
  modelStatus?: string;
  error?: { code?: number; message?: string; status?: string };
}

// ===== OpenAI Chat Completions 类型（子集） =====

export interface OImageUrl { url: string; detail?: string }
export type OContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: OImageUrl }
  | { type: string; [k: string]: unknown };

export interface OToolCall {
  index?: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OContentPart[] | null;
  name?: string;
  tool_calls?: OToolCall[];
  tool_call_id?: string;
}

export interface OFunctionDef { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }

export interface ORequest {
  model: string;
  messages: OMessage[];
  tools?: Array<{ type: "function"; function: OFunctionDef }>;
  tool_choice?: string | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  n?: number;
  seed?: number;
  response_format?: { type: string; json_schema?: Record<string, unknown> };
  user?: string;
  parallel_tool_calls?: boolean;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning_effort?: string;
  [k: string]: unknown;
}

// ===== Anthropic Messages 类型（子集） =====

export type AImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export type AContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AImageSource }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string | AContentBlock[]; is_error?: boolean }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: string; [k: string]: unknown };

export interface AMessage { role: "user" | "assistant" | "system"; content: string | AContentBlock[] }

export interface AToolDef { name: string; description?: string; input_schema: Record<string, unknown> }

export interface ARequest {
  model: string;
  messages: AMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AToolDef[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  metadata?: { user_id?: string };
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string } | string;
}

// ===== OpenAI Responses API（/v1/responses，移植自原项目 responses_handler.go） =====

export interface RInputImage { url?: string; detail?: string }

export interface RInputItem {
  type?: string; // ""/message/function_call/function_call_output/reasoning
  role?: string;
  content?: string | Array<{ type?: string; text?: string; image_url?: RInputImage | string }>;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  namespace?: string;
  summary?: unknown;
  [k: string]: unknown;
}

export interface RToolFunction { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
export type RTool = { type: "function"; name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } | { type: "namespace"; name: string; tools?: RTool[] } | { type: string; [k: string]: unknown };

export interface RRequest {
  model: string;
  input?: string | RInputItem[];
  instructions?: string | Array<{ type?: string; text?: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: unknown };
  text?: { format?: { type?: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } } };
  tools?: RTool[];
  tool_choice?: string | { type?: string; name?: string; function?: { name?: string } };
  metadata?: unknown;
  previous_response_id?: string | null;
  store?: boolean;
  truncation?: string;
}

// ===== Worker 配置 =====

export interface VProxyConfig {
  /** 上游 Gemini 官方 API Key（单个 —— 对齐原项目“单 Key 直连”模式；兼容读取旧 gemini_keys[0]） */
  gemini_key: string;
  /** 客户端鉴权 Key 列表（多客户端可区分用量统计） */
  api_keys: string[];
  proxies: string[];
  subscription: string;
  model_aliases: Record<string, string>;
  disabled_models: string[];
  subscription_refresh_minutes: number;
  /** 并发竞速与节点健康度（移植自原项目对冲竞速） */
  racing: RacingConfig;
  /** 移除客户端的输出 token 上限（避免思考 token 挤占正文；Gemini 3.6+ 始终移除） */
  drop_max_tokens: boolean;
  /** 单次 HTTP 请求体上限（MiB，钳位 1–1024） */
  max_request_mb: number;
  /** 全局并发上游请求门（超出返回 503 + Retry-After） */
  max_concurrent_requests: number;
  /** 聚合流：所有端点把非流式响应伪装成流式（无需 fake- 前缀） */
  aggregate_stream: boolean;
  /** 上游 Gemini 官方 API 基地址覆盖（镜像/中转，原项目 gemini_api_base_url）；留空使用官方地址 */
  gemini_base_url: string;
  /** OpenAI n 参数上限（原项目 max_n，默认 8、钳位 1–32）；n>1 时并发 n 次上游请求合并 choices */
  max_n: number;
  /** 定时健康巡检（原项目 proxy_health_check_*，由 Cron Triggers 驱动） */
  health_check: import("./racing.ts").HealthCheckConfig;
  /** 部署保活地址（配合 Cron Triggers 定时 GET；留空关闭） */
  keepalive_url: string;
  /** 保活间隔（秒，5–86400，仅作文档提示；实际节奏由 Cron 触发器决定） */
  keepalive_interval: number;
  /** Claude 提示词策略（/v1/messages 与 count_tokens 生效） */
  claude_prompt: import("./promptpolicy.ts").ClaudePromptPolicy;
}
