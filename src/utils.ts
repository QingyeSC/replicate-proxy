import { SSEChunk } from "./types.ts";

/**
 * 为 Promise 添加超时控制
 * 这个函数可以让任何异步操作在指定时间后自动取消
 * @param promise - 要包装的 Promise（比如 API 调用）
 * @param timeoutMs - 超时时间（毫秒）
 * @param errorMessage - 超时时显示的错误消息
 * @returns 带超时控制的 Promise
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string = "操作超时"
): Promise<T> {
    return Promise.race([
        promise, // 原始的异步操作
        new Promise<never>((_, reject) => {
            // 创建一个在指定时间后拒绝的 Promise
            setTimeout(() => {
                reject(new Error(errorMessage));
            }, timeoutMs);
        })
    ]);
}

/**
 * 创建 SSE 数据块
 * @param id - 事件ID
 * @param model - 模型名称
 * @param content - 内容
 * @param role - 角色
 * @param finish_reason - 完成原因
 * @param usage - 使用情况统计（固定为0）
 * @returns SSE数据块字符串
 */
export function createSSEChunk(
  id: string, 
  model: string, 
  content: string | null, 
  role: string | null, 
  finish_reason: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
  const now = Math.floor(Date.now() / 1000);
  const chunk: SSEChunk = {
    id: id,
    object: "chat.completion.chunk",
    created: now,
    model: model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finish_reason,
        logprobs: null,
      }
    ],
  };
  
  if (role) {
    chunk.choices[0].delta.role = role;
  }
  
  if (content) {
    chunk.choices[0].delta.content = content;
  }
  
  // 如果 delta 为空且有 finish_reason，确保 delta 是空对象
  if (!role && !content && finish_reason) {
    chunk.choices[0].delta = {};
  }
  
  // 如果提供了usage信息，添加到chunk中（全部设置为0）
  if (usage && finish_reason === "stop") {
    (chunk as any).usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };
  }
  
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 创建错误响应
 * @param message - 错误消息
 * @param status - 状态码
 * @param type - 错误类型
 * @param code - 错误代码
 * @returns Response对象
 */
export function createErrorResponse(
  message: string, 
  status: number, 
  type: string = "invalid_request_error", 
  code: string = "error"
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code
      }
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    }
  );
}

/**
 * 创建授权错误响应
 * @param message - 错误消息
 * @param code - 错误代码
 * @returns Response对象
 */
export function createAuthErrorResponse(message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code
      }
    }),
    {
      status: 401, // Unauthorized
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "WWW-Authenticate": 'Bearer realm="API Access"'
      }
    }
  );
}

/**
 * 创建超时错误响应
 * @param message - 错误消息
 * @returns Response对象
 */
export function createTimeoutErrorResponse(message: string = "请求处理超时，请稍后重试"): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "timeout_error",
        param: null,
        code: "request_timeout"
      }
    }),
    {
      status: 408, // Request Timeout
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    }
  );
}

/**
 * 记录调试信息到控制台
 * @param label - 标签
 * @param data - 数据
 */
export function logDebug(label: string, data?: any): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [DEBUG] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`[${timestamp}] [DEBUG] ${label}`);
  }
}

/**
 * 记录错误信息到控制台
 * @param label - 标签
 * @param error - 错误
 */
export function logError(label: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [ERROR] ${label}`, error instanceof Error ? error.message : String(error));
  
  // 如果是Error对象，也记录堆栈信息
  if (error instanceof Error && error.stack) {
    console.error(`[${timestamp}] [ERROR] Stack trace:`, error.stack);
  }
}

/**
 * 记录信息到控制台
 * @param label - 标签
 * @param data - 数据
 */
export function logInfo(label: string, data?: any): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [INFO] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`[${timestamp}] [INFO] ${label}`);
  }
}

/**
 * 记录警告信息到控制台
 * @param label - 标签
 * @param data - 数据
 */
export function logWarn(label: string, data?: any): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.warn(`[${timestamp}] [WARN] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.warn(`[${timestamp}] [WARN] ${label}`);
  }
}

/**
 * 安全的JSON解析
 * @param jsonString - JSON字符串
 * @param defaultValue - 解析失败时的默认值
 * @returns 解析结果或默认值
 */
export function safeJsonParse<T>(jsonString: string, defaultValue: T): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logWarn("JSON解析失败", { jsonString, error: String(error) });
    return defaultValue;
  }
}

/**
 * 格式化文件大小
 * @param bytes - 字节数
 * @returns 格式化后的文件大小字符串
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 生成唯一ID
 * @param prefix - 前缀
 * @returns 唯一ID
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2);
  return prefix ? `${prefix}_${timestamp}_${randomStr}` : `${timestamp}_${randomStr}`;
}

/**
 * 延迟执行
 * @param ms - 延迟毫秒数
 * @returns Promise
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 验证字符串是否为有效的URL
 * @param urlString - URL字符串
 * @returns 是否为有效URL
 */
export function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * 截断字符串
 * @param str - 原始字符串
 * @param maxLength - 最大长度
 * @param suffix - 后缀
 * @returns 截断后的字符串
 */
export function truncateString(str: string, maxLength: number, suffix: string = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * 清理和标准化字符串
 * @param str - 原始字符串
 * @returns 清理后的字符串
 */
export function sanitizeString(str: string): string {
  return str
    .trim()
    .replace(/\s+/g, ' ')  // 多个空白字符替换为单个空格
    .replace(/[\r\n\t]/g, ' '); // 换行符和制表符替换为空格
}

/**
 * 获取环境变量，如果不存在则返回默认值
 * @param key - 环境变量键
 * @param defaultValue - 默认值
 * @returns 环境变量值或默认值
 */
export function getEnvVar(key: string, defaultValue: string = ''): string {
  return Deno.env.get(key) ?? defaultValue;
}

/**
 * 检查对象是否为空
 * @param obj - 要检查的对象
 * @returns 是否为空对象
 */
export function isEmpty(obj: any): boolean {
  if (obj == null) return true;
  if (Array.isArray(obj) || typeof obj === 'string') return obj.length === 0;
  if (typeof obj === 'object') return Object.keys(obj).length === 0;
  return false;
}

/**
 * 深度克隆对象
 * @param obj - 要克隆的对象
 * @returns 克隆后的对象
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as any;
  if (obj instanceof Array) return obj.map(item => deepClone(item)) as any;
  if (typeof obj === 'object') {
    const cloned = {} as any;
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    return cloned;
  }
  return obj;
}