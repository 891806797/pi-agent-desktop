#!/usr/bin/env bash
# build.sh —— 按参数交叉编译：./build.sh [win|linux|mac|mac:x64|bun-<os>-<arch>]；缺省宿主原生
set -euo pipefail
bun run packages/backend/scripts/build.ts ${1:+--target="$1"}
