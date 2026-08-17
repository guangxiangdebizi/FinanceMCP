# Builder stage
FROM node:lts-alpine AS builder
WORKDIR /app

# Install all dependencies (including dev) and build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm run build

# Production stage
FROM node:lts-alpine AS runner
WORKDIR /app

# 创建非 root 用户和用户组
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 安装 production 依赖（以 root 执行）
COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts

# 拷贝构建产物
COPY --from=builder /app/build ./build

# 确保 appuser 对 /app 有权限
RUN chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 暴露端口（Smithery 平台要求）
EXPOSE 3000 3210

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 默认启动命令（Streamable HTTP）
CMD ["node", "build/httpServer.js"]
