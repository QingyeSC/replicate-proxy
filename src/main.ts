import { routeRequest } from "./controllers.ts";
import { 
    logError, 
    withTimeout, 
    createTimeoutErrorResponse, 
    logSystem,
    generateRequestId,
    logRequestStart,
    logResponseComplete
} from "./utils.ts";
import { TIMEOUT_CONFIG } from "./config.ts";

/**
 * 主请求处理函数（带600秒超时控制）
 * 接收所有传入的HTTP请求并将其路由到相应的处理函数
 * 
 * @param req - 传入的Request对象
 * @returns Promise<Response> - 响应对象
 */
async function handler(req: Request): Promise<Response> {
    const requestId = generateRequestId();
    const startTime = Date.now();
    
    try {
        // 记录请求开始
        logRequestStart(req, requestId);
        
        // 使用超时控制将请求路由到合适的处理函数
        // 设置600秒（10分钟）的全局超时时间
        const response = await withTimeout(
            routeRequest(req),
            TIMEOUT_CONFIG.REQUEST_TIMEOUT,
            "请求处理总体超时（600秒），请稍后重试"
        );
        
        // 记录响应完成
        logResponseComplete(requestId, startTime, response.status);
        return response;
        
    } catch (error) {
        // 检查是否是超时错误
        if (error instanceof Error && error.message.includes("超时")) {
            logError("请求处理超时", error, requestId);
            const timeoutResponse = createTimeoutErrorResponse(error.message);
            logResponseComplete(requestId, startTime, timeoutResponse.status, "请求超时");
            return timeoutResponse;
        }
        
        // 全局错误处理，确保服务不会因为未处理的异常而中断
        logError("主处理程序中的未处理错误", error, requestId);
        const errorResponse = new Response(JSON.stringify({ 
            error: "Internal Server Error",
            message: "服务器内部错误，请稍后重试"
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
        });
        
        logResponseComplete(requestId, startTime, errorResponse.status, "内部错误");
        return errorResponse;
    }
}

// 获取端口配置
const port = parseInt(Deno.env.get("PORT") || "8000");

// 启动Deno服务器并监听传入请求
logSystem(`正在启动Claude API代理服务器...`);
logSystem(`服务器将在端口 ${port} 上运行`);
logSystem(`请求超时时间: ${TIMEOUT_CONFIG.REQUEST_TIMEOUT / 1000} 秒`);
logSystem(`访问地址: http://localhost:${port}`);
logSystem(`模型列表: http://localhost:${port}/v1/models`);
logSystem(`聊天接口: http://localhost:${port}/v1/chat/completions`);
logSystem(`环境: ${Deno.env.get("DENO_ENV") || "development"}`);

// 启动服务器
Deno.serve({ port }, handler);