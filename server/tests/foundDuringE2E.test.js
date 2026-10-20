/**
 * foundDuringE2E.test.js — 순차진행 E2E(2026-10-08) 중 발견한 무관 결함 2건 회귀가드
 * 실행: node tests/foundDuringE2E.test.js
 *
 *  ① (옛 관리자 대시보드 _applyHiddenCols — 결정 267 로 화면째 폐기, 검사 제거)
 *  ② 구매양식 제출의 구매일자가 비면 작업표에 미리 적힌 구매일자를 지움 → 서버가 오늘(KST)을 채운다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// 옛 관리자 대시보드 폐기(결정 267) — [1] _applyHiddenCols 는 index-app.js 에만 있었다(파일째 삭제). [2] 만 남는다.

console.log('\n[2] 구매양식 제출 — 구매일자가 비면 오늘(KST)');
const sub = fs.readFileSync(path.join(__dirname, '../src/routes/submit.routes.js'), 'utf8');
ok('구매일자 = 항상 서버 오늘(KST) · 관리자 수기 주문과 같은 함수(결정 215 → 248 강화)', /const effectiveDateStr = require\('\.\.\/services\/manualOrder\.service'\)\.todayKstDateStr\(\);/.test(sub));
ok('★ 248: 화면이 보낸 구매일자로 정하지 않는다(휴대폰 시계가 늦으면 자정 직후가 전날로 적힌다)', !/const effectiveDateStr = String\(dateStr/.test(sub) && !/effectiveDateStr = [^;]*_clientDateStr/.test(sub));
ok('★ 248: 화면 날짜와 다르면 로그만 남긴다', /_clientDateStr[\s\S]{0,200}!== effectiveDateStr[\s\S]{0,40}logger\.warn/.test(sub));
ok('orderData 는 채운 값을 쓴다(빈 dateStr 를 그대로 넘기지 않음)', /const orderData = \{[^}]*dateStr: effectiveDateStr,/.test(sub) && !/const orderData = \{[^}]*depositor, price, dateStr, orderNum/.test(sub));
const { todayKstDateStr } = require('../src/services/manualOrder.service');
ok('채우는 형식 = 리뷰어 화면과 같은 "M / D (요일)"', todayKstDateStr(new Date('2026-10-08T05:00:00Z')) === '10 / 8 (목)');
ok('★ 248 실측 재현: KST 10/14 0시 14분(UTC 10/13 15:14) 제출 = 10/14', todayKstDateStr(new Date('2026-10-13T15:14:43Z')) === '10 / 14 (수)');
const wd = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
ok('리뷰어 화면이 보내는 형식도 같다(드리프트 감시)', /const dateStr = `\$\{now\.getMonth\(\)\+1\} \/ \$\{now\.getDate\(\)\} \(\$\{days\[now\.getDay\(\)\]\}\)`/.test(wd));

console.log(`\n✅ foundDuringE2E — ${passed} passed`);
