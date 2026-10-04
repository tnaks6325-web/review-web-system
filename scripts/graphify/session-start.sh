#!/bin/sh
# Claude·Codex 대화 시작 때 저장소 지도(graphify)를 뒤에서 맞춘다 — 없으면 만들고 있으면 갱신.
#   graphify 가 설치된 컴퓨터에서만 동작한다(클라우드 환경은 조용히 건너뜀).
#   대화 시작을 막지 않도록 즉시 돌아온다.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$ROOT/scripts/graphify/map.sh" ] || exit 0
command -v graphify >/dev/null 2>&1 || [ -x "$HOME/.local/bin/graphify" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
LOG="$HOME/.cache/graphify-rebuild.log"; mkdir -p "$(dirname "$LOG")"
( echo "== $(date '+%F %T') session-start $ROOT"; sh "$ROOT/scripts/graphify/map.sh" ) >>"$LOG" 2>&1 </dev/null &
echo "[session-start] 저장소 지도 맞춤을 뒤에서 시작했습니다(graphify-out/)"
exit 0
