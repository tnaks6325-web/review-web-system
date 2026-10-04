#!/bin/sh
# graphify 저장소 지도 만들기/갱신 — 사람·자동 갱신 훅이 같은 이 스크립트를 쓴다.
#   지도가 없으면 새로 만들고(코드만·AI 미사용), 있으면 바뀐 부분만 갱신한다.
#   사용: sh scripts/graphify/map.sh
set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
GFY=$(command -v graphify 2>/dev/null || echo "$HOME/.local/bin/graphify")
if [ ! -x "$GFY" ]; then
  echo "[graphify] graphify 가 설치돼 있지 않습니다: uv tool install 'graphifyy[sql]'" >&2
  exit 1
fi
node scripts/graphify/extract-inline.js "$ROOT"
export PYTHONHASHSEED=0
if [ -f graphify-out/graph.json ]; then
  "$GFY" update .
else
  "$GFY" extract . --code-only
  "$GFY" cluster-only .
fi
