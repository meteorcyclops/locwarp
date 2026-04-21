#!/bin/bash
cd "$(dirname "$0")"
exec python3 locwarp.py serve --open
