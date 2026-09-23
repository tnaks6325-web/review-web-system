#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SessionStart 훅 — 브라우저 자동화(Playwright)를 모든 세션에서 바로 쓸 수 있게 준비한다.
#
# 왜 필요한가: 컨테이너에는 Chromium 이 이미 깔려 있는데(/opt/pw-browsers) 두 가지가 막고 있었다.
#   ① `playwright` 는 **전역**에 설치돼 있어 NODE_PATH 없이는 `require('playwright')` 가 실패한다.
#   ② 전역 playwright 가 기대하는 Chromium 빌드 번호와 컨테이너 보유 빌드가 다르다
#      (예: 1234 기대 / 1194 보유) → `chromium.launch()` 가 "Executable doesn't exist" 로 죽는다.
#      ★ `npx playwright install` 은 쓰지 않는다(환경 지침) — 대신 실제 경로를 찾아 알려준다.
#
# 그래서 이 훅은 **설치를 거의 하지 않고**, 이미 있는 것을 쓰도록 환경변수만 심는다.
#   - NODE_PATH   : 전역 모듈 해석 경로
#   - PW_CHROMIUM : 실제 Chromium 실행파일 (launch 시 executablePath 로 넘긴다)
#
# 사용법:
#   const { chromium } = require('playwright');
#   const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
#
# ★ 로컬 개발 머신은 건드리지 않는다 — 관리형 컨테이너(/opt/pw-browsers 존재)이거나
#   Claude Code on the web 일 때만 동작한다.
# ★ 멱등 — 이미 준비돼 있으면 아무것도 설치하지 않는다.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PW_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

# 관리형 환경이 아니면 조용히 종료(로컬 머신 오염 방지)
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ ! -d "$PW_DIR" ]; then
  exit 0
fi

log() { echo "[session-start] $*"; }

# ── ① 전역 모듈 해석 경로 ────────────────────────────────────────────────────
GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT" ]; then
  export NODE_PATH="$GLOBAL_ROOT"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export NODE_PATH=\"$GLOBAL_ROOT\"" >> "$CLAUDE_ENV_FILE"
fi

# ── ② playwright 모듈 확보(없을 때만 설치) ───────────────────────────────────
if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  log "playwright 모듈이 없어 설치합니다(브라우저는 이미 있어 내려받지 않습니다)"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -g playwright >/dev/null 2>&1 \
    || log "⚠ playwright 설치 실패 — 브라우저 자동화는 이번 세션에서 쓸 수 없습니다"
fi

# ── ③ 실제 Chromium 실행파일 경로 ────────────────────────────────────────────
#    빌드 번호가 세션마다 달라질 수 있으므로 **고정하지 않고 찾아서** 알려준다.
CHROME=""
for c in "$PW_DIR"/chromium/chrome-linux/chrome \
         "$PW_DIR"/chromium-*/chrome-linux/chrome \
         "$PW_DIR"/chromium_headless_shell-*/chrome-linux/headless_shell; do
  [ -x "$c" ] && CHROME="$c" && break
done

if [ -n "$CHROME" ]; then
  export PW_CHROMIUM="$CHROME"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PW_CHROMIUM=\"$CHROME\"" >> "$CLAUDE_ENV_FILE"
  log "브라우저 준비됨 — launch({ executablePath: process.env.PW_CHROMIUM })"
else
  # ★ 조용히 넘어가지 않는다 — 왜 못 쓰는지 말한다.
  log "⚠ Chromium 실행파일을 찾지 못했습니다($PW_DIR) — 브라우저 자동화 불가"
fi

exit 0
