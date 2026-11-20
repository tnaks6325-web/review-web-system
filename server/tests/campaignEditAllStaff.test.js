/**
 * campaignEditAllStaff.test.js — 결정 380 회귀가드
 * 실행: node tests/campaignEditAllStaff.test.js
 *
 * 사용자 확정(2026-11-18 · 선택 A): 리뷰웹시스템[3버전]의 **모집공고 수정·만들기·게시 상태·보관**은
 * 리뷰어·업체를 뺀 **모든 내부 직원**(master/admin/staff)이 할 수 있다. 편집 허용 명단(workdesk_editors)은
 * 작업오더 접수·수정 · 외부모집 수동제출 · 리뷰어 검색(개인정보)에만 남는다(결정 269·348 완화 금지 유지).
 *
 * 위험 = 권한이 한 칸만 어긋나도 ㉮ 업체·리뷰어 토큰에 공고 쓰기가 열리거나 ㉯ 버튼은 보이는데 403(막다른 길)
 * ㉰ 명단 밖 직원이 공개 뷰를 받아 저장하면 기존 설정이 지워진다. → **실제 HTTP** 로 두드린다(라우터 스택 + 게이트).
 * 위임 핸들러(공고·오더·수동제출)는 스텁으로 바꿔 끼워 "게이트를 통과했는가"만 본다(DB 미접촉).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'campaign-edit-all-staff-secret';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ── 스텁: DB · 위임 핸들러 ───────────────────────────────── */
const pool = require('../src/db/pool');
let dbDown = false;
pool.query = async (sql, params) => {
  const s = String(sql);
  if (dbDown) throw new Error('db down (test)');
  if (/FROM workdesk_editors WHERE active/.test(s)) return { rows: [{ name: '명단직원' }] };
  if (/FROM recruit_campaigns/.test(s) && /source_work_order_id/.test(s)) {
    const [cid, woId] = params || [];
    return { rows: (cid === 'camp-from-wo' && woId === 'wo-1') ? [{ ok: 1 }] : [] };
  }
  throw new Error('unexpected query in test: ' + s.slice(0, 80));
};
const stubHandlers = (mod) => {
  const routes = require(mod);
  routes.handlers = new Proxy({}, {
    get: (_, name) => (req, res) => res.json({ ok: true, h: String(name), trusted: req._trustedAdminView === true }),
  });
};
stubHandlers('../src/routes/campaign.routes');
stubHandlers('../src/routes/order.routes');
stubHandlers('../src/routes/manualOrder.routes');
require('../src/services/productPageReader.service').extractProductPage = async () => ({ status: 200, body: { ok: true, h: 'extract' } });

const wdEditors = require('../src/utils/workdeskEditors');

(async () => {
  console.log('\n▶ 결정 380 — 모집공고 편집은 내부 직원 전원(명단은 오더·수동제출·리뷰어 검색에만)\n');

  /* ── A. 단일 출처 판정 함수 ─────────────────────────────── */
  console.log('A. canEditCampaign 판정(단일 출처)');
  const cec = wdEditors.canEditCampaign;
  ok('A0 workdeskEditors 가 canEditCampaign · campaignEditorMiddleware 를 내보낸다',
    typeof cec === 'function' && typeof wdEditors.campaignEditorMiddleware === 'function');
  if (typeof cec === 'function') {
    ok('A1 master · admin · staff(자체) · 인트라넷 staff(AE 아님·명단 밖) · 인트라넷 admin = 허용',
      [{ role: 'master', name: 'm' }, { role: 'admin', name: 'a' }, { role: 'staff', name: 's' },
        { role: 'staff', via: 'intranet', ae: false, name: '명단밖직원' }, { role: 'admin', via: 'intranet', name: '명단밖관리자' }]
        .every(a => cec(a) === true));
    ok('A2 업체(계정·업체링크·브랜드링크) · 리뷰어 공고수정 토큰 · 비로그인 토큰 · 빈 값 = 거절',
      [{ role: 'advertiser', name: 'x' }, { role: 'advertiser', via: 'link', name: 'x' },
        { role: 'advertiser', via: 'brand-link', name: 'x' },
        { role: 'admin', via: 'reviewer_campaign', iu: 'u', ia: true, name: 'r' },
        { role: 'admin', aud: 'reviewer-app', name: 'r' }, { role: 'staff', scope: 'reviewer_home_admin', name: 'r' },
        { role: 'staff', purpose: 'x', name: 'r' }, { role: 'reviewer', name: 'r' }, {}, null, undefined]
        .every(a => cec(a) === false));
    ok('A3 판정은 명단(DB)을 보지 않는다 — DB 가 죽어도 내부 직원은 허용(동기 함수)',
      (() => { dbDown = true; try { const r = cec({ role: 'staff', via: 'intranet', ae: false, name: 'z' }); return r === true; } finally { dbDown = false; } })());
  }

  /* ── B. 실제 HTTP ──────────────────────────────────────── */
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/trackb', require('../src/routes/trackB.routes'));
  const srv = await new Promise(res => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/trackb`;
  const hit = async (method, p, tok, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + jwt.sign(tok, process.env.JWT_SECRET);
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let b = null; try { b = await r.json(); } catch (_) { /* noop */ }
    return { status: r.status, body: b };
  };
  const T = {
    outStaff: { role: 'staff', via: 'intranet', ae: false, name: '명단밖직원' },
    outAdmin: { role: 'admin', via: 'intranet', name: '명단밖관리자' },
    inStaff: { role: 'staff', via: 'intranet', ae: false, name: '명단직원' },
    master: { role: 'master', name: '마스터' },
    adv: { role: 'advertiser', name: '광고주', advertiser_id: 1 },
    advLink: { role: 'advertiser', name: '광고주', advertiser_id: 1, via: 'link' },
    brand: { role: 'advertiser', name: '브랜드', advertiser_id: 1, brand_id: 2, via: 'brand-link' },
    reviewerCamp: { role: 'admin', via: 'reviewer_campaign', iu: 'rv', ia: true, name: '리뷰어관리' },
    reviewerApp: { role: 'staff', aud: 'reviewer-app', name: '리뷰어' },
  };
  const CAMP_WRITES = [
    ['POST', '/campaigns/create', {}],
    ['PUT', '/campaigns/c1', { title: 'x' }],
    ['POST', '/campaigns/c1/flags', {}],
    ['POST', '/campaigns/c1/confirm', {}],
    ['PUT', '/campaigns/c1/status', { status: 'active' }],
    ['POST', '/campaigns/c1/dismiss', {}],
    ['POST', '/campaigns/c1/blog-approve', {}],
    ['POST', '/campaigns/c1/blog-reject', {}],
    ['POST', '/campaigns/c1/archive', { archived: true }],
    ['POST', '/campaigns/product-page/extract', { text: 'x' }],
  ];
  try {
    console.log('\nB. 모집공고 쓰기 — 명단 밖 내부 직원 허용');
    for (const [m, p, b] of CAMP_WRITES) {
      const s = await hit(m, p, T.outStaff, b);
      ok(`B1 ${m} ${p} — 명단 밖 인트라넷 staff 통과`, s.status === 200 && s.body && s.body.ok === true, 'status=' + s.status);
    }
    for (const [m, p, b] of CAMP_WRITES) {
      const s = await hit(m, p, T.outAdmin, b);
      ok(`B2 ${m} ${p} — 명단 밖 admin 통과`, s.status === 200, 'status=' + s.status);
    }
    dbDown = true;
    try {
      const s = await hit('PUT', '/campaigns/c1', T.outStaff, { title: 'x' });
      ok('B3 명단 조회가 죽어도 공고 수정은 내부 직원이면 통과(명단과 무관)', s.status === 200, 'status=' + s.status);
    } finally { dbDown = false; }

    console.log('\nC. 모집공고 쓰기 — 업체·리뷰어·토큰 없음 = 거절(적대 시험)');
    for (const [m, p, b] of CAMP_WRITES) {
      const r0 = await hit(m, p, null, b);
      const ra = await hit(m, p, T.adv, b);
      const rl = await hit(m, p, T.advLink, b);
      const rb = await hit(m, p, T.brand, b);
      const rr = await hit(m, p, T.reviewerCamp, b);
      const rp = await hit(m, p, T.reviewerApp, b);
      ok(`C1 ${m} ${p} — 무인증 401 · 업체 3종 403 · 리뷰어 공고수정 토큰 403 · 리뷰어 앱 토큰 401`,
        r0.status === 401 && ra.status === 403 && rl.status === 403 && rb.status === 403
        && rr.status === 403 && rp.status === 401,
        [r0, ra, rl, rb, rr, rp].map(x => x.status).join('/'));
    }

    console.log('\nD. 공고 상세(수정 창 채우기) — 편집할 수 있는 사람에게는 전체 행');
    {
      const s = await hit('GET', '/campaigns/c1', T.outStaff);
      ok('D1 ★ 명단 밖 직원도 전체 편집 뷰(공개 뷰를 받아 저장하면 기존 설정이 지워진다)',
        s.status === 200 && s.body && s.body.trusted === true, JSON.stringify(s.body));
      const a = await hit('GET', '/campaigns/c1', T.adv);
      ok('D2 업체는 상세 프록시 자체가 403', a.status === 403);
    }

    console.log('\nE. 화면 판정 재료 — /perm · /campaigns/list');
    {
      const p = await hit('GET', '/perm', T.outStaff);
      ok('E1 /perm: 명단 밖 직원 canEditCampaign=true · canEdit=false(명단 판정은 그대로)',
        p.status === 200 && p.body && p.body.canEditCampaign === true && p.body.canEdit === false, JSON.stringify(p.body));
      const pi = await hit('GET', '/perm', T.inStaff);
      ok('E2 /perm: 명단 안 직원 canEditCampaign=true · canEdit=true', pi.body && pi.body.canEditCampaign === true && pi.body.canEdit === true);
      const l = await hit('GET', '/campaigns/list', T.outStaff);
      ok('E3 /campaigns/list 에도 canEditCampaign=true(같은 판정)', l.status === 200 && l.body && l.body.canEditCampaign === true, JSON.stringify(l.body));
    }

    console.log('\nF. 명단 게이트는 그대로 — 오더 접수·수정 · 수동제출 · 리뷰어 검색 · 공고 삭제');
    const LIST_ONLY = [
      ['POST', '/work-orders/accept', { id: 'wo-1' }], ['PUT', '/work-orders/status', { id: 'wo-1' }],
      ['PUT', '/work-orders/edit', { id: 'wo-1' }],
      ['POST', '/manual-order/preview', {}], ['POST', '/manual-order/submit', {}],
      ['POST', '/manual-order/dual/submit', {}], ['POST', '/manual-order/dual/complete', {}],
      ['GET', '/manual-order/dual/pending', undefined],
      ['GET', '/manual-order/reviewer-search?q=%EA%B9%80%EC%88%98', undefined],
      ['DELETE', '/campaigns/c1', undefined],
    ];
    for (const [m, p, b] of LIST_ONLY) {
      const s = await hit(m, p, T.outStaff, b);
      const a = await hit(m, p, T.outAdmin, b);
      const i = await hit(m, p, T.inStaff, b);
      ok(`F1 ${m} ${p.split('?')[0]} — 명단 밖 staff·admin 403 · 명단 안 직원 통과`,
        s.status === 403 && a.status === 403 && i.status === 200, [s, a, i].map(x => x.status).join('/'));
    }
    for (const p of ['/campaigns/c1/options/merge', '/campaigns/c1/capture-product-fill']) {
      const s = await hit('POST', p, T.outStaff, {});
      ok(`F2 POST ${p} — 관리자 전용 그대로(staff 403)`, s.status === 403, 'status=' + s.status);
    }

    console.log('\nG. 발행 직후 작업오더 역연결 — 그 오더로 만든 공고의 연결만 공고 권한으로');
    {
      const okLink = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', linked_campaign_id: 'camp-from-wo' });
      ok('G1 명단 밖 직원: 그 오더로 만든 공고의 역연결만 통과', okLink.status === 200 && okLink.body && okLink.body.h === 'orderAdminUpdate',
        JSON.stringify(okLink));
      const other = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', linked_campaign_id: 'camp-other' });
      ok('G2 다른 오더의 공고를 붙이려 하면 403', other.status === 403, 'status=' + other.status);
      const memo = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', linked_campaign_id: 'camp-from-wo', admin_memo: 'x' });
      ok('G3 연결 말고 다른 칸(메모·채팅방)이 섞이면 403', memo.status === 403, 'status=' + memo.status);
      const memoOnly = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', chat_room_url: 'https://x' });
      ok('G4 연결 없이 다른 칸만 = 403', memoOnly.status === 403, 'status=' + memoOnly.status);
      const empty = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', linked_campaign_id: '' });
      ok('G5 빈 연결 = 403', empty.status === 403, 'status=' + empty.status);
      dbDown = true;
      let down;
      try { down = await hit('PUT', '/work-orders/update', T.outStaff, { id: 'wo-1', linked_campaign_id: 'camp-from-wo' }); }
      finally { dbDown = false; }
      ok('G6 ★ 공고 확인 조회가 실패하면 막는다(fail-closed)', down.status === 403, 'status=' + down.status);
      const adv = await hit('PUT', '/work-orders/update', T.adv, { id: 'wo-1', linked_campaign_id: 'camp-from-wo' });
      const none = await hit('PUT', '/work-orders/update', null, { id: 'wo-1', linked_campaign_id: 'camp-from-wo' });
      ok('G7 업체 403 · 무인증 401', adv.status === 403 && none.status === 401, adv.status + '/' + none.status);
      const inS = await hit('PUT', '/work-orders/update', T.inStaff, { id: 'wo-1', admin_memo: 'x' });
      ok('G8 명단 안 직원은 종전대로 모든 칸 통과', inS.status === 200, 'status=' + inS.status);
    }
  } finally { srv.close(); }

  /* ── H. 화면 — 공고 버튼은 공고 판정, 수동제출 버튼은 명단 판정 ───────── */
  console.log('\nH. 화면 판정 분리(vm 실행)');
  const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  const grab = (re, label) => { const m = WD.match(re); ok('H0 ' + label + ' 추출', !!m); return m ? m[0] : ''; };
  const fLoad = grab(/async function _loadCampPerm\(\)\{[\s\S]*?\n\}/, '_loadCampPerm');
  const fMo = grab(/function canOpenExternalManualOrder\(\)\{[\s\S]*?\n\}/, 'canOpenExternalManualOrder');
  const runPerm = async (role, resp) => {
    const ctx = { STATE: { role, campEdit: null, moEdit: null }, api: async () => resp };
    vm.createContext(ctx);
    vm.runInContext(fLoad + '\n' + fMo + '\nthis._loadCampPerm=_loadCampPerm;this.mo=canOpenExternalManualOrder;', ctx);
    const r = await ctx._loadCampPerm();
    return { r, campEdit: ctx.STATE.campEdit, mo: ctx.mo(), moEdit: ctx.STATE.moEdit };
  };
  if (fLoad && fMo) {
    const a = await runPerm('staff', { ok: true, canEdit: false, canEditCampaign: true });
    ok('H1 새 서버 · 명단 밖 staff: 공고 버튼 보임 · 수동제출 버튼 숨김', a.r === true && a.campEdit === true && a.mo === false, JSON.stringify(a));
    const b = await runPerm('admin', { ok: true, canEdit: false, canEditCampaign: true });
    ok('H2 새 서버 · 명단 밖 admin: 공고 보임 · 수동제출 숨김(결정 269 그대로)', b.campEdit === true && b.mo === false, JSON.stringify(b));
    const c = await runPerm('staff', { ok: true, canEdit: true, canEditCampaign: true });
    ok('H3 명단 안: 둘 다 보임', c.campEdit === true && c.mo === true, JSON.stringify(c));
    const d = await runPerm('staff', { ok: true, canEdit: false });
    ok('H4 ★ 옛 서버(canEditCampaign 없음): 종전 canEdit 그대로 = 숨김(눌러도 403 나는 버튼 금지)', d.campEdit === false && d.mo === false, JSON.stringify(d));
    const e = await runPerm('staff', { ok: true, canEdit: true });
    ok('H5 옛 서버 · 명단 안: 보임', e.campEdit === true && e.mo === true, JSON.stringify(e));
    const f = await runPerm('staff', null);
    ok('H6 판정 실패: 둘 다 숨김(fail-closed)', f.campEdit === false && f.mo === false, JSON.stringify(f));
  }
  ok('H7 모집공고 탭 머리말 [＋ 새 공고]·열람 전용 안내는 공고 판정(STATE.campEdit)을 따른다',
    /function _rcRenderHead\(total\)\{[\s\S]{0,400}\$\{STATE\.campEdit===true\?'<button class="btn pri" onclick="openRecruitModal\(\)">＋ 새 공고<\/button>'/.test(WD)
    && /\$\{STATE\.campEdit===true\?'':'<b style="color:var\(--muted\)">현재 계정은 열람 전용입니다\.<\/b>'\}/.test(WD));
  ok('H8 모집공고 탭은 머리말을 그리기 전에 공고 판정을 받아 둔다',
    /async function renderCampaignsView\(\)\{[\s\S]{0,700}await _loadCampPerm\(\);[\s\S]{0,400}_rcRenderHead\(0\);/.test(WD));
  ok('H9 명단을 바꾸면 수동제출 판정 캐시도 비운다',
    (WD.match(/STATE\.canEdit=null; STATE\.campEdit=null; STATE\.moEdit=null;/g) || []).length >= 2);
  ok('H10 초기 상태에 moEdit 칸(두 곳)', (WD.match(/campEdit:null,moEdit:null,/g) || []).length >= 2);

  console.log(`\n${pass} 통과 · ${fail} 실패`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
