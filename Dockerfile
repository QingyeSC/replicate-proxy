# 使用官方Deno Alpine镜像，体积更小
FROM denoland/deno:alpine-1.40.2

# 设置工作目录
WORKDIR /app

# 首先复制配置文件（使用root权限）
COPY deno.json ./

# 复制源代码文件
COPY src/ ./src/

# 清除旧的缓存并重新缓存依赖项（使用root权限）
RUN deno cache --reload --lock-write src/main.ts

# 创建deno用户可写的目录
RUN mkdir -p /app/.deno && chown -R deno:deno /app

# 切换到deno用户
USER deno

# 暴露端口
EXPOSE 8000

# 设置环境变量
ENV DENO_ENV=production

# 健康检查
HEALTHCHECK --interval=300s --timeout=10s --start-period=5s --retries=3 \
  CMD deno eval 'fetch("http://localhost:8000/v1/models").then(r => r.ok ? Deno.exit(0) : Deno.exit(1))' || exit 1

# 运行应用
CMD ["deno", "run", "--allow-net", "--allow-env", "src/main.ts"]