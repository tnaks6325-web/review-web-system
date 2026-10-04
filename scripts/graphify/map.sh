#!/bin/sh
# graphify 저장소 지도 만들기/갱신 — 사람·자동 갱신 훅·세션 시작 훅이 모두 이 스크립트를 쓴다.
#   지도가 없으면 새로 만들고(코드만·AI 미사용), 있으면 바뀐 부분만 갱신한다.
#   같은 작업용 복사본에서 동시에 돌면 앞 작업이 끝날 때까지 기다린다.
#   사용: sh scripts/graphify/map.sh
set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
GFY=$(command -v graphify 2>/dev/null || echo "$HOME/.local/bin/graphify")
if [ ! -x "$GFY" ]; then
  echo "[graphify] graphify 가 설치돼 있지 않습니다: uv tool install 'graphifyy[sql]'" >&2
  exit 1
fi
# 잠금은 이 복사본 전용 git 폴더에 둔다(작업 폴더를 어지럽히지 않게). 15분 넘은 잠금은 죽은 것으로 본다.
LOCK="$(cd "$(git rev-parse --git-dir)" && pwd)/graphify-map.lock"
n=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; continue; fi
  n=$((n+1)); [ $n -gt 900 ] && { echo "[graphify] 다른 갱신이 끝나지 않아 건너뜁니다" >&2; exit 0; }
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
node scripts/graphify/extract-inline.js "$ROOT"
export PYTHONHASHSEED=0
if [ -f graphify-out/graph.json ]; then
  "$GFY" update .
else
  "$GFY" extract . --code-only
  "$GFY" cluster-only .
fi
