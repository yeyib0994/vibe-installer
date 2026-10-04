# 一键部署脚本
Write-Host "=== 部署 CloudOps Console 到本地 K8s ===" -ForegroundColor Cyan

# 1. 构建 Docker 镜像
Write-Host "[1/4] 构建镜像 cloudops-console:3.0.0 ..." -ForegroundColor Yellow
docker build -t cloudops-console:3.0.0 -f Dockerfile .
if ($LASTEXITCODE -ne 0) { Write-Error "镜像构建失败"; exit 1 }

# 2. 应用命名空间与配置
Write-Host "[2/4] 应用 K8s 资源 ..." -ForegroundColor Yellow
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# 3. 等待 Pod 就绪
Write-Host "[3/4] 等待 Pod 就绪 ..." -ForegroundColor Yellow
kubectl -n cloudops rollout status deployment/cloudops-console --timeout=180s
if ($LASTEXITCODE -ne 0) { Write-Error "部署超时"; exit 1 }

# 4. 输出访问地址
Write-Host "[4/4] 部署完成！" -ForegroundColor Green
Write-Host ""
Write-Host "  前端地址: http://localhost:30848" -ForegroundColor Green
Write-Host "  健康检查: http://localhost:30848/healthz" -ForegroundColor Green
Write-Host "  API 文档: http://localhost:30848/api/environments" -ForegroundColor Green
Write-Host ""
Write-Host "查看日志: kubectl -n cloudops logs -f deploy/cloudops-console" -ForegroundColor Gray
