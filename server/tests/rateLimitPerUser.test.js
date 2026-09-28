'use strict';
// 전역 요청 제한 = 사람별 통 + 검증 안 된 요청의 인터넷 주소별 상한 (decision 188).
// 사무실(직원 공유 IP)·통신사 공유 IP 에서 남의 요청 때문에 편집·조회가 막히던 사고를 고정한다.
const assert = require('assert');
const http = require('http');
process.env.JWT_SECRET = 'rl-test-secret';
process.env.RL_STAFF_MAX = '5';
process.env.RL_REVIEWER_MAX = '4';
process.env.RL_ANON_MAX = '3';
process.env.RL_IP_CEILING = '8';
const express = require('express');
const jwt = require('jsonwebtoken');
const { rateLimiter, rateIdentity } = require('../src/middleware/rateLimit.middleware');
const { issueReviewerSession } = require('../src/services/reviewerSession.service');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/', rateLimiter);
app.all('/api/*', (req, res) => res.json({ ok: true, who: rateIdentity(req).key }));

const staff = n => jwt.sign({ name: n, role: 'staff' }, process.env.JWT_SECRET);
const reviewer = id => issueReviewerSession({ ownerReviewerId: id, loginName: 'x', loginPhone8: '12345678' });

let server, base, passed = 0;
function req(path, { ip = '1.1.1.1', headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method, headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json', ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function burst(n, opts, path = '/api/x') { const out = []; for (let i = 0; i < n; i++) out.push((await req(path, opts)).status); return out; }
const t = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  await t('같은 사무실 IP의 직원 둘은 서로의 통을 쓰지 않는다', async () => {
    const a = await burst(5, { ip: '9.9.9.1', headers: { Authorization: 'Bearer ' + staff('김직원') } });
    assert.deepStrictEqual(a, [200, 200, 200, 200, 200]);
    assert.equal((await req('/api/x', { ip: '9.9.9.1', headers: { Authorization: 'Bearer ' + staff('김직원') } })).status, 429, '본인 통은 다 쓰면 막힌다');
    const b = await burst(5, { ip: '9.9.9.1', headers: { Authorization: 'Bearer ' + staff('이직원') } });
    assert.deepStrictEqual(b, [200, 200, 200, 200, 200], '다른 직원은 영향 없음');
  });
  await t('검증된 직원은 주소별 상한에서 빠진다(같은 IP 10명이어도 막히지 않는다)', async () => {
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(await burst(3, { ip: '9.9.9.2', headers: { Authorization: 'Bearer ' + staff('s' + i) } }), [200, 200, 200]);
  });
  await t('로그인 리뷰어는 리뷰어별 통', async () => {
    assert.deepStrictEqual(await burst(4, { ip: '8.8.8.1', headers: { 'X-Reviewer-Token': reviewer('r1') } }), [200, 200, 200, 200]);
    assert.equal((await req('/api/x', { ip: '8.8.8.1', headers: { 'X-Reviewer-Token': reviewer('r1') } })).status, 429);
    assert.equal((await req('/api/x', { ip: '8.8.8.1', headers: { 'X-Reviewer-Token': reviewer('r2') } })).status, 200);
  });
  await t('통신사 공유 IP의 리뷰어들은 연락처별로 갈린다', async () => {
    assert.deepStrictEqual(await burst(4, { ip: '7.7.7.1' }, '/api/y?phone8=11112222'), [200, 200, 200, 200]);
    assert.equal((await req('/api/y?phone8=11112222', { ip: '7.7.7.1' })).status, 429);
    assert.equal((await req('/api/y?phone8=33334444', { ip: '7.7.7.1' })).status, 200, '같은 IP 다른 리뷰어는 통과');
    assert.equal((await req('/api/y', { ip: '7.7.7.1', method: 'POST', body: { phone8: '55556666' } })).status, 200, '본문 phone8 도 인식');
  });
  await t('번호를 바꿔 가며 통을 늘려도 주소별 상한(검증 안 됨)이 막는다 — 완화 금지', async () => {
    const out = []; for (let i = 0; i < 10; i++) out.push((await req('/api/y?phone8=900000' + String(i).padStart(2, '0'), { ip: '6.6.6.1' })).status);
    assert.deepStrictEqual(out.slice(0, 8), Array(8).fill(200));
    assert.deepStrictEqual(out.slice(8), [429, 429]);
  });
  await t('신원 없는 요청은 종전처럼 주소별', async () => {
    assert.deepStrictEqual(await burst(4, { ip: '5.5.5.1' }), [200, 200, 200, 429]);
  });
  await t('위조 토큰은 신원으로 인정하지 않는다', async () => {
    const fake = jwt.sign({ name: 'x', role: 'master' }, 'wrong');
    const r = await req('/api/x', { ip: '4.4.4.1', headers: { Authorization: 'Bearer ' + fake } });
    assert.match(r.body, /"who":"i:4\.4\.4\.1"/);
  });
  await t('목록 폴링·인덱스 경로 면제는 유지', async () => {
    assert.deepStrictEqual(await burst(6, { ip: '3.3.3.1' }, '/api/campaign/list'), Array(6).fill(200));
  });
  console.log(`${passed} rate-limit tests passed`);
  server.close(); process.exit(0);
})().catch(e => { console.error(e); server && server.close(); process.exit(1); });
