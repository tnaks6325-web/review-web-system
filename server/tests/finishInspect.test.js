'use strict';
/**
 * 🏁 마감자료 검수(결정 297) — 판정 · 라우트 배선 · 화면 렌더.
 *   ★ 사본 0: 명단 = _closeoutRoster+isFilledRow, 줄별 사진 = reviewImagesForTab(제출물 미리보기와 같은 함수).
 *   ★ 알려주기만 — 마감 게이트(사람 체크 + 서버 inspected)는 그대로.
 *   ★ "모른다"를 0 으로 꾸미지 않는다(noHash · unrowed=null · 조회 실패 문구).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const svc = require('../src/services/trackB.service');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
let pass = 0;
const t = (n, c, x) => { assert.ok(c, n + (x ? ' — ' + x : '')); console.log('  ✓ ' + n); pass++; };

console.log('1) 판정(_finishInspectCompute 실제 실행)');
const P = (seq, name, extra = {}) => ({ seq, name, ...extra });
const people = [P(1, '김가'), P(2, '이나'), P(3, '박다', { submitted: true }), P(4, '최라'), P(5, '정마')];
const rows = svc._fiReviewRows({
  1: [{ fileId: 'a1', slot: 'review' }, { fileId: 'a2', slot: 'review' }, { fileId: 'c1', slot: 'order_capture' }],
  2: [{ fileId: 'b1', slot: 'review' }, { fileId: 'b2', slot: 'review' }],
  4: [{ fileId: 'd1', slot: 'trashed' }, { fileId: 'd2', slot: 'receipt' }],
  9: [{ fileId: 'z1', slot: 'review' }],
  5: [{ fileId: 'e1', slot: 'review' }, { fileId: 'e2', slot: 'review' }],
});
const meta = [
  { file_id: 'a1', file_hash: 'H1', upload_batch_id: 'B1', at: '2026-10-01T00:00:00Z' },
  { file_id: 'a2', file_hash: 'H1', upload_batch_id: 'B1', at: '2026-10-01T00:00:01Z' },
  { file_id: 'b1', file_hash: 'H2', upload_batch_id: null, at: '2026-10-01T00:00:00Z' },
  { file_id: 'b2', file_hash: null, upload_batch_id: null, at: '2026-10-01T05:00:00Z' },
  { file_id: 'z1', file_hash: 'H2', upload_batch_id: 'B9', at: '2026-10-01T00:00:00Z' },
  { file_id: 'e1', file_hash: 'H5', upload_batch_id: 'B5a', at: '2026-10-01T00:00:00Z' },
  { file_id: 'e2', file_hash: 'H6', upload_batch_id: 'B5b', at: '2026-10-01T00:00:05Z' },
];
const r = svc._finishInspectCompute({ people, revByRow: rows, metaRows: meta, unrowed: 2 });
t('구매캡처·영수증·휴지통 사진은 리뷰 사진으로 세지 않는다', !rows.has('4') && rows.get('1').length === 2);
t('① 같은 사람의 같은 사진 2장 = 1건', r.samePhoto.items.some(g => g.files === 2 && g.people.length === 1 && g.people[0].name === '김가'));
t('① 다른 사람끼리 같은 사진(명단 밖 포함)도 잡는다', r.samePhoto.items.some(g => g.people.map(p => p.seq).sort().join() === '2,9'));
t('① 해시 없는 사진은 0 으로 꾸미지 않고 noHash 로 센다', r.noHash === 1, JSON.stringify(r));
t('② 같은 업로드 묶음 안의 여러 장은 한 번 제출', !r.twice.items.some(x => x.seq === 1));
t('② 업로드 묶음이 둘이면 시간이 가까워도 두 번 제출', r.twice.items.some(x => x.seq === 5 && x.sets === 2), JSON.stringify(r.twice));
t('② 묶음 표식이 없으면 30분 넘는 간격 = 두 번 제출', r.twice.items.some(x => x.seq === 2 && x.sets === 2), JSON.stringify(r.twice));
t('③ 사진 없는 사람 · 제출 표시만 있는 사람을 구분', r.missing.count === 2 && r.missing.items.find(x => x.seq === 3).submitted === true && r.missing.items.find(x => x.seq === 4).submitted === false, JSON.stringify(r.missing));
t('④ 명단 밖 줄의 사진 + 줄 번호 없는 사진 수', r.outside.count === 1 && r.outside.items[0].seq === 9 && r.outside.unrowed === 2);
t('④ 명단 밖 사람은 ② 두 번 제출에서 세지 않는다', !r.twice.items.some(x => x.seq === 9));
const many = svc._finishInspectCompute({ people: Array.from({ length: 60 }, (_, i) => P(i + 1, 'p' + i)), revByRow: new Map(), metaRows: [] });
t('목록 상한을 넘으면 자른 사실을 말한다(truncated · 건수는 전부)', many.missing.count === 60 && many.missing.items.length === 50 && many.missing.truncated === true);
const clean = svc._finishInspectCompute({ people: [P(1, 'x')], revByRow: svc._fiReviewRows({ 1: [{ fileId: 'q', slot: 'review' }] }), metaRows: [{ file_id: 'q', file_hash: 'H', upload_batch_id: 'B' }] });
t('깨끗한 작업 = 네 가지 모두 0', !clean.samePhoto.count && !clean.twice.count && !clean.missing.count && !clean.outside.count);

console.log('\n2) 사본 0 · 배선');
const body = SVC.slice(SVC.indexOf('async function finishInspectForTab('), SVC.indexOf('function _fiReviewRows('));
t('★★ 명단은 _closeoutRoster + isFilledRow(홈·마감자료와 같은 판정)', /_closeoutRoster\(sheetId, tabName\)/.test(body) && /_isFilledRow/.test(body));
t('★★ 줄별 사진은 reviewImagesForTab(제출물 미리보기와 같은 함수)', /reviewImagesForTab\(\{ sheetId, tabName, includeReceipt: true \}\)/.test(body));
t('★ 파일 이름으로 사람을 가르지 않는다(extractReviewerNameFromFile 미사용)', !/extractReviewerNameFromFile|file_name/.test(body));
t('★ Drive 무접촉', !/drive\.|driveService/.test(body));
t('★ unrowed 조회 실패 = null(모름)', /unrowed = null/.test(body));
t('라우트 = 내부인 전용 + 스코프 게이트(/workdesk/pending 과 같다)',
  /router\.get\('\/workdesk\/finish-inspect', authMiddleware, internalMiddleware[\s\S]{0,400}_ensureThreadScope/.test(ROUTES));

console.log('\n3) 화면(마감 확인창)');
const grab = (name) => { const i = HTML.indexOf(`function ${name}(`); assert.ok(i > 0, name); for (let k = HTML.indexOf('{', i), d = 0; ; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (!d) return HTML.slice(i, k + 1); } } };
const fin = grab('_finOpen');
t('확인창이 열리면 검사를 부른다', /_finInspectLoad\(sheetId,tabName\)/.test(fin) && /id="finInspect"/.test(fin));
t('★ [마감] 게이트는 그대로 — 사람 체크(finChk) 유지 · 검수 결과로 버튼을 켜거나 막지 않는다',
  /id="finChk"/.test(fin) && !/finGo/.test(grab('_fiRender')) && !/finGo/.test(grab('_finInspectLoad')));
// vm 렌더 실행
const box = { innerHTML: '' };
const ctx = { document: { getElementById: id => (id === 'finInspect' ? box : null) }, esc: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
  _FIN: { sheetId: 'S', tabName: 'T' }, STATE: {}, console };
vm.createContext(ctx);
vm.runInContext(`let _FI=null;${grab('_fiHead')}${grab('_fiRender')}${grab('_fiToggle')}async ${grab('_finInspectLoad')}`, ctx);
ctx._FI = { r, open: {} }; vm.runInContext('_FI=this._FI;_fiRender()', ctx);
t('문제 있음 = 네 줄 + 리뷰검수로 가는 링크', /똑같은 사진/.test(box.innerHTML) && /두 번 제출/.test(box.innerHTML) && /사진이 없음/.test(box.innerHTML) && /명단에 없는/.test(box.innerHTML) && /_finInspectGo/.test(box.innerHTML));
t('명단 밖 건수 = 줄 + 줄 번호 없는 사진', /명단에 없는 사람의 사진<\/span><span class="n">3건/.test(box.innerHTML), box.innerHTML.slice(0, 0));
vm.runInContext("_fiToggle('missing')", ctx);
t('건수를 누르면 이름이 펼쳐지고 제출 표시만 있는 사람을 구분', /박다 <span class="m">\(제출 표시는 있음\)/.test(box.innerHTML));
t('해시 없는 사진 수를 말한다', /1장은 비교 정보가 없어/.test(box.innerHTML));
ctx._FI = { r: clean, open: {} }; vm.runInContext('_FI=this._FI;_fiRender()', ctx);
t('깨끗하면 한 줄', /모두 없음/.test(box.innerHTML) && !/fi-r/.test(box.innerHTML));
ctx._FI = { r: { ...clean, outside: { ...clean.outside, unrowed: null } }, open: {} }; vm.runInContext('_FI=this._FI;_fiRender()', ctx);
t('★ 줄 번호 없는 사진을 못 셌으면 그 사실을 말한다', /확인하지 못했습니다/.test(box.innerHTML));
(async () => {
  ctx.api = async () => { throw new Error('net'); };
  await vm.runInContext("_finInspectLoad('S','T')", ctx);
  t('★ 조회 실패 = "검사하지 못했습니다"(0건으로 꾸미지 않음) + 다시 검사', /검사하지 못했습니다/.test(box.innerHTML) && /다시 검사/.test(box.innerHTML) && !/모두 없음/.test(box.innerHTML));
  ctx.api = async () => ({ ok: true, ...clean });
  ctx._FIN = { sheetId: 'OTHER', tabName: 'X' }; box.innerHTML = 'keep';
  vm.runInContext('_FIN=this._FIN', ctx);
  await vm.runInContext("_finInspectLoad('S','T')", ctx);
  t('★ 늦게 온 응답이 다른 작업의 창이면 그리지 않는다', !/모두 없음/.test(box.innerHTML));
  console.log(`\n✅ ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
