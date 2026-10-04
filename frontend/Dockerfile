FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 分离部署到 CDN / 静态托管时才需要绝对 API base；留空即同源，交给 nginx 反代
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

FROM nginx:1.27-alpine
# 删除官方默认站点：它与下面的模板都 listen 80，且先被加载成为默认 server，
# 会以 server_name localhost 抢占未匹配的 Host，令 /api 反代与 SPA 回落失效
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY --from=build /build/dist /usr/share/nginx/html
ENV SHIPDESK_API_UPSTREAM=cloudops-console.cloudops.svc.cluster.local:8848
EXPOSE 80
