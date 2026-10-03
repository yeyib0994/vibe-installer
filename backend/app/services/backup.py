"""备份点摘要计算 —— 只此一处，避免登记与校验两边算法漂移。"""

from __future__ import annotations

import hashlib
from pathlib import Path

from ..models.schemas import BackupPoint


def backup_digest(b: BackupPoint) -> tuple[str, int, int]:
    """计算备份点校验和，返回 (digest, 文件数, 实际文件字节数)。

    摘要覆盖三部分：
      1. 归档目录内每个文件的「文件名 + 大小」（按路径排序，保证稳定）
      2. 逻辑体积 size_bytes
      3. 覆盖的节点名（排序）

    为什么 2/3 也要算进去：模拟模式下磁盘上只有 manifest 文件，真实的
    归档体积并不落盘。若只对实际文件做摘要，任何两个备份点的校验和都会
    一样，"校验"就完全失去意义了。

    登记（executor._act_backup_register）与校验（/api/backups/{id}/verify）
    都必须调用本函数 —— 这两处一旦各写一份，迟早会因为只改了一边而
    永远判校验失败。
    """
    h = hashlib.sha256()
    base = Path(b.path) if b.path else None
    files = 0
    size = 0
    if base and base.exists():
        for f in sorted(base.rglob("*")):
            if f.is_file():
                h.update(f.name.encode())
                h.update(str(f.stat().st_size).encode())
                files += 1
                size += f.stat().st_size
    h.update(f"{b.size_bytes}|{len(b.nodes_covered)}".encode())
    for n in sorted(b.nodes_covered):
        h.update(n.encode())
    return h.hexdigest(), files, size
