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
// Codex P2 — 칸이 여럿인 작업: 한 번 제출에 칸마다 묶음 ID 가 따로 생긴다 → 두 번 제출 아님
const multi = svc._finishInspectCompute({ people: [P(7, '칸둘')], revByRow: svc._fiReviewRows({ 7: [{ fileId: 'm1', slot: 'review' }, { fileId: 'm2', slot: 'slot2' }] }),
  metaRows: [{ file_id: 'm1', file_hash: 'X1', upload_batch_id: 'K1' }, { file_id: 'm2', file_hash: 'X2', upload_batch_id: 'K2' }] });
t('★ 칸(slot)이 다르면 묶음이 둘이어도 한 번 제출(Codex P2)', multi.twice.count === 0, JSON.stringify(multi.twice));
const clean = svc._finishInspectCompute({ people: [P(1, 'x')], revByRow: svc._fiReviewRows({ 1: [{ fileId: 'q', slot: 'review' }] }), metaRows: [{ file_id: 'q', file_hash: 'H', upload_batch_id: 'B' }] });
t('깨끗한 작업 = 네 가지 모두 0', !clean.samePhoto.count && !clean.twice.count && !clean.missing.count && !clean.outside.count);

console.log('\n2) 사본 0 · 배선');
t('★★ 검사는 strict · 상한 없음 · 구매캡처 생략으로 사진을 읽는다(Codex P1·P2)',
  /reviewImagesForTab\(\{ sheetId, tabName, includeReceipt: true, strict: true, maxPerRow: Infinity, withCaptures: false \}\)/.test(SVC));
t('라우트가 리뷰검수로 보낼 수 있는지(canOpenInspect)를 리뷰검수 게이트와 같은 canAccessTab 으로 싣는다(Codex P1)',
  /out\.canOpenInspect = role === 'master' \|\| role === 'admin'[\s\S]{0,160}canAccessTab\(\{ role: 'staff'/.test(ROUTES));
const body = SVC.slice(SVC.indexOf('async function finishInspectForTab('), SVC.indexOf('function _fiReviewRows('));
t('★★ 명단은 _closeoutRoster + isFilledRow(홈·마감자료와 같은 판정)', /_closeoutRoster\(sheetId, tabName\)/.test(body) && /_isFilledRow/.test(body));
t('★★ 줄별 사진은 reviewImagesForTab(제출물 미리보기와 같은 함수)', /reviewImagesForTab\(\{ sheetId, tabName, includeReceipt: true/.test(body));
t('★ 파일 이름으로 사람을 가르지 않는다(extractReviewerNameFromFile 미사용)', !/extractReviewerNameFromFile|file_name/.test(body));
t('★ Drive 무접촉', !/drive\.|driveService/.test(body));
t('★ unrowed 조회 실패 = null(모름)', /unrowed = null/.test(body));
t('라우트 = 스코프 게이트(_ensureThreadScope — 내부인 · 업체 소유 탭 · 브랜드 배정 탭, 결정 298)',
  /router\.get\('\/workdesk\/finish-inspect', authMiddleware, async[\s\S]{0,400}_ensureThreadScope/.test(ROUTES));
t('★★ 이름은 직원·업체 동일 — 라우트가 역할별로 이름을 바꾸지 않는다(사용자 확정)', /finishInspectForTab\(\{ sheetId, tabName \}\)/.test(ROUTES) && !/maskNames/.test(ROUTES));
const masked = svc._finishInspectCompute({ people: [P(1, '홍길동'), P(2, '김철수')], revByRow: svc._fiReviewRows({ 1: [{ fileId: 'a', slot: 'review' }, { fileId: 'b', slot: 'review' }] }),
  metaRows: [{ file_id: 'a', file_hash: 'H' }, { file_id: 'b', file_hash: 'H' }] });
t('이름은 그대로(같은 사진·사진 없음 목록 모두)', masked.samePhoto.items[0].people[0].name === '홍길동' && masked.missing.items[0].name === '김철수', JSON.stringify(masked));
t('★ 응답에 파일ID 를 싣지 않는다', !JSON.stringify(masked).includes('"a"') && !/fileIds/.test(JSON.stringify(r)));

console.log('\n3) 화면(마감 확인창 · [🔍 리뷰 점검])');
const grab = (name) => { const i = HTML.indexOf(`function ${name}(`); assert.ok(i > 0, name); for (let k = HTML.indexOf('{', i), d = 0; ; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (!d) return HTML.slice(i, k + 1); } } };
const fin = grab('_finOpen');
t('확인창이 열리면 검사를 부른다(마감 모드)', /_fiLoad\('finInspect',sheetId,tabName,'finish'\)/.test(fin) && /id="finInspect"/.test(fin));
t('★ [마감] 게이트는 그대로 — 사람 체크(finChk) 유지 · 검수 결과로 버튼을 켜거나 막지 않는다',
  /id="finChk"/.test(fin) && !/finGo/.test(grab('_fiRender')) && !/finGo/.test(grab('_fiLoad')));
t('★★ [🔍 리뷰 점검] 버튼은 역할 조건 없이(업체 포함) · 마감 작업에서도 그린다(결정 298)',
  /const checkBtn=`<button class="btn" type="button" onclick="openReviewCheck\(\)"/.test(HTML) && /\$\{checkBtn\}/.test(HTML) && !/wd\.archived\?'':checkBtn/.test(HTML));
t('[🔍 리뷰 점검] 은 같은 렌더러를 도구 모드로 부른다', /_fiLoad\('rcInspect',t\.sheetId,t\.tabName,'tool'\)/.test(grab('openReviewCheck')));
const boxes = {};
const mkEl = id => (boxes[id] = boxes[id] || { innerHTML: '' });
const ctx = { document: { getElementById: id => (['finInspect', 'rcInspect'].includes(id) ? mkEl(id) : null) }, esc: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
  _FIN: { sheetId: 'S', tabName: 'T' }, STATE: { role: 'admin' }, console };
vm.createContext(ctx);
vm.runInContext(`const _FIS={};${grab('_fiHead')}${grab('_fiTitle')}${grab('_fiRender')}${grab('_fiToggle')}async ${grab('_fiLoad')}${grab('_fiRetry')}`, ctx);
const show = (id, res, mode, role) => { ctx.STATE.role = role || 'admin'; vm.runInContext(`_FIS['${id}']={sheetId:'S',tabName:'T',mode:'${mode}',seq:1,r:this.__r,open:{}};_fiRender('${id}')`, Object.assign(ctx, { __r: res })); return boxes[id].innerHTML; };
let h = show('finInspect', r, 'finish');
t('문제 있음 = 네 줄 + 리뷰검수로 가는 링크', /똑같은 사진/.test(h) && /두 번 제출/.test(h) && /사진이 없음/.test(h) && /명단에 없는/.test(h) && /_fiGo\('finInspect'\)/.test(h));
t('명단 밖 건수 = 줄 + 줄 번호 없는 사진', /명단에 없는 사람의 사진<\/span><span class="n">3건/.test(h));
t('마감 모드의 "사진 없음"은 빨강', /fi-r bad"><span class="nm">명단에 있는데 리뷰 사진이 없음/.test(h));
vm.runInContext("_fiToggle('finInspect','missing')", ctx);
t('건수를 누르면 이름이 펼쳐지고 제출 표시만 있는 사람을 구분', /박다 <span class="m">\(제출 표시는 있음\)/.test(boxes.finInspect.innerHTML));
t('해시 없는 사진 수를 말한다', /1장은 비교 정보가 없어/.test(boxes.finInspect.innerHTML));
h = show('rcInspect', r, 'tool');
t('★ 도구 모드: "아직 리뷰 사진이 없는 사람" 회색 + 참여·사진 요약', /fi-r info"><span class="nm">아직 리뷰 사진이 없는 사람/.test(h) && /참여 <b>5명<\/b>/.test(h));
h = show('rcInspect', r, 'tool', 'advertiser');
t('★★ 업체 화면에는 리뷰검수 링크 대신 "담당자가 합니다"', !/_fiGo/.test(h) && /담당자가 합니다/.test(h));
t('★ 업체가 링크 함수를 불러도 이동하지 않는다', /STATE\.role==='advertiser'\) return/.test(grab('_fiGo')));
h = show('finInspect', { ...r, canOpenInspect: false }, 'finish');
t('★ 리뷰검수로 못 가는 직원에게는 링크 대신 안내(403 막다른 길 금지)', !/_fiGo/.test(h) && /담당 AE·관리자/.test(h));
h = show('finInspect', clean, 'finish');
t('깨끗하면 한 줄', /모두 없음/.test(h) && !/fi-r/.test(h));
h = show('finInspect', { ...clean, outside: { ...clean.outside, unrowed: null } }, 'finish');
t('★ 줄 번호 없는 사진을 못 셌으면 그 사실을 말한다', /확인하지 못했습니다/.test(h));
(async () => {
  ctx.api = async () => { throw new Error('net'); };
  await vm.runInContext("_fiLoad('rcInspect','S','T','tool')", ctx);
  t('★ 조회 실패 = "검사하지 못했습니다"(0건으로 꾸미지 않음) + 다시 검사', /검사하지 못했습니다/.test(boxes.rcInspect.innerHTML) && /다시 검사/.test(boxes.rcInspect.innerHTML) && !/모두 없음/.test(boxes.rcInspect.innerHTML));
  let release; ctx.api = () => new Promise(res => { release = () => res({ ok: true, ...clean }); });
  const p1 = vm.runInContext("_fiLoad('rcInspect','S','T','tool')", ctx);
  ctx.api = async () => ({ ok: false, error: '두번째' });
  await vm.runInContext("_fiLoad('rcInspect','S2','T2','tool')", ctx);
  release(); await p1;
  t('★ 늦게 온 앞 요청의 응답은 그리지 않는다(상자가 다른 작업으로 넘어감)', !/모두 없음/.test(boxes.rcInspect.innerHTML) && /두번째/.test(boxes.rcInspect.innerHTML));
  ctx._FIN = { sheetId: 'OTHER', tabName: 'X' }; vm.runInContext('_FIN=this._FIN', ctx);
  ctx.api = async () => ({ ok: true, ...clean }); boxes.finInspect.innerHTML = 'keep';
  await vm.runInContext("_fiLoad('finInspect','S','T','finish')", ctx);
  t('★ 마감 확인창이 다른 작업으로 바뀌었으면 그리지 않는다', !/모두 없음/.test(boxes.finInspect.innerHTML));
  // Codex P1/P2 — reviewImagesForTab strict·상한 실제 실행(스텁 pool)
  const mkPool = (failSubs) => ({ async query(sql) {
    const q = String(sql);
    if (/FROM tab_configs/.test(q)) return { rows: [{ gid: '', capture_slots: null, income_type: '' }] };
    if (/FROM review_submissions rs/.test(q)) { if (failSubs) throw new Error('db down');
      return { rows: Array.from({ length: 13 }, (_, i) => ({ row_index: 1, file_id: 'f' + i, slot_key: 'review', at: null })) }; }
    if (/FROM review_index/.test(q)) return { rows: [{ row_index: 1, review_file_id: 'legacy', review_file_at: null }] };
    return { rows: [] };
  } });
  svc.__setPoolForTest(mkPool(true));
  let threw = false; try { await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T', includeReceipt: true, strict: true, withCaptures: false }); } catch (_) { threw = true; }
  t('★★ strict 에서는 원장 조회 실패를 던진다(일부만 보고 "모두 없음" 금지 — Codex P1)', threw);
  const soft = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T', includeReceipt: true });
  t('기본(미리보기) 동작은 종전대로 fail-soft', soft && soft['1'] && soft['1'].length === 1);
  svc.__setPoolForTest(mkPool(false));
  const all = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T', includeReceipt: true, strict: true, maxPerRow: Infinity, withCaptures: false });
  const cap12 = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T', includeReceipt: true });
  t('★ 검사는 13장 전부 · 미리보기는 종전 12장 상한(Codex P2)', all['1'].length === 14 && cap12['1'].length === 12, all['1'].length + '/' + cap12['1'].length);
  svc.__setPoolForTest(null);
  console.log(`\n✅ ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
