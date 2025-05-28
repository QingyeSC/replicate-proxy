import Replicate from "replicate";

/**
 * 模型映射配置：请求模型名 -> Replicate实际模型名
 */
export const MODEL_MAPPING: Record<string, string> = {
    "claude-sonnet-4-20250514": "anthropic/claude-4-sonnet",
    "claude-3-7-sonnet-20250219": "anthropic/claude-3.7-sonnet", 
    "claude-3-5-sonnet-20241022": "anthropic/claude-3.5-sonnet",
    // 兼容旧格式
    "anthropic/claude-4-sonnet": "anthropic/claude-4-sonnet",
    "anthropic/claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "anthropic/claude-3.5-sonnet": "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku": "anthropic/claude-3.5-haiku"
};

/**
 * 代理服务返回的默认模型名称
 */
export const PROXY_MODEL_NAME = "claude-3-7-sonnet-20250219";

/**
 * 默认模型 ID
 */
export const DEFAULT_MODEL_ID = "claude-3-7-sonnet-20250219";

/**
 * max_tokens配置
 */
export const MAX_TOKENS_CONFIG = {
    MINIMUM: 1024,
    MAXIMUM: 64000,
    DEFAULT: 16384
};

/**
 * 初始化 Replicate 客户端
 * @param apiKey 用户提供的API密钥
 */
export const initReplicate = (apiKey: string): Replicate => {
    return new Replicate({
        auth: apiKey,
    });
};

/**
 * API 路径配置
 */
export const API_PATHS = {
    MODELS: "/v1/models",
    CHAT_COMPLETIONS: "/v1/chat/completions"
};

/**
 * 响应头配置
 */
export const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
};

/**
 * 错误代码配置
 */
export const ERROR_CODES = {
    MISSING_AUTH_HEADER: "missing_or_invalid_header",
    INVALID_AUTH_KEY: "invalid_auth_key",
    INVALID_JSON: "invalid_json",
    INVALID_MESSAGES: "invalid_messages",
    API_ERROR: "api_error",
    INTERNAL_ERROR: "internal_error"
};

/**
 * 根据模型映射获取实际的Replicate模型ID
 * @param requestModel - 请求中的模型名称
 * @returns 实际的Replicate模型ID
 */
export function getActualModelId(requestModel: string): string {
    return MODEL_MAPPING[requestModel] || MODEL_MAPPING[DEFAULT_MODEL_ID];
}

/**
 * 验证max_tokens参数并返回规范化的值
 * @param maxTokens - 用户请求的max_tokens
 * @returns 规范化后的max_tokens值
 */
export function validateMaxTokens(maxTokens?: number): number {
    if (!maxTokens || maxTokens < MAX_TOKENS_CONFIG.MINIMUM) {
        return MAX_TOKENS_CONFIG.DEFAULT;
    }
    if (maxTokens > MAX_TOKENS_CONFIG.MAXIMUM) {
        return MAX_TOKENS_CONFIG.MAXIMUM;
    }
    return maxTokens;
}

/**
 * 模型配置 - 返回映射后的模型列表
 */
export const MODELS = Object.keys(MODEL_MAPPING)
    .filter(modelId => !modelId.startsWith("anthropic/")) // 过滤掉兼容格式，只显示新格式
    .map(modelId => ({
        id: modelId,
        object: "model",
        created: 0,
        owned_by: "anthropic",
        permission: [{
            id: `modelperm-${modelId}`,
            object: "model_permission",
            created: 0,
            allow_create_engine: false,
            allow_sampling: true,
            allow_logprobs: false,
            allow_search_indices: false,
            allow_view: true,
            allow_fine_tuning: false,
            organization: "*",
            group: null,
            is_blocking: false,
        }],
        root: modelId,
        parent: null,
    }));