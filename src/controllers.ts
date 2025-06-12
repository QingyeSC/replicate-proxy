import { 
    createSSEChunk, 
    createErrorResponse, 
    createAuthErrorResponse, 
    createTimeoutErrorResponse, 
    withTimeout, 
    logError,
    // 使用新的安全日志函数
    generateRequestId,
    logRequestStart,
    logRequestMetadata,
    logApiCallStart,
    logApiCallComplete,
    logResponseComplete,
    logStreamProgress,
    logSystem
} from "./utils.ts";
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
 * @param requestId - 请求ID
 * @returns 验证结果: { isValid: boolean, apiKey?: string, response?: Response }
 */
export function validateAndExtractApiKey(authHeader: string | null, requestId: string): {
    isValid: boolean;
    apiKey?: string;
    response?: Response;
} {
    // 检查Authorization头部是否存在且格式正确
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        logSystem(`${requestId} 认证失败: 缺少或格式错误的 Authorization header`);
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
        logSystem(`${requestId} 认证失败: 无效的 Replicate API Key格式`);
        return {
            isValid: false,
            response: createAuthErrorResponse(
                "Unauthorized: Invalid Replicate API Key provided.",
                ERROR_CODES.INVALID_AUTH_KEY
            )
        };
    }

    logSystem(`${requestId} API密钥验证成功`);
    return { isValid: true, apiKey };
}

/**
 * 验证请求的模型是否支持
 * @param requestModel - 请求的模型名称
 * @param requestId - 请求ID
 * @returns 验证结果
 */
function validateRequestModel(requestModel?: string, requestId?: string): {
    isValid: boolean;
    modelName: string;
    response?: Response;
} {
    const modelName = requestModel || PROXY_MODEL_NAME;
    
    // 检查模型是否在映射列表中
    if (!MODEL_MAPPING[modelName]) {
        if (requestId) {
            logSystem(`${requestId} 不支持的模型: ${modelName}`);
        }
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
 * @param requestId - 请求ID
 * @returns OpenAI格式的错误响应
 */
function createReplicateErrorResponse(error: ReplicateError, requestId?: string): Response {
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
    
    // 记录错误（不包含用户内容）
    if (requestId) {
        logError("Replicate API错误", error, requestId);
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
 * 处理聊天完成请求（带超时控制）
 * @param req - Request对象
 * @returns Response对象的Promise
 */
export async function handleChatCompletionRequest(req: Request): Promise<Response> {
    const requestId = generateRequestId();
    const startTime = Date.now();
    
    // 记录请求开始
    logRequestStart(req, requestId);
    
    try {
        // 使用超时控制包装整个请求处理过程
        const response = await withTimeout(
            handleChatCompletionRequestInternal(req, requestId, startTime),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "请求处理超时（600秒），请稍后重试"
        );
        
        // 记录响应完成
        logResponseComplete(requestId, startTime, response.status);
        return response;
        
    } catch (error) {
        // 如果是超时错误，返回特定的超时响应
        if (error instanceof Error && error.message.includes("超时")) {
            logError("请求处理超时", error, requestId);
            const timeoutResponse = createTimeoutErrorResponse(error.message);
            logResponseComplete(requestId, startTime, timeoutResponse.status, "请求超时");
            return timeoutResponse;
        }
        
        // 其他错误按原来的方式处理
        logError("请求处理出错", error, requestId);
        const errorResponse = createErrorResponse(
            "Internal Server Error",
            500,
            "internal_error",
            ERROR_CODES.INTERNAL_ERROR
        );
        logResponseComplete(requestId, startTime, errorResponse.status, "内部错误");
        return errorResponse;
    }
}

/**
 * 内部的聊天完成请求处理函数
 * @param req - Request对象
 * @param requestId - 请求ID
 * @param startTime - 请求开始时间
 * @returns Response对象的Promise
 */
async function handleChatCompletionRequestInternal(req: Request, requestId: string, startTime: number): Promise<Response> {
    // 验证并提取API密钥
    const authValidation = validateAndExtractApiKey(req.headers.get("Authorization"), requestId);
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
            logRequestMetadata(requestId, requestBody);
        } catch (e) {
            logError("解析请求JSON失败", e, requestId);
            return createErrorResponse(
                "Invalid JSON in request body",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_JSON
            );
        }

        // 验证请求的模型
        const modelValidation = validateRequestModel(requestBody.model, requestId);
        if (!modelValidation.isValid) {
            return modelValidation.response!;
        }

        const requestModelName = modelValidation.modelName;

        // 检查是否请求流式响应
        const isStream = requestBody.stream === true;

        // 处理消息并提取必要信息
        const { userContent, systemPrompt, imageUrls } = processMessages(requestBody, requestId);

        // 检查userContent是否成功生成
        if (!userContent) {
            logSystem(`${requestId} 请求体必须包含非空的'messages'数组`);
            return createErrorResponse(
                "Request body must contain a non-empty 'messages' array.",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_MESSAGES
            );
        }

        // 构建模型输入（包含max_tokens验证）
        const input: ModelInput = buildModelInput(userContent, systemPrompt, imageUrls, requestBody.max_tokens, requestId);

        // 为本次交互生成唯一ID
        const chatCompletionId = `chatcmpl-${crypto.randomUUID()}`;

        // 创建API服务实例
        const apiService = createApiService(userApiKey, requestModelName, requestId);

        // 记录API调用开始
        logApiCallStart(requestId, requestModelName, isStream);

        // 根据是否流式决定调用方式
        if (isStream) {
            return handleStreamResponse(chatCompletionId, requestModelName, input, apiService, requestId);
        } else {
            return handleNonStreamResponse(chatCompletionId, requestModelName, input, apiService, requestId);
        }
    } catch (error) {
        // 检查是否是Replicate API错误
        if (error && typeof error === 'object' && ('status' in error || 'response' in error)) {
            return createReplicateErrorResponse(error as ReplicateError, requestId);
        }
        
        // 全局错误处理
        logError("处理程序中的未处理错误", error, requestId);
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
 * @param requestId - 请求ID
 * @returns 流式响应
 */
function handleStreamResponse(
    chatCompletionId: string,
    requestModelName: string,
    input: ModelInput,
    apiService: any,
    requestId: string
): Response {
    logSystem(`${requestId} 处理流式响应（带600秒超时控制）...`);

    const encoder = new TextEncoder();
    let chunksCount = 0;
    const apiStartTime = Date.now();
    
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
                        chunksCount++;
                        
                        // 记录流式进度（不记录内容）
                        logStreamProgress(requestId, chunksCount);
                        
                        await new Promise(resolve => setTimeout(resolve, 1)); // 微小延迟以提高并发性能
                    } else if (event.event === "done") {
                        // 根据OpenAI标准，在[DONE]之前发送一个带有finish_reason的结束块
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, requestModelName, null, null, "stop")
                        ));
                        
                        // 然后发送 [DONE] 标记
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

                        // 记录API调用完成
                        const apiDuration = Date.now() - apiStartTime;
                        logApiCallComplete(requestId, apiDuration, chunksCount);
                        logSystem(`${requestId} 流式响应完成 - 总共发送 ${chunksCount} 个块`);
                        break;
                    }
                }

                // 关闭流
                controller.close();
            } catch (error) {
                logError("流式处理期间出错", error, requestId);
                
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
 * @param requestId - 请求ID
 * @returns 非流式响应
 */
async function handleNonStreamResponse(
    chatCompletionId: string,
    requestModelName: string,
    input: ModelInput,
    apiService: any,
    requestId: string
): Promise<Response> {
    logSystem(`${requestId} 处理非流式响应（带600秒超时控制）`);

    const apiStartTime = Date.now();
    
    try {
        // 使用超时控制包装API调用
        const assistantContent = await withTimeout(
            apiService.getModelResponse(input),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "API调用超时，请稍后重试"
        );

        // 记录API调用完成（不记录响应内容）
        const apiDuration = Date.now() - apiStartTime;
        logApiCallComplete(requestId, apiDuration, assistantContent.length);

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

        logSystem(`${requestId} 非流式响应处理完成`);

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
            logError("API调用超时", error, requestId);
            return createTimeoutErrorResponse(error.message);
        }
        
        // 检查是否是Replicate API错误
        if (error && typeof error === 'object' && ('status' in error || 'response' in error)) {
            return createReplicateErrorResponse(error as ReplicateError, requestId);
        }
        
        logError("调用API错误", error, requestId);
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