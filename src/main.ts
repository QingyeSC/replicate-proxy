import { routeRequest } from "./controllers.ts";
import { logDebug, logError, withTimeout, createTimeoutErrorResponse } from "./utils.ts";
import { TIMEOUT_CONFIG } from "./config.ts";

/**
 * 主请求处理函数（带600秒超时控制）
 * 接收所有传入的HTTP请求并将其路由到相应的处理函数
 * 
 * @param req - 传入的Request对象
 * @returns Promise<Response> - 响应对象
 */
async function handler(req: Request): Promise<Response> {
    try {
        // 记录请求信息
        logDebug(`收到请求: ${req.method} ${new URL(req.url).pathname}`);
        
        // 使用超时控制将请求路由到合适的处理函数
        // 设置600秒（10分钟）的全局超时时间
        return await withTimeout(
            routeRequest(req),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "请求处理总体超时（600秒），请稍后重试"
        );
        
    } catch (error) {
        // 检查是否是超时错误
        if (error instanceof Error && error.message.includes("超时")) {
            logError("请求处理超时:", error);
            return createTimeoutErrorResponse(error.message);
        }
        
        // 全局错误处理，确保服务不会因为未处理的异常而中断
        logError("主处理程序中的未处理错误:", error);
        return new Response(JSON.stringify({ 
            error: "Internal Server Error",
            message: "服务器内部错误，请稍后重试"
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
        });
    }
}

// 获取端口配置
const port = parseInt(Deno.env.get("PORT") || "8000");

// 启动Deno服务器并监听传入请求
logDebug(`正在启动Claude API代理服务器...`);
logDebug(`服务器将在端口 ${port} 上运行`);
logDebug(`请求超时时间: ${TIMEOUT_CONFIG.REQUEST_TIMEOUT / 1000} 秒`);
logDebug(`访问地址: http://localhost:${port}`);
logDebug(`模型列表: http://localhost:${port}/v1/models`);
logDebug(`聊天接口: http://localhost:${port}/v1/chat/completions`);

// 启动服务器
Deno.serve({ port }, handler);