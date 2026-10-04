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
# 模板名必须叫 default.conf.template：渲染出的 /etc/nginx/conf.d/default.conf 正好覆盖官方默认站点，
# 否则两份 server 都 listen 80，默认站点会以 server_name localhost 抢占未匹配的 Host，令反代与 SPA 回落失效
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /build/dist /usr/share/nginx/html
ENV SHIPDESK_API_UPSTREAM=cloudops-console.cloudops.svc.cluster.local:8848
EXPOSE 80
