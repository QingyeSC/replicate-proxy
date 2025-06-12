import { initReplicate, DEFAULT_MODEL_ID, getActualModelId } from "./config.ts";
import { ModelInput, ReplicateEvent } from "./types.ts";
import { logError, logSystem } from "./utils.ts";

/**
 * Replicate模型ID类型，格式为 `owner/model` 或 `owner/model:version`
 */
type ReplicateModelId = `${string}/${string}` | `${string}/${string}:${string}`;

/**
 * Replicate错误响应类型
 */
export interface ReplicateError extends Error {
    status?: number;
    response?: {
        status: number;
        statusText: string;
        data?: any;
    };
}

/**
 * API服务类，封装与Replicate API的交互
 */
export class ApiService {
    /**
     * 请求的模型ID（用于返回）
     */
    private requestModelId: string;

    /**
     * 实际的Replicate模型ID
     */
    private actualModelId: ReplicateModelId;

    /**
     * 用户的Replicate API密钥
     */
    private apiKey: string;

    /**
     * 请求ID（用于日志）
     */
    private requestId?: string;

    /**
     * 构造函数
     * @param apiKey - 用户的Replicate API密钥
     * @param requestModelId - 请求中的模型ID
     * @param requestId - 请求ID（用于日志）
     */
    constructor(apiKey: string, requestModelId: string = DEFAULT_MODEL_ID, requestId?: string) {
        this.apiKey = apiKey;
        this.requestModelId = requestModelId;
        this.actualModelId = getActualModelId(requestModelId) as ReplicateModelId;
        this.requestId = requestId;
        
        if (requestId) {
            logSystem(`${requestId} 模型映射: ${requestModelId} -> ${this.actualModelId}`);
        }
    }

    /**
     * 获取Replicate客户端实例
     */
    private getReplicateClient() {
        return initReplicate(this.apiKey);
    }

    /**
     * 处理Replicate API错误，保持原始错误格式
     */
    private handleReplicateError(error: any): never {
        logError("Replicate API错误", error, this.requestId);
        
        // 如果是Replicate API的错误响应，直接抛出
        if (error.response) {
            const replicateError = new Error(error.message || "Replicate API Error") as ReplicateError;
            replicateError.status = error.response.status;
            replicateError.response = error.response;
            throw replicateError;
        }
        
        // 如果有status属性，保持原样
        if (error.status) {
            throw error;
        }
        
        // 其他错误，包装为500错误
        const wrappedError = new Error(error.message || String(error)) as ReplicateError;
        wrappedError.status = 500;
        throw wrappedError;
    }

    /**
     * 安全地记录输入参数的元数据（不记录实际内容）
     * @param input - 模型输入
     */
    private logInputMetadata(input: ModelInput): void {
        if (!this.requestId) return;
        
        const inputMetadata = {
            prompt_length: input.prompt.length,
            system_prompt_length: input.system_prompt?.length || 0,
            max_tokens: input.max_tokens,
            has_image: !!input.image,
            max_image_resolution: input.max_image_resolution
        };
        
        logSystem(`${this.requestId} API调用输入参数`, inputMetadata);
    }

    /**
     * 安全地记录响应元数据（不记录实际内容）
     * @param response - API响应
     */
    private logResponseMetadata(response: any): void {
        if (!this.requestId) return;
        
        if (Array.isArray(response)) {
            const totalLength = response.join("").length;
            logSystem(`${this.requestId} API响应完成 - 数组格式，总长度: ${totalLength}字符，块数: ${response.length}`);
        } else {
            const responseStr = String(response);
            logSystem(`${this.requestId} API响应完成 - 字符串格式，长度: ${responseStr.length}字符`);
        }
    }

    /**
     * 验证事件数据是否为有效的文本内容
     * @param data - 事件数据
     * @returns 是否为有效的文本内容
     */
    private isValidTextContent(data: any): boolean {
        // 必须是字符串
        if (typeof data !== 'string') {
            return false;
        }
        
        // 不能为空字符串
        if (data.length === 0) {
            return false;
        }
        
        // 过滤掉明显无效的内容
        const trimmedData = data.trim();
        if (trimmedData === '' || 
            trimmedData === '{}' || 
            trimmedData === '[]' || 
            trimmedData === 'null' || 
            trimmedData === 'undefined') {
            return false;
        }
        
        return true;
    }

    /**
     * 流式调用模型API
     * @param input - 模型输入
     * @returns 异步迭代器，用于流式获取响应
     */
    async *streamModelResponse(input: ModelInput): AsyncIterable<ReplicateEvent> {
        try {
            if (this.requestId) {
                logSystem(`${this.requestId} 开始流式API调用，实际模型: ${this.actualModelId}`);
            }
            
            // 安全地记录输入参数元数据
            this.logInputMetadata(input);

            const replicateClient = this.getReplicateClient();

            // 基于官方示例修复流式API调用
            try {
                if (this.requestId) {
                    logSystem(`${this.requestId} 使用官方推荐的 stream 方法进行流式调用`);
                }
                
                let chunksReceived = 0;
                let totalLength = 0;
                
                // 直接使用官方示例的调用方式
                for await (const event of replicateClient.stream(this.actualModelId, { input })) {
                    // 根据官方示例，event 直接就是字符串内容
                    if (this.isValidTextContent(event)) {
                        chunksReceived++;
                        totalLength += event.length;
                        
                        // 安全地记录处理进度（不记录实际内容）
                        if (this.requestId && chunksReceived % 20 === 0) {
                            logSystem(`${this.requestId} 流式处理进度 - 已接收 ${chunksReceived} 个块，总长度: ${totalLength}字符`);
                        }
                        
                        yield {
                            event: 'output',
                            data: event as string
                        };
                    }
                    // 处理可能的事件对象格式（严格验证）
                    else if (event && typeof event === 'object') {
                        // 检查是否是标准的事件对象格式
                        if ('event' in event && 'data' in event) {
                            const eventData = event.data;
                            const eventType = event.event;
                            
                            // 只处理有效的输出事件
                            if (eventType === 'output' && this.isValidTextContent(eventData)) {
                                chunksReceived++;
                                totalLength += eventData.length;
                                yield {
                                    event: 'output',
                                    data: eventData
                                };
                            }
                            // 处理完成事件
                            else if (eventType === 'done' || eventType === 'completed') {
                                yield {
                                    event: 'done',
                                    data: undefined
                                };
                                break;
                            }
                        }
                        // 检查是否只有data字段
                        else if ('data' in event && this.isValidTextContent(event.data)) {
                            chunksReceived++;
                            totalLength += event.data.length;
                            yield {
                                event: 'output',
                                data: event.data
                            };
                        }
                        // 其他对象格式，记录并跳过
                        else {
                            if (this.requestId) {
                                logSystem(`${this.requestId} 跳过非文本事件对象: ${JSON.stringify(event).substring(0, 100)}`);
                            }
                        }
                    }
                    // 完全跳过无效数据，不转换为字符串
                    else {
                        if (this.requestId && event !== null && event !== undefined) {
                            const eventPreview = String(event).substring(0, 50);
                            logSystem(`${this.requestId} 跳过无效事件数据: ${eventPreview}`);
                        }
                    }
                }
                
                // 发送完成事件
                yield {
                    event: 'done',
                    data: undefined
                };
                
                if (this.requestId) {
                    logSystem(`${this.requestId} 流式API调用成功完成 - 总块数: ${chunksReceived}，总长度: ${totalLength}字符`);
                }

            } catch (streamError) {
                logError("流式方法失败，尝试回退方案", streamError, this.requestId);
                
                // 回退方案：使用 run 方法并模拟流式响应
                if (this.requestId) {
                    logSystem(`${this.requestId} 使用 run 方法作为回退方案`);
                }
                
                const prediction = await replicateClient.run(this.actualModelId, { input });
                
                // 记录回退方案的响应元数据
                this.logResponseMetadata(prediction);
                
                // 模拟流式响应
                if (prediction) {
                    let content = "";
                    if (Array.isArray(prediction)) {
                        content = prediction.join("");
                    } else {
                        content = String(prediction);
                    }
                    
                    // 验证内容是否有效
                    if (this.isValidTextContent(content)) {
                        // 将内容分成小块进行模拟流式输出
                        const chunkSize = 15; // 每个块的字符数
                        let chunksCount = 0;
                        for (let i = 0; i < content.length; i += chunkSize) {
                            const chunk = content.slice(i, i + chunkSize);
                            if (this.isValidTextContent(chunk)) {
                                yield {
                                    event: 'output',
                                    data: chunk
                                };
                                chunksCount++;
                                
                                // 添加小延迟以模拟流式效果
                                await new Promise(resolve => setTimeout(resolve, 30));
                            }
                        }
                        
                        if (this.requestId) {
                            logSystem(`${this.requestId} 回退方案执行成功 - 模拟了 ${chunksCount} 个块`);
                        }
                    }
                    
                    // 发送完成事件
                    yield {
                        event: 'done',
                        data: undefined
                    };
                }
            }

        } catch (error) {
            logError("流式API调用失败", error, this.requestId);
            this.handleReplicateError(error);
        }
    }

    /**
     * 非流式调用模型API
     * @param input - 模型输入
     * @returns 模型响应
     */
    async getModelResponse(input: ModelInput): Promise<string> {
        try {
            if (this.requestId) {
                logSystem(`${this.requestId} 开始非流式API调用，实际模型: ${this.actualModelId}`);
            }
            
            // 安全地记录输入参数元数据
            this.logInputMetadata(input);

            const replicateClient = this.getReplicateClient();

            // 调用Replicate非流式API
            const prediction = await replicateClient.run(this.actualModelId, { input });
            
            // 安全地记录响应元数据（不记录实际内容）
            this.logResponseMetadata(prediction);

            // 处理不同类型的返回值
            if (Array.isArray(prediction)) {
                // 如果返回的是数组，拼接所有元素
                return prediction.join("");
            } else {
                // 如果返回的不是数组，转换为字符串
                return String(prediction);
            }
        } catch (error) {
            this.handleReplicateError(error);
        }
    }

    /**
     * 获取请求的模型ID
     * @returns 请求的模型ID
     */
    getRequestModelId(): string {
        return this.requestModelId;
    }

    /**
     * 获取实际的Replicate模型ID
     * @returns 实际的模型ID
     */
    getActualModelId(): ReplicateModelId {
        return this.actualModelId;
    }
}

/**
 * 创建API服务实例
 * @param apiKey - 用户的Replicate API密钥
 * @param requestModelId - 请求中的模型ID
 * @param requestId - 请求ID（用于日志）
 * @returns ApiService实例
 */
export function createApiService(apiKey: string, requestModelId?: string, requestId?: string): ApiService {
    return new ApiService(apiKey, requestModelId, requestId);
}