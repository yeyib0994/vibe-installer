# 一键部署脚本
Write-Host "=== 部署 ShipDesk Console（后端 API + 前端静态站）到本地 K8s ===" -ForegroundColor Cyan

# 1. 构建两个镜像：UI 不再打进后端 jar，解耦成独立的 nginx 静态站
Write-Host "[1/5] 构建镜像 cloudops-console:3.0.0 ..." -ForegroundColor Yellow
docker build -t cloudops-console:3.0.0 -f Dockerfile .
if ($LASTEXITCODE -ne 0) { Write-Error "后端镜像构建失败"; exit 1 }

Write-Host "[2/5] 构建镜像 shipdesk-web:3.0.0 ..." -ForegroundColor Yellow
docker build -f frontend/Dockerfile -t shipdesk-web:3.0.0 frontend
if ($LASTEXITCODE -ne 0) { Write-Error "前端镜像构建失败"; exit 1 }

# 3. 应用命名空间与配置
Write-Host "[3/5] 应用 K8s 资源 ..." -ForegroundColor Yellow
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/web-deployment.yaml
kubectl apply -f k8s/web-service.yaml

# 4. 等待两个 Deployment 就绪（前端在等后端 Service 可解析，顺序反了也不会卡死）
Write-Host "[4/5] 等待 Pod 就绪 ..." -ForegroundColor Yellow
kubectl -n cloudops rollout status deployment/cloudops-console --timeout=180s
if ($LASTEXITCODE -ne 0) { Write-Error "后端部署超时"; exit 1 }
kubectl -n cloudops rollout status deployment/shipdesk-web --timeout=120s
if ($LASTEXITCODE -ne 0) { Write-Error "前端部署超时"; exit 1 }

# 5. 输出访问地址
Write-Host "[5/5] 部署完成！" -ForegroundColor Green
Write-Host ""
Write-Host "  前端地址: http://localhost:30880            （nginx 静态站，/api 由它反代到后端）" -ForegroundColor Green
Write-Host "  健康检查: http://localhost:30880/healthz    （经前端代理探后端）" -ForegroundColor Green
Write-Host "  裸 API  : http://localhost:30848/api/environments（30848 上只有 /api/**、/healthz，没有页面）" -ForegroundColor Green
Write-Host ""
Write-Host "查看日志: kubectl -n cloudops logs -f deploy/cloudops-console" -ForegroundColor Gray
Write-Host "查看日志: kubectl -n cloudops logs -f deploy/shipdesk-web" -ForegroundColor Gray
