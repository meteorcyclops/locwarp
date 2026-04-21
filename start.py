#!/usr/bin/env python3
"""
LocWarp 啟動入口。

舊版 start.py 內含一整套 Windows / dev 啟動流程，
這個 fork 改為統一導向新的 CLI 入口：locwarp.py

預設行為等同於：
    python3 locwarp.py serve --open
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLI = ROOT / 'locwarp.py'


def main() -> int:
    cmd = [sys.executable, str(CLI), 'serve', '--open']
    return subprocess.call(cmd, cwd=ROOT)


if __name__ == '__main__':
    raise SystemExit(main())
