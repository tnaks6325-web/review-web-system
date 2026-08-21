/**
 * workOrderTabDeleted.test.js — 작업 삭제가 작업오더에 남기는 표시 (사용자 확정 2026-08-21)
 *
 * 고정하는 계약
 *   ① 홈 작업목록 [작업 삭제]가 연결 작업오더에 **삭제 시각·삭제자·지워진 작업 이름**을 새긴다
 *      (종전엔 링크만 비워 "아직 접수 안 한 오더"와 구분이 안 됐다)
 *   ② 재접수하면 그 세 칸을 **비운다** — 다시 연결됐는데 삭제 배지가 남으면 화면이 거짓을 말한다
 *      (이력은 memo_log `kind:'tab_deleted'` 에 남는다)
 *   ③ 인트라넷 "보낸 오더" 알림 실행부는 `intranetMemo.service` **한 벌**(사본 금지) · fail-soft
 *   ④ 화면은 값이 있을 때만 그린다(구버전 백엔드·삭제 이력 없음 = 아무것도 안 그림)
 *   ⑤ [📋 작업표]는 접수 **전** 창구 — 접수 뒤에는 실제 작업보드로 보낸다(가정 계산 오해 차단)
 *   ⑥ `REQUIRED_SCHEMA` 등록(컬럼 없으면 삭제가 전면 42703)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const svc = read('src/services/workTabDelete.service.js');
const orderRoutes = read('src/routes/order.routes.js');
const memoSvc = read('src/services/intranetMemo.service.js');
const indexJs = read('index.js');
const migration = read('migrations/134_work_order_tab_deleted.sql');
const wd = read('../frontend/workdesk.html');

(async () => {
console.log('\n[A] 마이그레이션 134');
ok('세 칸 추가(tab_deleted_at / _by / _tab)',
  /ADD COLUMN IF NOT EXISTS tab_deleted_at\s+TIMESTAMPTZ/.test(migration)
  && /ADD COLUMN IF NOT EXISTS tab_deleted_by/.test(migration)
  && /ADD COLUMN IF NOT EXISTS tab_deleted_tab/.test(migration));
ok('★ 백필 0 — UPDATE 가 없다(배포 즉시 동작 불변)', !/\bUPDATE\s+work_orders/i.test(migration));
ok('★ REQUIRED_SCHEMA 등록', /\['work_orders', 'tab_deleted_at'\]/.test(indexJs));

console.log('\n[B] 삭제가 남기는 표시');
{
  // deleteTask 본문만 잘라서 본다(미리보기 쪽 UPDATE 와 섞이지 않게)
  const i = svc.indexOf('async function deleteTask');
  const body = svc.slice(i, svc.indexOf('\nasync function ', i + 40) + 1 || undefined);
  const upd = /UPDATE work_orders SET linked_tab_sheet_id='',[\s\S]{0,400}?\[sheetId, tabName, String\(by \|\| ''\)\]\)/.exec(body);
  ok('링크 해제와 **같은 문장**에서 삭제 시각을 새긴다(따로 쓰면 한쪽만 실패한다)', !!upd);
  ok('tab_deleted_at=NOW() · _by · _tab 세 칸을 함께', !!upd
    && /tab_deleted_at=NOW\(\)/.test(upd[0]) && /tab_deleted_by=\$3/.test(upd[0]) && /tab_deleted_tab=\$2/.test(upd[0]));
  ok('★ 알릴 대상을 RETURNING 으로 받는다(오더를 다시 조회하지 않는다)',
    !!upd && /RETURNING id, title, status, created_by/.test(upd[0]));
  ok('★ 오더 자체는 남긴다 — DELETE FROM work_orders 없음(재접수 가능)',
    !/DELETE FROM work_orders/i.test(svc));
}

console.log('\n[C] 인트라넷 알림 — 실행부 한 벌 · fail-soft · 커밋 뒤');
{
  ok('실행부는 intranetMemo.service 를 쓴다(사본 금지)',
    /require\('\.\/intranetMemo\.service'\)/.test(svc)
    && /pushIntranetMemo/.test(svc) && /appendMemoLog/.test(svc));
  ok('★ order.routes 도 같은 서비스에 위임한다(webhook 사본 0)',
    /require\('\.\.\/services\/intranetMemo\.service'\)\.pushIntranetMemo/.test(orderRoutes)
    && !/const hook = process\.env\.INTRANET_MEMO_WEBHOOK_URL/.test(orderRoutes));
  ok('★ 알림은 COMMIT 뒤에만(실패해도 삭제는 이미 끝났다)',
    svc.indexOf("await client.query('COMMIT')") < svc.indexOf('_notifyOrdersTabDeleted(wo.rows'));
  ok('★ 절대 throw 없음 — 건별 try/catch', /_notifyOrdersTabDeleted[\s\S]*?catch \(e\) \{ deliverError/.test(svc));
  ok('★ memo_log 에 kind:"tab_deleted" 로 이력을 남긴다(재접수해도 남는 유일한 기록)',
    /kind: 'tab_deleted'/.test(svc));
  ok('★ webhook 은 fail-soft(서비스가 throw 하지 않는다)',
    /catch \(e\) \{\s*deliverError = e\.message;/.test(memoSvc) && !/^\s*throw\b/m.test(memoSvc));
}

console.log('\n[D] 재접수하면 표시를 지운다');
{
  const acc = /UPDATE work_orders SET[\s\S]{0,900}?linked_tab_sheet_id = \$3[\s\S]{0,900}?RETURNING \*/.exec(orderRoutes);
  ok('accept UPDATE 가 세 칸을 NULL 로 되돌린다',
    !!acc && /tab_deleted_at = NULL, tab_deleted_by = NULL, tab_deleted_tab = NULL/.test(acc[0]));
  ok('★ 인트라넷 보낸 오더 목록(intake/list)에도 값을 실어 보낸다(가산적)',
    /tab_deleted_at, tab_deleted_tab/.test(orderRoutes));
}

console.log('\n[E] 화면 — 값이 있을 때만 그린다');
{
  const i = wd.indexOf('function _woDeletedBadge(');
  const fn = wd.slice(i, wd.indexOf('\nfunction ', i + 10));
  const sandbox = { esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\n;this.__b=_woDeletedBadge;', sandbox);
  const b = sandbox.__b;
  ok('★ 값이 없으면 빈 문자열(0/미상을 지어내지 않는다)', b({}) === '' && b({ tab_deleted_at: null }) === '');
  const out = b({ tab_deleted_at: '2026-08-21T02:00:00Z', tab_deleted_tab: '8/14 모기기피제', tab_deleted_by: '박세희' });
  ok('삭제 배지에 시각이 들어간다', /작업 삭제됨/.test(out) && /\d\d\.\s?\d\d/.test(out));
  ok('★ 지워진 작업 이름·삭제자는 툴팁으로(행이 길어지지 않게)',
    /title="/.test(out) && out.indexOf('8/14 모기기피제') > out.indexOf('title="'));
  const xss = b({ tab_deleted_at: '2026-08-21T02:00:00Z', tab_deleted_tab: '"><img src=x onerror=alert(1)>' });
  ok('★ 시트발 문자열은 escape — 속성 탈출 불가', !/<img/.test(xss) && /&quot;|&lt;/.test(xss));

  ok('목록 행이 배지를 그린다', /\$\{esc\(o\.title\|\|''\)\}\$\{_woDeletedBadge\(o\)\}/.test(wd));
  ok('펼침에도 사유 + 다음 행동(재접수)을 한 줄로', /class="woldel"/.test(wd) && /다시 진행하려면 <b>접수하기<\/b>/.test(wd));
  ok('CSS 는 리터럴 색(테마 없는 호스트 대비)', /\.wodel\{[^}]*#B91C1C/.test(wd) && /\.woldel\{[^}]*#FEF2F2/.test(wd));
}

console.log('\n[F] [📋 작업표] 는 접수 전 창구 — 접수 뒤에는 실제 작업보드로');
{
  const i = wd.indexOf('function _woEditActions(o){');
  const fn = wd.slice(i, wd.indexOf('\n/* ✏ 관리자 수정', i));
  ok('접수 전 = openWtPlan(구성 보고 그 자리에서 접수)', /_woAcceptedTab\(o\)[\s\S]{0,400}openWtPlan\('\$\{id\}'\)/.test(fn));
  ok('★ 접수 후 = 실제 작업보드로 보낸다(가정 계산 미리보기 오해 차단)', /_woOpenBoard\('\$\{id\}'\)/.test(fn));
  ok('★ 이동은 pendingTab 계약 그대로(사본 금지)',
    /function _woOpenBoard\(id\)\{[\s\S]{0,400}STATE\.pendingTab=\{[\s\S]{0,200}switchView\('workdesk'\)/.test(wd));
  ok('★ 연결이 없으면 눌러도 막다른 길이 아니다(사유를 말한다)',
    /_woAcceptedTab\(o\)\)\{ _toast\('연결된 작업이 없습니다/.test(wd));
  ok('onclick 에는 id 만 — 오더 제목 같은 외부 문자열 보간 0',
    !/_woOpenBoard\('\$\{esc\(o\.(title|linked_tab_name)/.test(wd));
}

console.log('\n[G] 관리자 수정 모달 — 발주서 원문임을 말한다');
{
  const md = read('../frontend/js/work-order-detail.js');
  ok('공고 연결 여부로 안내가 갈린다', /var linkedCamp = !!\(o\.linked_campaign_id/.test(md));
  ok('★ 공고가 있으면 "리뷰어 화면·정원은 공고가 정한다"를 말한다',
    /모집공고가 연결돼 있어[\s\S]{0,120}공고<\/b>가 정합니다/.test(md));
  ok('★ 공고가 없으면 "여기 값이 작업표 계획·정원의 기준"이라고 말한다',
    /이 값이 곧 작업표 계획\(열·행 수·날짜 분배\)과 정원의 기준/.test(md));
  ok('★ 여기서만 정하는 것(담당AE·물건비·배송/택배대행)을 짚는다',
    /여기서만 정하는 것<\/b> — 담당AE · 물건비/.test(md));
  ok('겹치는 칸에는 "공고 우선"을 한 줄로(조용한 no-op 오해 방지)',
    /function ch\(base, what\)/.test(md)
    && /hint: ch\("", "총인원"\)/.test(md) && /hint: ch\("", "일 모집인원"\)/.test(md)
    && /ch\("", "리뷰타입"\)/.test(md) && /ch\("모집공고 생성 시[^"]*", "리뷰비/.test(md));
  ok('★ 공고 미연결이면 그 줄을 그리지 않는다(빈 힌트)', /if \(!linkedCamp\) return base \|\| "";/.test(md));
}


console.log('\n[H] 실제 실행 — 스텁 pool 로 deleteTask 를 돌린다');
{
  const log = [];
  const run = async (text, params) => {
    const t = String(text).replace(/\s+/g, ' ').trim();
    log.push({ t, params });
    if (/UPDATE work_orders SET linked_tab_sheet_id=''/.test(t)) {
      return { rows: [{ id: 'wo_1', title: '모기기피제 500건', status: 'reviewing', created_by: '김AE' }], rowCount: 1 };
    }
    if (/SELECT memo_log FROM work_orders/.test(t)) return { rows: [{ memo_log: '[]' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const svcMod = require('../src/services/workTabDelete.service');
  svcMod.__setPoolForTest({ query: run, connect: async () => ({ query: run, release() {} }) });
  delete process.env.INTRANET_MEMO_WEBHOOK_URL;   // webhook 미설정 = 미전송(그래도 죽지 않는다)

  const out = await svcMod.deleteTask({ sheetId: 'wt_x', tabName: '8/14 모기기피제', by: '박세희', confirm: true });
  ok('삭제가 성공한다', out && out.ok === true);
  const upd = log.find(q => /UPDATE work_orders SET linked_tab_sheet_id=''/.test(q.t));
  ok('★ 삭제자·작업 이름이 실제로 파라미터로 들어간다',
    !!upd && upd.params[1] === '8/14 모기기피제' && upd.params[2] === '박세희');
  ok('★ 연결 오더 1건에 알림을 만든다', Array.isArray(out.orderNotices) && out.orderNotices.length === 1
    && out.orderNotices[0].id === 'wo_1');
  ok('★ webhook 미설정이어도 삭제는 성공하고 사유를 말한다(fail-soft)',
    out.orderNotices[0].delivered === false && /미설정/.test(String(out.orderNotices[0].error || '')));
  const memo = log.find(q => /UPDATE work_orders SET memo_log/.test(q.t));
  ok('★ memo_log 에 삭제 이력이 실제로 쌓인다', !!memo && /tab_deleted/.test(String(memo.params[1])));
  ok('★ 드라이브는 요청하지 않으면 손대지 않는다', Array.isArray(out.driveTrashed) && out.driveTrashed.length === 0);
  svcMod.__setPoolForTest(null);
}

console.log(`\n✅ workOrderTabDeleted: ${pass} 케이스 통과`);
process.exit(0);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
