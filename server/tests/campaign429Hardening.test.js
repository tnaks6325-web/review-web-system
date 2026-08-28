/**
 * 캠페인 429 보호 회귀가드 — 별도 서버 기동 없이 배선 순서와 클라이언트 보호막을 고정한다.
 * 실행: node tests/campaign429Hardening.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('src/app.js');
const campaign = read('../frontend/campaign.html');

const metricsAt = app.indexOf('app.use(metricsMiddleware);');
const limiterAt = app.indexOf("app.use('/api/', rateLimiter);");
assert.ok(metricsAt >= 0 && metricsAt < limiterAt, '429도 metricsMiddleware가 기록해야 한다');
assert.match(campaign, /let _campaignLoadPromise = null/, '상세 조회 in-flight 병합 상태가 필요하다');
assert.match(campaign, /if\(_campaignLoadPromise\) return _campaignLoadPromise/, '동시 상세 조회를 하나로 합쳐야 한다');
assert.match(campaign, /r\.status === 429/, '429 상태를 별도로 판별해야 한다');
assert.match(campaign, /response\.headers\.get\('Retry-After'\)/, '서버의 Retry-After를 존중해야 한다');
assert.match(campaign, /let _campaign429Retried = false/, '429 자동 재시도 횟수를 제한해야 한다');
assert.match(campaign, /_campaignLoadPromise\.finally\(\(\)=>\{ _campaignLoadPromise = null; \}\)/, '완료 후 in-flight 상태를 해제해야 한다');

console.log('✅ campaign429Hardening: 7개 통과');
