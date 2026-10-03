"""SQLite 持久化层。

刻意用标准库 sqlite3（WAL 模式）而不引 ORM —— 单机控制台，部署越轻越好复制。
所有模型统一以 JSON 存在 data 列，用 model_dump(mode="json") 序列化
（这样嵌套的 datetime / 子模型都能正确处理）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..models.schemas import (
    BackupPoint,
    EnvironmentSpec,
    InstallFlow,
    PackageEntry,
)

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "cloudops.db"
DATA_DIR = Path(__file__).resolve().parents[2] / "data"

_local = threading.local()


def _conn() -> sqlite3.Connection:
    if getattr(_local, "conn", None) is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        _local.conn = c
    return _local.conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS env_specs (
    id TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY, name TEXT, kind TEXT, data TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS distributions (
    id TEXT PRIMARY KEY, flow_id TEXT, data TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY, env_id TEXT, kind TEXT, data TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY, name TEXT, env_id TEXT, status TEXT,
    data TEXT NOT NULL, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_flows_created ON flows(created_at DESC);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, operator TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, result TEXT NOT NULL, detail TEXT DEFAULT ''
);
"""


def init_db() -> None:
    c = _conn()
    c.executescript(SCHEMA)
    c.commit()
    (DATA_DIR / "packages").mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "backups").mkdir(parents=True, exist_ok=True)


def _dump(model: Any) -> str:
    """mode="json" 递归处理嵌套模型与 datetime。"""
    return json.dumps(model.model_dump(mode="json"), ensure_ascii=False)


# --------------------------------------------------------------------------- #
# 环境规格
# --------------------------------------------------------------------------- #
def save_env(env: EnvironmentSpec) -> EnvironmentSpec:
    c = _conn()
    env.updated_at = datetime.utcnow()
    c.execute(
        "INSERT INTO env_specs(id, name, data, updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, "
        "updated_at=excluded.updated_at",
        (env.id, env.name, _dump(env), env.updated_at.isoformat()),
    )
    c.commit()
    return env


def list_envs() -> List[EnvironmentSpec]:
    rows = _conn().execute("SELECT data FROM env_specs ORDER BY updated_at DESC").fetchall()
    return [EnvironmentSpec(**json.loads(r["data"])) for r in rows]


def get_env(env_id: str) -> Optional[EnvironmentSpec]:
    r = _conn().execute("SELECT data FROM env_specs WHERE id=?", (env_id,)).fetchone()
    return EnvironmentSpec(**json.loads(r["data"])) if r else None


def delete_env(env_id: str) -> None:
    c = _conn()
    c.execute("DELETE FROM env_specs WHERE id=?", (env_id,))
    c.commit()


# --------------------------------------------------------------------------- #
# 安装包
# --------------------------------------------------------------------------- #
def save_package(p: PackageEntry) -> PackageEntry:
    c = _conn()
    c.execute(
        "INSERT INTO packages(id, name, kind, data, created_at) VALUES(?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, data=excluded.data",
        (p.id, p.name, p.kind, _dump(p), p.created_at.isoformat()),
    )
    c.commit()
    return p


def list_packages() -> List[PackageEntry]:
    rows = _conn().execute("SELECT data FROM packages ORDER BY created_at DESC").fetchall()
    return [PackageEntry(**json.loads(r["data"])) for r in rows]


def get_package(pid: str) -> Optional[PackageEntry]:
    r = _conn().execute("SELECT data FROM packages WHERE id=?", (pid,)).fetchone()
    return PackageEntry(**json.loads(r["data"])) if r else None


def delete_package(pid: str) -> None:
    p = get_package(pid)
    if p and p.path:
        try:
            Path(p.path).unlink(missing_ok=True)
        except Exception:
            pass
    c = _conn()
    c.execute("DELETE FROM packages WHERE id=?", (pid,))
    c.commit()


# --------------------------------------------------------------------------- #
# 分发任务
# --------------------------------------------------------------------------- #
def save_distribution(d: Any) -> Any:
    c = _conn()
    c.execute(
        "INSERT INTO distributions(id, flow_id, data, created_at) VALUES(?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        (d.id, d.flow_id, _dump(d), d.created_at.isoformat()),
    )
    c.commit()
    return d


def get_distribution(did: str) -> Optional[Any]:
    from ..models.schemas import DistributionJob
    r = _conn().execute("SELECT data FROM distributions WHERE id=?", (did,)).fetchone()
    return DistributionJob(**json.loads(r["data"])) if r else None


def list_distributions(flow_id: Optional[str] = None) -> List[Any]:
    from ..models.schemas import DistributionJob
    if flow_id:
        rows = _conn().execute(
            "SELECT data FROM distributions WHERE flow_id=? ORDER BY created_at DESC", (flow_id,)
        ).fetchall()
    else:
        rows = _conn().execute(
            "SELECT data FROM distributions ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
    return [DistributionJob(**json.loads(r["data"])) for r in rows]


# --------------------------------------------------------------------------- #
# 备份点
# --------------------------------------------------------------------------- #
def save_backup(b: BackupPoint) -> BackupPoint:
    c = _conn()
    c.execute(
        "INSERT INTO backups(id, env_id, kind, data, created_at) VALUES(?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        (b.id, b.env_id, b.kind.value, _dump(b),
         (b.started_at or datetime.utcnow()).isoformat()),
    )
    c.commit()
    return b


def list_backups(env_id: Optional[str] = None) -> List[BackupPoint]:
    if env_id:
        rows = _conn().execute(
            "SELECT data FROM backups WHERE env_id=? ORDER BY created_at DESC", (env_id,)
        ).fetchall()
    else:
        rows = _conn().execute("SELECT data FROM backups ORDER BY created_at DESC").fetchall()
    return [BackupPoint(**json.loads(r["data"])) for r in rows]


def get_backup(bid: str) -> Optional[BackupPoint]:
    r = _conn().execute("SELECT data FROM backups WHERE id=?", (bid,)).fetchone()
    return BackupPoint(**json.loads(r["data"])) if r else None


# --------------------------------------------------------------------------- #
# 流程
# --------------------------------------------------------------------------- #
def save_flow(f: InstallFlow) -> InstallFlow:
    c = _conn()
    f.updated_at = datetime.utcnow()
    c.execute(
        "INSERT INTO flows(id, name, env_id, status, data, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, status=excluded.status, data=excluded.data, updated_at=excluded.updated_at",
        (f.id, f.name, f.env_id, f.status.value, _dump(f),
         f.created_at.isoformat(), f.updated_at.isoformat()),
    )
    c.commit()
    return f


def list_flows(limit: int = 100) -> List[InstallFlow]:
    rows = _conn().execute(
        "SELECT data FROM flows ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [InstallFlow(**json.loads(r["data"])) for r in rows]


def get_flow(fid: str) -> Optional[InstallFlow]:
    r = _conn().execute("SELECT data FROM flows WHERE id=?", (fid,)).fetchone()
    return InstallFlow(**json.loads(r["data"])) if r else None


def delete_flow(fid: str) -> None:
    c = _conn()
    c.execute("DELETE FROM flows WHERE id=?", (fid,))
    c.commit()


# --------------------------------------------------------------------------- #
# 审计
# --------------------------------------------------------------------------- #
def audit(operator: str, action: str, target: str, result: str, detail: str = "") -> None:
    c = _conn()
    c.execute(
        "INSERT INTO audit(ts, operator, action, target, result, detail) VALUES(?,?,?,?,?,?)",
        (datetime.utcnow().isoformat(), operator, action, target, result, detail),
    )
    c.commit()


def list_audit(limit: int = 200) -> List[Dict[str, Any]]:
    rows = _conn().execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
