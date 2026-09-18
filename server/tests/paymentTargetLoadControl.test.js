'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

assert.match(routes, /const _paymentTargetFlights = new Map\(\)/,
  '서버가 동일 입금대상 집계를 한 번만 실행해야 한다');
assert.match(routes, /if \(active\) return active/,
  '진행 중인 동일 집계 Promise를 재사용해야 한다');
assert.match(routes, /_paymentTargetGeneration/);
assert.match(routes, /router\.use\('\/payment'/,
  '결제 쓰기 성공 뒤에는 이전 세대 집계를 재사용하면 안 된다');
assert.match(routes, /res\.statusCode >= 200 && res\.statusCode < 300/);
assert.match(routes, /PAYMENT_TARGET_FLIGHT_MAX_MS = 55 \* 1000/);
assert.match(routes, /payment_target_timeout/,
  '멈춘 서버 집계를 공유 슬롯에 영구 보관하면 안 된다');
assert.doesNotMatch(routes, /paymentTargetCache|paymentTargetsCache/,
  '금전 판정 결과를 캐시해 회차 생성 뒤 오래된 목록을 돌려주면 안 된다');

const start = workdesk.indexOf('async function _pmLoad(');
const end = workdesk.indexOf('\nconst _pmKey', start);
const load = workdesk.slice(start, end);
assert.match(load, /_pmLoadInFlight/,
  '브라우저도 연속 클릭으로 입금대상 요청을 겹치면 안 된다');
assert.match(load, /AbortController/);
assert.match(load, /60000/,
  '무한 로딩 대신 60초 뒤 재시도 화면을 보여야 한다');
assert.match(load, /payment\/batches\?limit=30',controller\?\{signal:controller\.signal\}/,
  '회차 목록이 멈춰도 같은 제한시간에 중단돼야 한다');
assert.match(load, /_pmLoad\(true\)/,
  '레거시 입금일 보완 뒤에는 최신 결과를 강제 재조회해야 한다');
assert.match(load, /if\(force\)\{[^}]*_pmLoadGeneration\+=1;[^}]*_pmLoadInFlight=null;/,
  '쓰기 전 조회를 버리고 쓰기 후 강제 조회를 새 대표 요청으로 삼아야 한다');
assert.match(load, /_pmLoadGeneration/);
assert.match(load, /generation!==_pmLoadGeneration/,
  '쓰기 후 조회보다 늦게 끝난 예전 응답은 화면을 다시 덮으면 안 된다');
assert.match(workdesk, /function _dropSession[\s\S]*?_pmLoadInFlight=null;/,
  '세션 만료 뒤 로그인하면 이전 계정의 미완료 요청을 재사용하면 안 된다');
const logout = workdesk.slice(workdesk.indexOf('function logout()'), workdesk.indexOf('function logout()') + 500);
assert.match(logout, /_pmLoadGeneration\+=1/);
assert.match(logout, /_pmLoadInFlight=null/,
  '수동 로그아웃도 이전 계정의 입금 조회를 폐기해야 한다');

const paymentArea = workdesk.slice(workdesk.indexOf('async function _pmLoad('));
const unforcedAwaitLoads = paymentArea.match(/await _pmLoad\(\);/g) || [];
assert.equal(unforcedAwaitLoads.length, 0,
  '입금 관련 쓰기 성공 뒤의 조회는 진행 중인 쓰기 전 요청을 재사용하면 안 된다');

console.log('payment target load control tests passed');
