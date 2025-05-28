/**
 * 请求体接口
 */
export interface RequestBody {
  messages: Message[];
  model?: string;
  stream?: boolean;
  max_tokens?: number;
}

/**
 * 消息接口
 */
export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentItem[];
}

/**
 * 内容项接口
 */
export interface ContentItem {
  type: string;
  text?: string;
  image_url?: {
    url: string;
  };
}

/**
 * SSE数据块接口
 */
export interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: SSEChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * SSE选择项接口
 */
export interface SSEChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
  };
  finish_reason: string | null;
  logprobs: null;
}

/**
 * Replicate流式事件接口
 */
export interface ReplicateEvent {
  event: string;
  data?: string;
}

/**
 * 模型输入接口
 */
export interface ModelInput {
  prompt: string;
  max_tokens: number;
  system_prompt?: string;
  max_image_resolution?: number;
  image?: string;
}

/**
 * 聊天完成响应接口
 */
export interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 聊天完成选择项接口
 */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
  logprobs: null;
}

/**
 * 错误响应接口
 */
export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    param: null;
    code: string;
  };
}