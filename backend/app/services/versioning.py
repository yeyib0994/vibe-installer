"""版本语义与升级兼容性检查。"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple


def parse_version(v: str) -> Tuple[int, int, int]:
    if not v:
        return (0, 0, 0)
    v = v.strip().lstrip("vV")
    core = v.split("-")[0].split("+")[0]
    parts: List[int] = []
    for p in core.split("."):
        num = ""
        for ch in p:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return (parts[0], parts[1], parts[2])


def is_valid_version(v: str) -> bool:
    return bool(re.match(r"^[vV]?\d+(\.\d+)*([-.+][\w.]+)?$", (v or "").strip()))


def compare_versions(a: str, b: str) -> int:
    pa, pb = parse_version(a), parse_version(b)
    return (pa > pb) - (pa < pb)


# --------------------------------------------------------------------------- #
# 组件兼容性登记
# --------------------------------------------------------------------------- #
COMPONENT_COMPAT: Dict[str, Dict[str, Any]] = {
    "mysql": {
        "message": "MySQL 大版本升级需执行 mysql_upgrade，且认证插件由 "
                   "mysql_native_password 变更为 caching_sha2_password，旧版客户端将无法连接。",
        "downtime": True,
    },
    "postgres": {
        "message": "PostgreSQL 大版本不支持就地升级，需 pg_upgrade 或逻辑复制，且必须停机。",
        "downtime": True,
    },
    "redis": {
        "message": "Redis 大版本变更了 ACL 与持久化默认行为，需核对 RDB 版本兼容性。",
        "downtime": False,
    },
    "kafka": {
        "message": "Kafka 3.x 起弱化 ZooKeeper 依赖，迁移到 KRaft 需滚动重启并重建元数据。",
        "downtime": False,
    },
    "elasticsearch": {
        "message": "ES 8 默认启用安全认证，索引需 reindex，客户端须同步升级。",
        "downtime": True,
    },
}


def check_upgrade_compat(from_v: str, to_v: str) -> Dict[str, Any]:
    """综合版本跳跃判断升级风险。"""
    pf, pt = parse_version(from_v), parse_version(to_v)

    if pt <= pf:
        return {
            "level": "blocker",
            "breaking": True,
            "downtime": False,
            "message": f"目标版本 {to_v} 不高于当前版本 {from_v}，疑似降级。"
                       "如需回退请使用备份恢复功能。",
        }

    if pf[0] != pt[0]:
        return {
            "level": "blocker",
            "breaking": True,
            "downtime": True,
            "message": f"跨主版本升级 {from_v} → {to_v}，存在不兼容的数据结构变更，"
                       "必须在停机窗口内执行并准备好数据迁移脚本。",
        }

    if pf[1] != pt[1]:
        return {
            "level": "warning",
            "breaking": False,
            "downtime": False,
            "message": f"跨次版本升级 {from_v} → {to_v}，通常向下兼容，"
                       "建议先在一台节点上灰度验证。",
        }

    return {
        "level": "ok",
        "breaking": False,
        "downtime": False,
        "message": f"修订版本升级 {from_v} → {to_v}，兼容性风险低。",
    }


def component_compat_notes(component: str, from_v: str, to_v: str) -> List[str]:
    notes: List[str] = []
    for key, entry in COMPONENT_COMPAT.items():
        if key in component.lower():
            pf, pt = parse_version(from_v), parse_version(to_v)
            if pf[0] != pt[0]:
                notes.append(f"{component}: {entry['message']}")
            break
    return notes
