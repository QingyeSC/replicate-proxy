import { initReplicate, DEFAULT_MODEL_ID, getActualModelId } from "./config.ts";
import { ModelInput, ReplicateEvent } from "./types.ts";
import { logDebug, logError } from "./utils.ts";

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
     * 构造函数
     * @param apiKey - 用户的Replicate API密钥
     * @param requestModelId - 请求中的模型ID
     */
    constructor(apiKey: string, requestModelId: string = DEFAULT_MODEL_ID) {
        this.apiKey = apiKey;
        this.requestModelId = requestModelId;
        this.actualModelId = getActualModelId(requestModelId) as ReplicateModelId;
        
        logDebug(`模型映射: ${requestModelId} -> ${this.actualModelId}`);
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
        logError("Replicate API错误:", error);
        
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
     * 流式调用模型API
     * @param input - 模型输入
     * @returns 异步迭代器，用于流式获取响应
     */
    async *streamModelResponse(input: ModelInput): AsyncIterable<ReplicateEvent> {
        try {
            logDebug(`开始流式API调用，实际模型: ${this.actualModelId}`);
            logDebug("输入:", input);

            const replicateClient = this.getReplicateClient();

            // 调用Replicate流式API - 使用正确的参数格式
            for await (const { event, data } of replicateClient.stream(this.actualModelId, {
                input: input
            })) {
                yield {
                    event: event,
                    data: data
                };
            }

            logDebug("流式API调用成功完成");
        } catch (error) {
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
            logDebug(`开始非流式API调用，实际模型: ${this.actualModelId}`);
            logDebug("输入:", input);

            const replicateClient = this.getReplicateClient();

            // 调用Replicate非流式API
            const prediction = await replicateClient.run(this.actualModelId, { input });
            logDebug("API响应:", prediction);

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
 * @returns ApiService实例
 */
export function createApiService(apiKey: string, requestModelId?: string): ApiService {
    return new ApiService(apiKey, requestModelId);
}