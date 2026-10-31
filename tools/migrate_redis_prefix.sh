#!/usr/bin/env bash
# redis 键前缀迁移：xhh -> HoYoGet
# 用法：./migrate_redis_prefix.sh [--dry-run|--apply|--reverse]
# 默认 COPY（保留旧键），配合 --reverse 可回滚。
set -euo pipefail
F=${FROM_PREFIX:-xhh}
T=${TO_PREFIX:-HoYoGet}
M=${1:---dry-run}
if [ "$M" = "--reverse" ]; then x=$F; F=$T; T=$x; fi
mapfile -t K < <(redis-cli --scan --pattern "${F}*")
echo "map: ${F}* -> ${T}*  keys=${#K[@]}  mode=$M"
if [ "$M" = "--dry-run" ]; then printf "%s\n" "${K[@]}" | head -20; exit 0; fi
for k in "${K[@]}"; do redis-cli COPY "$k" "${T}${k#${F}}" REPLACE >/dev/null || true; done
echo "copied ${#K[@]} keys"
