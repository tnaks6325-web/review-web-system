/**
 * adminNoticeGate.test.js — 관리자 시스템공지 필수열람 게이트 회귀가드 (소스 grep)
 * 실행: node tests/adminNoticeGate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-app.js'), 'utf8');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 필수열람 게이트 (opt-in 마커) ──
ok('마커 감지: [필수열람] 포함 공지만 게이트 대상', /raw\.includes\('\[필수열람\]'\)/.test(app));
ok('마커는 표시 본문에서 제거', /raw\.split\('\[필수열람\]'\)\.join\(''\)\.trim\(\)/.test(app));
ok('게이트 조건 = 마커 + URL 존재(링크 없는 필수열람은 게이트 없음 — 잠금사고 방지)',
  /isRequired && \/https\?:\\\/\\\/\/\.test\(bodyText\)/.test(app));
ok('필수열람 배지 노출', /필수열람<\/span>/.test(app));

// ── URL 링크화 XSS 방어 ──
ok('escape 후 치환 + 따옴표·꺾쇠 미포함 URL 매칭(href breakout 방지)',
  /_escNotice\(bodyText\)\.replace\(\/\(https\?:\\\/\\\/\[\^\\s"'<>\]\+\)\/g/.test(app));
ok('링크는 새 탭 + noopener', /target="_blank" rel="noopener" onclick="_noticeDocOpened/.test(app));

// ── 확인 버튼 게이트 동작 ──
ok('게이트 시 확인 버튼 disabled 시작', /noticeConfirmBtn" \$\{gated \? 'disabled' : ''\}/.test(app));
ok('링크 클릭 → _noticeDocOpened가 전 노티스 열람 시에만 활성화', /Object\.values\(st\)\.every\(Boolean\)/.test(app));
ok('게이트 안내 문구 노출', /noticeGateHint/.test(app) && /확인 버튼이 활성화됩니다/.test(app));
ok('확인(읽음 기록) 흐름은 기존 유지(_dismissAdminNotices → markNoticeRead)',
  /_dismissAdminNotices\(window\._pendingNoticeIds\)/.test(app) && /markNoticeRead/.test(app));

// ── 작성 폼 안내(컨벤션 발견성) ──
ok('공지 작성 폼에 [필수열람] 사용법 안내', /\[필수열람\]<\/b> 표시와 문서 URL/.test(app));

console.log(`\n✅ adminNoticeGate: ${passed}개 통과`);
