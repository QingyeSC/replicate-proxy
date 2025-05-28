import { Message, ContentItem, ModelInput, RequestBody } from "./types.ts";
import { logDebug, logError } from "./utils.ts";
import { validateMaxTokens } from "./config.ts";

/**
 * 处理消息并提取系统提示、图片URL和格式化对话内容
 * @param requestBody - 请求体
 * @returns 处理结果，包含用户内容、系统提示和图片URL
 */
export function processMessages(requestBody: RequestBody): {
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
        systemPrompt = extractSystemPrompt(messagesClone);

        // 提取图片URL
        extractImageUrls(messagesClone, imageUrls);

        // 将消息数组转换为对话格式
        userContent = formatMessagesToConversation(messagesClone);

        logDebug("提取的图片URL:", imageUrls.length > 0 ? `找到 ${imageUrls.length} 张图片` : "未找到图片");

        return { userContent, systemPrompt, imageUrls };
    } catch (e) {
        logError("处理消息数组失败:", e);
        return { userContent: undefined, systemPrompt, imageUrls };
    }
}

/**
 * 从消息数组中提取并合并所有系统提示
 * @param messages - 消息数组
 * @returns 合并后的系统提示
 */
function extractSystemPrompt(messages: Message[]): string {
    let systemPrompt = "";

    // 找出所有系统消息
    const systemMessages = messages.filter(msg => msg.role === "system");

    if (systemMessages.length > 0) {
        logDebug(`发现 ${systemMessages.length} 个系统消息，正在合并...`);
        
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

        logDebug("所有系统提示已合并并添加到输入中");
    }

    return systemPrompt.trim();
}

/**
 * 从消息中提取图片URL
 * @param messages - 消息数组
 * @param imageUrls - 存储图片URL的数组
 */
function extractImageUrls(messages: Message[], imageUrls: string[]): void {
    // 遍历消息，提取图片URL
    for (const message of messages) {
        if (message.role === "user" && Array.isArray(message.content)) {
            // 创建一个新的内容数组，只包含文本内容
            const textOnlyContent: ContentItem[] = [];

            for (const contentItem of message.content as ContentItem[]) {
                // 提取图片URL
                if (contentItem.type === "image_url" && contentItem.image_url && contentItem.image_url.url) {
                    imageUrls.push(contentItem.image_url.url);
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
}

/**
 * 将消息数组格式化为对话格式
 * @param messages - 消息数组
 * @returns 格式化后的对话内容
 */
function formatMessagesToConversation(messages: Message[]): string {
    let formattedContent = "";

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
            } else {
                // 如果是字符串，直接使用
                formattedContent += message.content;
            }

            // 添加换行
            formattedContent += "\n";
        }
    }

    logDebug("格式化的用户内容:", formattedContent);
    return formattedContent;
}

/**
 * 构建模型API输入
 * @param userContent - 用户内容
 * @param systemPrompt - 系统提示
 * @param imageUrls - 图片URL数组
 * @param maxTokens - 最大token数量（可选）
 * @returns 模型输入对象
 */
export function buildModelInput(
    userContent: string,
    systemPrompt: string,
    imageUrls: string[],
    maxTokens?: number
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
            logDebug("发现多张图片，使用最后一张");
        }
        logDebug("已将图片添加到输入中");
    }

    logDebug(`使用max_tokens: ${validatedMaxTokens}${maxTokens !== validatedMaxTokens ? ` (原始值: ${maxTokens})` : ''}`);

    return input;
}