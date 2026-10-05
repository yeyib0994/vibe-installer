# ===== 构建阶段 1：Maven 打包 =====
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /build

COPY backend-java/pom.xml .
COPY backend-java/.mvn .mvn
COPY backend-java/mvnw .
COPY backend-java/mvnw.cmd .
RUN chmod +x mvnw && ./mvnw dependency:go-offline -q || true

COPY backend-java/src ./src
RUN ./mvnw package -DskipTests -q \
    && cp target/cloudops-console-*.jar /app.jar

# ===== 构建阶段 2：k8s-ops TypeScript 编译 =====
FROM node:20-bookworm-slim AS k8sops-builder
WORKDIR /build

COPY k8s-ops/package.json k8s-ops/package-lock.json ./
RUN npm ci

COPY k8s-ops/src ./src
COPY k8s-ops/tsconfig.json .
RUN npx tsc

# ===== 构建阶段 3：kubectl + helm 二进制 =====
FROM alpine:3.20 AS k8s-tools
RUN apk add --no-cache curl \
    && curl -fsSL https://storage.googleapis.com/kubernetes-release/release/v1.30.3/bin/linux/amd64/kubectl \
       -o /kubectl && chmod +x /kubectl \
    && curl -fsSL https://mirrors.huaweicloud.com/helm/v3.15.4/helm-v3.15.4-linux-amd64.tar.gz \
       | tar -xz -C / --strip-components=1 linux-amd64/helm

# ===== 运行阶段 =====
FROM eclipse-temurin:21-jre-jammy
WORKDIR /app

# 安装 python3；直接下载 Node.js 20 预编译二进制（apt 版本过旧）
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 ca-certificates curl xz-utils \
    && curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \
       | tar -xJ -C /usr/local --strip-components=1 \
    && rm -rf /var/lib/apt/lists/*

# 从 k8s-tools 阶段复制 kubectl + helm
COPY --from=k8s-tools /kubectl /usr/local/bin/kubectl
COPY --from=k8s-tools /helm /usr/local/bin/helm

# 数据目录
RUN mkdir -p /data /app/backups
ENV CLOUDOPS_DATA_DIR=/data
ENV CLOUDOPS_PRECHECK_SCRIPT=/app/scripts/precheck.py
ENV CLOUDOPS_K8S_OPS=/app/k8s-ops/dist/index.js

# 复制应用 jar
COPY --from=builder /app.jar /app/app.jar

# 复制 Python 脚本
COPY backend-java/scripts /app/scripts

# 复制 k8s-ops（编译产物 + 依赖）
COPY --from=k8sops-builder /build/dist /app/k8s-ops/dist
COPY --from=k8sops-builder /build/node_modules /app/k8s-ops/node_modules

# 健康检查：运行阶段只装了 curl（temurin 基底没有 wget），用 -f 让非 2xx 也算失败
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:${PORT:-8848}/healthz || exit 1

EXPOSE 8848

# 非 root 用户
RUN groupadd -r cloudops && useradd -r -g cloudops -d /app cloudops \
    && chown -R cloudops:cloudops /app /data
USER cloudops

ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS:-} -jar /app/app.jar"]
