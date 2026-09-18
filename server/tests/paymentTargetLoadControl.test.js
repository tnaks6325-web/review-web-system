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
assert.match(load, /_pmLoad\(true\)/,
  '레거시 입금일 보완 뒤에는 최신 결과를 강제 재조회해야 한다');

console.log('payment target load control tests passed');
