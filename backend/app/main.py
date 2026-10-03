"""FastAPI 应用入口。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .api.routes import router
from .core import store
from .core.seed import seed_if_empty

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(
    title="CloudOps Console",
    description="云化系统安装流程编排 · 包分发 · 数据备份",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
def _startup() -> None:
    store.init_db()
    seed_if_empty()


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" rx="7" fill="#2563eb"/>'
        '<path d="M8 22V13l5 3 5-3v9" stroke="#fff" stroke-width="2.2" '
        'fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        '<circle cx="23" cy="19" r="3" stroke="#fff" stroke-width="2" fill="none"/></svg>'
    )
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/")
def index():
    idx = FRONTEND_DIR / "index.html"
    if idx.exists():
        return FileResponse(idx)
    return {"message": "CloudOps Console API", "docs": "/docs"}


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
