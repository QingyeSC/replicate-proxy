import { Message, ContentItem, ModelInput, RequestBody } from "./types.ts";
import { logError, logSystem } from "./utils.ts";
import { validateMaxTokens } from "./config.ts";

/**
 * 处理消息并提取系统提示、图片URL和格式化对话内容
 * @param requestBody - 请求体
 * @param requestId - 请求ID（用于日志）
 * @returns 处理结果，包含用户内容、系统提示和图片URL
 */
export function processMessages(requestBody: RequestBody, requestId?: string): {
    userContent: string | undefined;
    systemPrompt: string;
    imageUrls: string[];
} {
    let userContent: string | undefined;
    const imageUrls: string[] = [];
    let systemPrompt = "";

    if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
        return { userContent: undefined, systemPrompt, imageUrls };
    }

    try {
        // 创建消息数组的深拷贝，以便安全地修改
        const messagesClone = JSON.parse(JSON.stringify(requestBody.messages));

        // 提取并合并所有系统消息
        systemPrompt = extractSystemPrompt(messagesClone, requestId);

        // 提取图片URL
        extractImageUrls(messagesClone, imageUrls, requestId);

        // 将消息数组转换为对话格式
        userContent = formatMessagesToConversation(messagesClone, requestId);

        // 安全地记录处理结果的元数据（不记录实际内容）
        if (requestId) {
            logSystem(`${requestId} 消息处理完成 - 图片数量: ${imageUrls.length}, 系统提示长度: ${systemPrompt.length}字符, 对话内容长度: ${userContent?.length || 0}字符`);
        }

        return { userContent, systemPrompt, imageUrls };
    } catch (e) {
        logError("处理消息数组失败", e, requestId);
        return { userContent: undefined, systemPrompt, imageUrls };
    }
}

/**
 * 从消息数组中提取并合并所有系统提示
 * @param messages - 消息数组
 * @param requestId - 请求ID（用于日志）
 * @returns 合并后的系统提示
 */
function extractSystemPrompt(messages: Message[], requestId?: string): string {
    let systemPrompt = "";

    // 找出所有系统消息
    const systemMessages = messages.filter(msg => msg.role === "system");

    if (systemMessages.length > 0) {
        if (requestId) {
            logSystem(`${requestId} 发现 ${systemMessages.length} 个系统消息，正在合并...`);
        }
        
        // 处理每个系统消息并合并
        for (const sysMsg of systemMessages) {
            if (typeof sysMsg.content === "string") {
                systemPrompt += sysMsg.content + "\n";
            } else if (Array.isArray(sysMsg.content)) {
                // 如果是数组，只提取文本部分
                for (const item of sysMsg.content) {
                    if (item.type === "text" && item.text) {
                        systemPrompt += item.text + "\n";
                    }
                }
            }
        }

        // 从消息数组中移除所有系统消息
        const nonSystemMessages = messages.filter(msg => msg.role !== "system");
        messages.length = 0; // 清空原数组
        messages.push(...nonSystemMessages); // 添加非系统消息

        if (requestId) {
            logSystem(`${requestId} 所有系统提示已合并 - 总长度: ${systemPrompt.trim().length}字符`);
        }
    }

    return systemPrompt.trim();
}

/**
 * 从消息中提取图片URL
 * @param messages - 消息数组
 * @param imageUrls - 存储图片URL的数组
 * @param requestId - 请求ID（用于日志）
 */
function extractImageUrls(messages: Message[], imageUrls: string[], requestId?: string): void {
    let totalImages = 0;
    
    // 遍历消息，提取图片URL
    for (const message of messages) {
        if (message.role === "user" && Array.isArray(message.content)) {
            // 创建一个新的内容数组，只包含文本内容
            const textOnlyContent: ContentItem[] = [];

            for (const contentItem of message.content as ContentItem[]) {
                // 提取图片URL
                if (contentItem.type === "image_url" && contentItem.image_url && contentItem.image_url.url) {
                    imageUrls.push(contentItem.image_url.url);
                    totalImages++;
                    // 不将图片添加到文本内容中
                } else if (contentItem.type === "text") {
                    // 保留文本内容
                    textOnlyContent.push(contentItem);
                }
            }

            // 替换原始内容为只包含文本的内容
            message.content = textOnlyContent;
        }
    }
    
    if (totalImages > 0 && requestId) {
        logSystem(`${requestId} 提取了 ${totalImages} 张图片`);
    }
}

/**
 * 将消息数组格式化为对话格式
 * @param messages - 消息数组
 * @param requestId - 请求ID（用于日志）
 * @returns 格式化后的对话内容
 */
function formatMessagesToConversation(messages: Message[], requestId?: string): string {
    let formattedContent = "";
    let messageCount = 0;
    let totalLength = 0;

    for (const message of messages) {
        if (message.role && (message.content || Array.isArray(message.content))) {
            // 添加角色前缀
            formattedContent += `${message.role}: `;

            // 处理内容
            if (Array.isArray(message.content)) {
                // 如果是数组，提取所有文本部分
                const textParts = (message.content as ContentItem[])
                    .filter(item => item.type === "text")
                    .map(item => item.text || "")
                    .join(" ");
                formattedContent += textParts;
                totalLength += textParts.length;
            } else {
                // 如果是字符串，直接使用
                formattedContent += message.content;
                totalLength += message.content.length;
            }

            // 添加换行
            formattedContent += "\n";
            messageCount++;
        }
    }

    // 安全地记录格式化结果（不记录实际内容）
    if (requestId) {
        logSystem(`${requestId} 格式化完成 - 消息数量: ${messageCount}, 总长度: ${totalLength}字符`);
    }

    return formattedContent;
}

/**
 * 构建模型API输入
 * @param userContent - 用户内容
 * @param systemPrompt - 系统提示
 * @param imageUrls - 图片URL数组
 * @param maxTokens - 最大token数量（可选）
 * @param requestId - 请求ID（用于日志）
 * @returns 模型输入对象
 */
export function buildModelInput(
    userContent: string,
    systemPrompt: string,
    imageUrls: string[],
    maxTokens?: number,
    requestId?: string
): ModelInput {
    const validatedMaxTokens = validateMaxTokens(maxTokens);
    
    const input: ModelInput = {
        prompt: userContent,
        max_tokens: validatedMaxTokens,
        system_prompt: systemPrompt,
        max_image_resolution: 0.5
    };

    // 如果有图片，添加到input中
    if (imageUrls.length > 0) {
        // 如果只有一张图片，直接设置 image 字段
        if (imageUrls.length === 1) {
            input.image = imageUrls[0];
        } else {
            // 如果有多张图片，使用最后一张
            const lastImage = imageUrls[imageUrls.length - 1];
            input.image = lastImage;
            if (requestId) {
                logSystem(`${requestId} 发现多张图片，使用最后一张`);
            }
        }
        if (requestId) {
            logSystem(`${requestId} 已将图片添加到输入中`);
        }
    }

    // 安全地记录输入参数的元数据（不记录实际内容）
    if (requestId) {
        const inputMetadata = {
            prompt_length: userContent.length,
            system_prompt_length: systemPrompt.length,
            max_tokens: validatedMaxTokens,
            has_image: !!input.image,
            max_image_resolution: input.max_image_resolution
        };
        logSystem(`${requestId} 构建模型输入完成`, inputMetadata);
        
        if (maxTokens !== validatedMaxTokens) {
            logSystem(`${requestId} max_tokens已调整: ${maxTokens} -> ${validatedMaxTokens}`);
        }
    }

    return input;
}