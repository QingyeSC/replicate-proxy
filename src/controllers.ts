import { createSSEChunk, createErrorResponse, createAuthErrorResponse, createTimeoutErrorResponse, withTimeout, logDebug, logError } from "./utils.ts";
import { API_PATHS, CORS_HEADERS, ERROR_CODES, MODELS, PROXY_MODEL_NAME, MODEL_MAPPING, TIMEOUT_CONFIG } from "./config.ts";
import { processMessages, buildModelInput } from "./message-processor.ts";
import { createApiService, ReplicateError } from "./api-service.ts";
import { RequestBody, ChatCompletion, ModelInput } from "./types.ts";

/**
 * 处理CORS预检请求
 * @returns CORS预检请求响应
 */
export function handleCorsPreflightRequest(): Response {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
}

/**
 * 处理获取模型列表请求
 * @returns 模型列表响应
 */
export function handleModelsRequest(): Response {
    return new Response(
        JSON.stringify({
            object: "list",
            data: MODELS,
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                ...CORS_HEADERS,
            },
        }
    );
}

/**
 * 处理路径不匹配的请求
 * @returns 404错误响应
 */
export function handleNotFoundRequest(): Response {
    return createErrorResponse(
        "Not Found or Method Not Allowed",
        404,
        "invalid_request_error",
        ERROR_CODES.INVALID_JSON
    );
}

/**
 * 验证并提取Replicate API密钥
 * @param authHeader - Authorization头部值
 * @returns 验证结果: { isValid: boolean, apiKey?: string, response?: Response }
 */
export function validateAndExtractApiKey(authHeader: string | null): {
    isValid: boolean;
    apiKey?: string;
    response?: Response;
} {
    // 检查Authorization头部是否存在且格式正确
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        logDebug("认证失败: 缺少或格式错误的 Authorization header");
        return {
            isValid: false,
            response: createAuthErrorResponse(
                "Unauthorized: Missing or invalid Authorization header. Use 'Bearer <YOUR_REPLICATE_API_KEY>' format.",
                ERROR_CODES.MISSING_AUTH_HEADER
            )
        };
    }

    // 提取API密钥部分
    const apiKey = authHeader.substring(7); // "Bearer ".length is 7
    
    // 基本验证API密钥格式（Replicate API密钥通常以r8_开头）
    if (!apiKey || apiKey.length < 10) {
        logDebug("认证失败: 无效的 Replicate API Key");
        return {
            isValid: false,
            response: createAuthErrorResponse(
                "Unauthorized: Invalid Replicate API Key provided.",
                ERROR_CODES.INVALID_AUTH_KEY
            )
        };
    }

    logDebug("API密钥验证成功");
    return { isValid: true, apiKey };
}

/**
 * 验证请求的模型是否支持
 * @param requestModel - 请求的模型名称
 * @returns 验证结果
 */
function validateRequestModel(requestModel?: string): {
    isValid: boolean;
    modelName: string;
    response?: Response;
} {
    const modelName = requestModel || PROXY_MODEL_NAME;
    
    // 检查模型是否在映射列表中
    if (!MODEL_MAPPING[modelName]) {
        logDebug(`不支持的模型: ${modelName}`);
        return {
            isValid: false,
            modelName,
            response: createErrorResponse(
                `Model '${modelName}' is not supported. Available models: ${Object.keys(MODEL_MAPPING).join(', ')}`,
                400,
                "invalid_request_error",
                "model_not_found"
            )
        };
    }
    
    return { isValid: true, modelName };
}

/**
 * 创建OpenAI格式的错误响应（基于Replicate错误）
 * @param error - Replicate错误对象
 * @returns OpenAI格式的错误响应
 */
function createReplicateErrorResponse(error: ReplicateError): Response {
    const status = error.status || error.response?.status || 500;
    let errorType = "api_error";
    let errorCode = "replicate_error";
    
    // 根据HTTP状态码确定错误类型
    if (status === 400) {
        errorType = "invalid_request_error";
        errorCode = "invalid_request";
    } else if (status === 401) {
        errorType = "authentication_error"; 
        errorCode = "invalid_api_key";
    } else if (status === 403) {
        errorType = "permission_error";
        errorCode = "insufficient_quota";
    } else if (status === 404) {
        errorType = "invalid_request_error";
        errorCode = "model_not_found";
    } else if (status === 429) {
        errorType = "rate_limit_error";
        errorCode = "rate_limit_exceeded";
    }
    
    // 尝试解析Replicate的错误详情
    let errorMessage = error.message || "Unknown error occurred";
    
    if (error.response?.data) {
        try {
            const replicateErrorData = error.response.data;
            if (replicateErrorData.detail) {
                errorMessage = replicateErrorData.detail;
            } else if (replicateErrorData.error) {
                errorMessage = replicateErrorData.error;
            } else if (replicateErrorData.message) {
                errorMessage = replicateErrorData.message;
            }
        } catch (e) {
            // 如果解析失败，使用原始错误消息
        }
    }
    
    return new Response(
        JSON.stringify({
            error: {
                message: errorMessage,
                type: errorType,
                param: null,
                code: errorCode
            }
        }),
        {
            status,
            headers: {
                "Content-Type": "application/json",
                ...CORS_HEADERS,
            }
        }
    );
}

/**
 * 安全的请求体日志记录 - 只记录非敏感信息
 * @param requestBody - 请求体
 */
function logRequestBodySafely(requestBody: RequestBody): void {
    const safeLogData = {
        model: requestBody.model || "未指定",
        stream: requestBody.stream || false,
        max_tokens: requestBody.max_tokens || "未指定",
        messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
        message_roles: Array.isArray(requestBody.messages) ? requestBody.messages.map(msg => msg.role) : []
    };
    logDebug("请求参数（安全日志）", safeLogData);
}

/**
 * 处理聊天完成请求（带超时控制）
 * @param req - Request对象
 * @returns Response对象的Promise
 */
export async function handleChatCompletionRequest(req: Request): Promise<Response> {
    try {
        // 使用超时控制包装整个请求处理过程
        return await withTimeout(
            handleChatCompletionRequestInternal(req),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "请求处理超时（600秒），请稍后重试"
        );
    } catch (error) {
        // 如果是超时错误，返回特定的超时响应
        if (error instanceof Error && error.message.includes("超时")) {
            logError("请求处理超时:", error);
            return createTimeoutErrorResponse(error.message);
        }
        
        // 其他错误按原来的方式处理
        logError("请求处理出错:", error);
        return createErrorResponse(
            "Internal Server Error",
            500,
            "internal_error",
            ERROR_CODES.INTERNAL_ERROR
        );
    }
}

/**
 * 内部的聊天完成请求处理函数
 * @param req - Request对象
 * @returns Response对象的Promise
 */
async function handleChatCompletionRequestInternal(req: Request): Promise<Response> {
    // 验证并提取API密钥
    const authValidation = validateAndExtractApiKey(req.headers.get("Authorization"));
    if (!authValidation.isValid) {
        return authValidation.response!;
    }

    const userApiKey = authValidation.apiKey!;

    try {
        // 解析请求体
        let requestBody: RequestBody;
        try {
            requestBody = await req.json() as RequestBody;
            // 使用安全的日志记录方式，不记录敏感信息
            logRequestBodySafely(requestBody);
        } catch (e) {
            logError("解析请求JSON失败:", e);
            return createErrorResponse(
                "Invalid JSON in request body",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_JSON
            );
        }

        // 验证请求的模型
        const modelValidation = validateRequestModel(requestBody.model);
        if (!modelValidation.isValid) {
            return modelValidation.response!;
        }

        const requestModelName = modelValidation.modelName;

        // 检查是否请求流式响应
        const isStream = requestBody.stream === true;

        // 处理消息并提取必要信息
        const { userContent, systemPrompt, imageUrls } = processMessages(requestBody);

        // 检查userContent是否成功生成
        if (!userContent) {
            logDebug("请求体必须包含非空的'messages'数组");
            return createErrorResponse(
                "Request body must contain a non-empty 'messages' array.",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_MESSAGES
            );
        }

        // 构建模型输入（包含max_tokens验证）
        const input: ModelInput = buildModelInput(userContent, systemPrompt, imageUrls, requestBody.max_tokens);

        // 为本次交互生成唯一ID
        const chatCompletionId = `chatcmpl-${crypto.randomUUID()}`;

        // 创建API服务实例
        const apiService = createApiService(userApiKey, requestModelName);

        // 根据是否流式决定调用方式
        if (isStream) {
            return handleStreamResponse(chatCompletionId, requestModelName, input, apiService);
        } else {
            return handleNonStreamResponse(chatCompletionId, requestModelName, input, apiService);
        }
    } catch (error) {
        // 检查是否是Replicate API错误
        if (error && typeof error === 'object' && ('status' in error || 'response' in error)) {
            return createReplicateErrorResponse(error as ReplicateError);
        }
        
        // 全局错误处理
        logError("处理程序中的未处理错误:", error);
        return createErrorResponse(
            "Internal Server Error",
            500,
            "internal_error",
            ERROR_CODES.INTERNAL_ERROR
        );
    }
}

/**
 * 处理流式响应（带超时控制）
 * @param chatCompletionId - 聊天完成ID
 * @param requestModelName - 请求的模型名称
 * @param input - 模型输入
 * @param apiService - API服务实例
 * @returns 流式响应
 */
function handleStreamResponse(
    chatCompletionId: string,
    requestModelName: string,
    input: ModelInput,
    apiService: any
): Response {
    logDebug("处理流式响应（带600秒超时控制）...");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                // 处理流式输出，整个过程都在超时控制之下
                let isFirstEvent = true; // 标记是否是第一个事件

                // 使用超时控制包装流式API调用
                const streamWithTimeout = withTimeout(
                    apiService.streamModelResponse(input),
                    TIMEOUT_CONFIG.REQUEST_TIMEOUT,
                    "流式API调用超时"
                );

                for await (const event of await streamWithTimeout) {
                    // 在收到第一个事件时发送角色信息
                    if (isFirstEvent) {
                        // 块 1: 发送角色信息
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, requestModelName, null, "assistant", null)
                        ));
                        isFirstEvent = false;
                    }

                    // 只处理输出事件
                    if (event.event === "output" && typeof event.data === "string") {
                        // 发送内容块
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, requestModelName, event.data, null, null)
                        ));
                        await new Promise(resolve => setTimeout(resolve, 1)); // 微小延迟以提高并发性能
                    } else if (event.event === "done") {
                        // 发送结束信号（token使用量全部设置为0）
                        const usageInfo = {
                            prompt_tokens: 0,
                            completion_tokens: 0,
                            total_tokens: 0
                        };

                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, requestModelName, null, null, "stop", usageInfo)
                        ));

                        // 发送 [DONE] 标记
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

                        logDebug("流式响应完成");
                        break;
                    }
                }

                // 关闭流
                controller.close();
            } catch (error) {
                logError("流式处理期间出错:", error);
                
                // 发送错误信息到流中
                let errorMessage = "Stream processing failed";
                let errorCode = "stream_error";
                
                // 检查是否是超时错误
                if (error instanceof Error && error.message.includes("超时")) {
                    errorMessage = "流式响应超时，请稍后重试";
                    errorCode = "stream_timeout";
                } else if (error && typeof error === 'object' && ('status' in error || 'response' in error)) {
                    const replicateError = error as ReplicateError;
                    errorMessage = replicateError.message || "Stream processing failed";
                }
                
                const errorResponse = {
                    error: {
                        message: errorMessage,
                        type: "api_error",
                        code: errorCode
                    }
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorResponse)}\n\n`));
                
                controller.error(error);
            }
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...CORS_HEADERS
        },
    });
}

/**
 * 处理非流式响应（带超时控制）
 * @param chatCompletionId - 聊天完成ID
 * @param requestModelName - 请求的模型名称
 * @param input - 模型输入
 * @param apiService - API服务实例
 * @returns 非流式响应
 */
async function handleNonStreamResponse(
    chatCompletionId: string,
    requestModelName: string,
    input: ModelInput,
    apiService: any
): Promise<Response> {
    logDebug("处理非流式响应（带600秒超时控制）");

    try {
        // 使用超时控制包装API调用
        const assistantContent = await withTimeout(
            apiService.getModelResponse(input),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "API调用超时，请稍后重试"
        );

        // 构建最终响应（token使用量全部设置为0）
        const finalResponse: ChatCompletion = {
            id: chatCompletionId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: requestModelName, // 返回请求的模型名称，而不是实际的模型名称
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: assistantContent,
                    },
                    finish_reason: "stop",
                    logprobs: null,
                }
            ],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            },
        };

        logDebug("非流式响应处理完成");

        return new Response(JSON.stringify(finalResponse), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                ...CORS_HEADERS
            },
        });
    } catch (error) {
        // 检查是否是超时错误
        if (error instanceof Error && error.message.includes("超时")) {
            logError("API调用超时:", error);
            return createTimeoutErrorResponse(error.message);
        }
        
        // 检查是否是Replicate API错误
        if (error && typeof error === 'object' && ('status' in error || 'response' in error)) {
            return createReplicateErrorResponse(error as ReplicateError);
        }
        
        logError("调用API错误:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(
            `Failed to get response from API: ${errorMessage}`,
            500,
            "api_error",
            ERROR_CODES.API_ERROR
        );
    }
}

/**
 * 路由请求到相应的处理函数
 * @param req - Request对象
 * @returns Response对象的Promise
 */
export async function routeRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS预检请求处理
    if (req.method === "OPTIONS") {
        return handleCorsPreflightRequest();
    }

    // 模型列表接口
    if (url.pathname === API_PATHS.MODELS && req.method === "GET") {
        return handleModelsRequest();
    }

    // 聊天完成接口
    if (url.pathname === API_PATHS.CHAT_COMPLETIONS && req.method === "POST") {
        return await handleChatCompletionRequest(req);
    }

    // 处理其他路径或方法
    return handleNotFoundRequest();
}