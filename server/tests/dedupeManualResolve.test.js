/**
 * dedupeManualResolve.test.js — 회귀가드: ⚠중복 진단에서 그룹을 **사람이 직접** 정리 (2026-08-19)
 * 실행: node tests/dedupeManualResolve.test.js
 *
 * 왜 이 경로가 필요한가(사용자 신고): 자동 정리(`dedupeRows`)는 확신할 때만 잡는다 —
 * 주문 링크가 없거나·연결 주문이 취소됐거나·표 주문번호가 줄마다 다르면 **조회 대상에서조차 빠진다**.
 * 그런 그룹이 진단 창에 `정리 보류`·`주문 링크 없음` 으로 쌓였고 손댈 창구가 없어 표에 같은 사람이
 * 3~4줄로 남았다 — **그 표를 그대로 보는 광고주가 혼동했다**.
 *
 * 고정하는 것
 *  A. 게이트 — 무시트 탭만 · 남길/내릴 줄 검증 · 화면이 보낸 줄을 서버가 다시 조회(낡은 화면 차단)
 *  B. 돈이 걸린 fail-closed 3종 — 이체 완료(paid)는 어떤 확인으로도 불가 · 대기(pending)는 명시 확인 ·
 *     이체 담김을 **모르면 거부**(0 으로 꾸미지 않는다)
 *  C. 주문 취소는 **그 주문을 쓰는 활성 줄이 하나도 안 남을 때만**(그룹 밖의 줄까지 본다)
 *  D. 미리보기는 쓰기 0 · 순서 계약(작업표 soft-delete → 장부 재생성) · 쓰기 소유자(participants.service)
 *  E. 자동 판정을 완화하지 않는다 — `dedupeRows` 의 키를 여기서 다시 쓰지 않는다
 *  F. 라우트·화면 배선(게이트 1:1 · 미리보기 확인창 · onclick 은 숫자만)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const SVC = read('src/services/sheetlessLedger.service.js');
const ROUTES = read('src/routes/trackB.routes.js');
const HTML = fs.readFileSync(path.join(root, '..', 'frontend', 'workdesk.html'), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let pass = 0;
const ok = (n, c, extra) => { assert.ok(c, n + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + n); pass++; };

/* 서비스 본문만 잘라 본다(다른 함수의 SQL 이 섞이지 않게) */
function body() {
  const src = noLineComments(SVC);
  const i = src.indexOf('async function dedupeManual(');
  assert.ok(i > 0, 'dedupeManual 이 없다');
  const j = src.indexOf('\nasync function ', i + 10);
  return src.slice(i, j > 0 ? j : undefined);
}

/* ── 스텁 pool ────────────────────────────────────────────────────────
   tab_configs / campaign_participants(대상 조회) / payment_batch_items /
   campaign_participants(주문 사용 중 조회) 네 조회에만 답한다. */
function makePool({ tab = [{ sheetless: true }], roster = [], pay = [], payFail = false, inUse = [] }) {
  const sqls = [];
  return {
    sqls,
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      sqls.push({ q, params });
      if (/FROM tab_configs/.test(q)) return { rows: tab };
      if (/FROM payment_batch_items/.test(q)) {
        if (payFail) throw Object.assign(new Error('boom'), { code: '42P01' });
        return { rows: pay };
      }
      if (/SELECT DISTINCT order_submission_id/.test(q)) return { rows: inUse };
      if (/FROM campaign_participants/.test(q)) return { rows: roster };
      return { rows: [], rowCount: 0 };
    },
  };
}
function load(pool, { retired = 0 } = {}) {
  const stub = {};
  const put = (rel, exp) => {
    const p = require.resolve(path.join(root, 'src', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  };
  const poolPath = require.resolve(path.join(root, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  stub.retireCalls = []; stub.cancelCalls = [];
  put('services/participants.service', {
    retireRows: async (a) => { stub.retireCalls.push(a); stub.order = (stub.order || []).concat('retire'); return { retired }; },
  });
  put('services/orderLedger.service', {
    softDeleteDuplicateOrders: async (ids) => { stub.cancelCalls.push(ids); stub.order = (stub.order || []).concat('cancel'); return ids.length; },
  });
  const svcPath = require.resolve(path.join(root, 'src/services/sheetlessLedger.service'));
  delete require.cache[svcPath];
  stub.svc = require(svcPath);
  return stub;
}
const row = (o) => Object.assign({ name: '홍길동', phone8: '90411926', osid: null,
  submitted: false, paid: false, orderDeleted: false, ordnum: '' }, o);
async function code(fn) { try { await fn(); return null; } catch (e) { return e.code || e.message; } }

(async () => {
  console.log('\n[A] 게이트 — 무시트 탭만 · 줄 검증 · 서버가 다시 조회');
  {
    let s = load(makePool({}));
    ok('sheetId/tabName 필수', await code(() => s.svc.dedupeManual({})) === 'bad_request');
    ok('남길 줄을 안 고르면 거부',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', removeSeqs: [2] })) === 'bad_request');
    ok('★ 내릴 줄이 없으면 거부(조용히 아무것도 안 하지 않는다)',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [] })) === 'empty');
    ok('★ 남길 줄을 내릴 줄에 함께 담을 수 없다',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [1, 2] })) === 'keep_in_remove');

    s = load(makePool({ tab: [] }));
    ok('미등록 탭 거부',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2] })) === 'tab_not_registered');
    s = load(makePool({ tab: [{ sheetless: false }] }));
    ok('★★ 시트 기반 탭 거부 — 표에서만 내려도 다음 시트 반영이 되살린다',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2] })) === 'not_sheetless');

    s = load(makePool({ roster: [row({ seq: 1 })] }));      // 2번 줄이 없다(낡은 화면)
    ok('★★ 화면이 보낸 줄을 서버가 다시 조회한다 — 없으면 거부(낡은 화면 차단)',
      await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2] })) === 'row_not_found');
    ok('★ 거부 시 작업표 쓰기 0', s.retireCalls.length === 0);
  }

  console.log('\n[B] 돈이 걸린 fail-closed 3종');
  {
    const roster = [row({ seq: 1 }), row({ seq: 2 })];
    let s = load(makePool({ roster, pay: [{ seq: 2, status: 'paid' }] }));
    let c = await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], dryRun: false, ackPending: true }));
    ok('★★ 이체가 이미 나간 줄은 ackPending 으로도 못 내린다(송금 근거)', c === 'in_paid_batch');
    ok('★ 그때 작업표 쓰기 0', s.retireCalls.length === 0);

    s = load(makePool({ roster, pay: [{ seq: 2, status: 'pending' }] }));
    c = await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2] }));
    ok('★ 이체 대기 회차에 담긴 줄은 명시 확인 전까지 거부', c === 'in_pending_batch');
    s = load(makePool({ roster, pay: [{ seq: 2, status: 'pending' }] }), { retired: 1 });
    const r = await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], ackPending: true, dryRun: true });
    ok('★ 명시 확인이 있으면 진행하고 그 사실을 응답에 싣는다',
      r.ok === true && r.dryRun === true && Array.isArray(r.pendingSeqs) && r.pendingSeqs[0] === 2);

    s = load(makePool({ roster, payFail: true }));
    c = await code(() => s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], ackPending: true }));
    ok('★★ 이체 담김을 모르면 거부한다(0 으로 꾸미지 않는다)', c === 'payment_unknown');
    ok('★ 그때도 작업표 쓰기 0', s.retireCalls.length === 0);
  }

  console.log('\n[C] 주문 취소 범위 — 아무도 안 쓰는 주문만');
  {
    const roster = [row({ seq: 1, osid: 'o1' }), row({ seq: 2, osid: 'o2' })];
    let s = load(makePool({ roster }), { retired: 1 });
    let r = await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], dryRun: false });
    ok('★ 남는 줄이 안 쓰는 주문은 취소한다', s.cancelCalls[0].join() === 'o2' && r.canceledOrders === 1);

    s = load(makePool({ roster, inUse: [{ id: 'o2' }] }), { retired: 1 });
    r = await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], dryRun: false });
    ok('★★ 그룹 밖의 활성 줄이 쓰는 주문은 취소하지 않는다(살아남은 줄의 주문 보호)',
      s.cancelCalls[0].length === 0 && r.canceledOrders === 0);

    const shared = [row({ seq: 1, osid: 'o1' }), row({ seq: 2, osid: 'o1' })];
    s = load(makePool({ roster: shared, inUse: [{ id: 'o1' }] }), { retired: 1 });
    await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], dryRun: false });
    ok('★★ 같은 주문 기록을 공유하는 그룹에서 그 주문을 취소하지 않는다', s.cancelCalls[0].length === 0);

    s = load(makePool({ roster }), { retired: 1 });
    await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], cancelOrders: false, dryRun: false });
    ok('★ cancelOrders:false 면 주문을 건드리지 않는다', s.cancelCalls[0].length === 0);
  }

  console.log('\n[D] 미리보기 쓰기 0 · 순서 계약 · 쓰기 소유자');
  {
    const roster = [row({ seq: 1, submitted: true }), row({ seq: 2, paid: true })];
    let s = load(makePool({ roster }), { retired: 1 });
    const pv = await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2] });
    ok('★ dryRun 이 기본 — 값이 빠진 요청이 곧바로 실행되지 않는다', pv.dryRun === true);
    ok('★ 미리보기는 작업표·주문에 쓰지 않는다', s.retireCalls.length === 0 && s.cancelCalls.length === 0);
    ok('★ 미리보기가 남길/내릴 줄을 그대로 돌려준다',
      pv.keep.seq === 1 && pv.remove.length === 1 && pv.remove[0].seq === 2 && pv.removeRows === 1);
    ok('★★ 지울 줄에만 입금 표시가 있으면 사실로 말한다(막지는 않는다)', pv.losesPaid === true);

    s = load(makePool({ roster }), { retired: 1 });
    await s.svc.dedupeManual({ sheetId: 'S', tabName: 'T', keepSeq: 1, removeSeqs: [2], dryRun: false });
    ok('★ 실행은 서버가 고른 줄만 내린다', s.retireCalls[0].seqs.join() === '2' && s.retireCalls[0].dryRun === false);
    /* ★ 실행 순서는 런타임(첫 쓰기가 retire)과 **소스 순서**를 함께 본다 — rebuildLedgers 는
       같은 모듈의 렉시컬 호출이라 스텁으로 관측되지 않아 런타임만으로는 뒤집기를 못 잡는다. */
    ok('★★ 순서 계약 — 작업표 soft-delete 가 먼저(반대면 투영이 되살린다)',
      (s.order || []).indexOf('retire') === 0);
    {
      const blk0 = body();
      const iR = blk0.indexOf('.retireRows('), iL = blk0.indexOf('rebuildLedgers(');
      ok('★★ 소스에서도 retireRows → rebuildLedgers 순서', iR > 0 && iL > 0 && iR < iL);
    }

    const blk = body();
    ok('★★ 쓰기 소유자 — 이 함수는 campaign_participants 에 직접 쓰지 않는다',
      !/(INSERT INTO|UPDATE|DELETE FROM)\s+campaign_participants/i.test(blk));
    ok('★ 작업표 쓰기는 participants.service 에 위임', /participants\.service'\)[\s\S]{0,80}\.retireRows\(/.test(blk));
    ok('★ 장부 재생성으로 끝난다(표에서만 내려간 상태로 남기지 않는다)', /rebuildLedgers\(/.test(blk));
    ok('★ 하드삭제 없음 — DELETE FROM 0', !/DELETE FROM/i.test(blk));
  }

  console.log('\n[E] 자동 판정을 완화하지 않는다');
  {
    const blk = body();
    ok('★★ `dedupeRows` 의 그룹 키(표·원장 주문번호·연락처 3개 일치)를 여기서 다시 쓰지 않는다',
      !/byKeys|roword.*ordnum.*ph/i.test(blk));
    ok('★★ 무링크·취소된 주문 줄도 다룬다 — LEFT JOIN(자동 정리의 JOIN 과 다른 이유)',
      /LEFT JOIN order_submissions/.test(blk));
    ok('★ 진단 창은 여전히 자동 판정을 재작성하지 않는다(대조는 dryRun 호출)',
      /dryRun: true/.test(read('src/services/trackB.service.js')));
  }

  console.log('\n[F] 라우트·화면 배선');
  {
    const i0 = ROUTES.indexOf("router.post('/worktable/dedupe-manual'");
    ok('라우트가 등록돼 있다', i0 > 0);
    const rb = ROUTES.slice(i0, ROUTES.indexOf('\nrouter.', i0 + 10));
    ok('★★ 게이트 = adminOrMaster — 줄을 내리고 주문을 취소하는 조작(자동 정리와 같은 급)',
      /authMiddleware, adminOrMasterMiddleware/.test(rb));
    ok('★ 라우트도 dryRun 기본', /dryRun: b\.dryRun !== false/.test(rb));
    ok('★ ackPending 은 명시 true 일 때만(문자열 "true" 로 안 열린다)', /ackPending: b\.ackPending === true/.test(rb));
    ok('★ 검증 실패는 400대 — errorHandler 500 마스킹이면 무엇을 고칠지 모른다',
      /LedgerError\) return res\.status\(400\)/.test(rb));

    ok('★★ 화면 게이트 = 서버 게이트(master/admin) — 눌러도 403 나는 죽은 버튼 금지',
      /function _abCan\(\)\{ return STATE\.role === 'master' \|\| STATE\.role === 'admin'; \}/.test(HTML));
    ok('★ 그룹마다 남길 줄(라디오)·내릴 줄(체크)을 고른다',
      /onclick="abKeep\(\$\{i\},\$\{Number\(r\.seq\)\}\)"/.test(HTML)
      && /onclick="abRem\(\$\{i\},\$\{Number\(r\.seq\)\},this\.checked\)"/.test(HTML));
    ok('★★ onclick 에는 숫자만 — 시트에서 온 문자열을 넣지 않는다',
      !/onclick="ab(Keep|Rem|Resolve)\([^"]*(name|phone8|anchorValue)/.test(HTML));
    ok('★★ 미리보기 → 확인창 → 실행 2단계',
      /dryRun: true \}\)[\s\S]{0,2500}const okGo = confirm\(/.test(HTML)
      && /if \(!okGo\)[\s\S]{0,300}dryRun: false \}\)/.test(HTML));
    ok('★ 이체 대기 회차는 막다른 길이 아니다 — 사유를 보여주고 한 번 더 확인하면 진행',
      /code === 'in_pending_batch'/.test(HTML) && /abResolve\(i, true\)/.test(HTML));
    ok('★★ 돈이 걸린 줄은 기본으로 체크하지 않는다(사람이 명시로 켠다)',
      /!r\.paid && r\.inPayment !== true/.test(HTML));
    ok('★ 실행 뒤 목록을 다시 세고(숫자가 그대로면 오독) 닫을 때 작업보드를 갱신한다',
      /_AB\.dirty = true;/.test(HTML) && /if \(dirty\) \{ const i = STATE\.tabs\.indexOf\(STATE\.cur\)/.test(HTML));
    ok('★ 실패 사유는 서버 문장 그대로(프론트 재판정 0)',
      /p\.msg = \(pv && \(pv\.error \|\| pv\.message\)\)/.test(HTML));
    ok('★ 리터럴 NUL 금지(git 이 바이너리 취급 → grep 가드 무력화)',
      !SVC.includes(String.fromCharCode(0)) && !HTML.includes(String.fromCharCode(0)));
  }

  console.log('\n[G] 표 칸 수 — 조작 칸 2개를 끼워 넣어도 헤더 ≡ 행 (열을 더할 때 가장 흔히 깨지는 자리)');
  {
    const vm = require('vm');
    /* 렌더러만 꺼내 실제로 돌린다 — 정적 grep 으로는 칸 수 어긋남을 못 본다. */
    const i0 = HTML.indexOf('function _abKey(g)');
    const i1 = HTML.indexOf('function abMore()');
    const src = HTML.slice(i0, i1);
    const g = {
      seqs: [65, 274], rowCount: 2, anchorKind: 'order_link', reason: 'dedupe_skipped', detail: '보류 사유',
      rows: [{ seq: 65, name: '한우리', phone8: '68722225', rowOrderNum: '61018', ledgerOrderNum: '61020',
               submittedAt: null, hasOrder: true, orderDeleted: false, submitted: true, paid: false, inPayment: false },
             { seq: 274, name: '한우리', phone8: '68722225', rowOrderNum: '61020', ledgerOrderNum: '61020',
               submittedAt: null, hasOrder: true, orderDeleted: false, submitted: true, paid: true, inPayment: true }],
    };
    const run = (role) => {
      const sb = {
        STATE: { role }, esc: x => String(x == null ? '' : x).replace(/[&<>"]/g, c =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        _ddDay: () => '—', _AB_KIND: { order_link: '같은 주문 기록 공유' }, _AB_RLABEL: { dedupe_skipped: '정리 보류' },
        _abCan: () => role === 'admin' || role === 'master',
        _AB: { pick: {}, rep: { groups: [g] } }, api: async () => ({}), confirm: () => false, alert: () => {},
      };
      sb.window = sb; vm.createContext(sb); vm.runInContext(src, sb);
      return sb._abGroupHtml(g, 0);
    };
    for (const role of ['admin', 'staff']) {
      const html = run(role);
      const head = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
      const firstRow = (html.match(/<tbody>\s*<tr[^>]*>[\s\S]*?<\/tr>/) || [''])[0];
      const th = (head.match(/<th[\s>]/g) || []).length, td = (firstRow.match(/<td[\s>]/g) || []).length;
      ok(`★ 헤더 칸 수 ≡ 행 칸 수 (${role}: ${th})`, th > 0 && th === td);
    }
    const adminHtml = run('admin'), staffHtml = run('staff');
    ok('★★ admin 에게만 조작 칸이 붙는다(광고주·AE 화면 불변)',
      /type="radio"/.test(adminHtml) && !/type="radio"/.test(staffHtml) && !/abResolve/.test(staffHtml));
    ok('★ 기본 선택 = 가장 이른 줄 남김 · 이체 회차 줄은 미체크(돈이 걸린 줄은 사람이 켠다)',
      /name="abk0" checked/.test(adminHtml) && (adminHtml.match(/type="checkbox" checked/g) || []).length === 0);
    ok('★ 남길 줄은 내림 체크를 못 켠다(스스로를 지우지 않는다)', /type="checkbox"\s+disabled/.test(adminHtml));
  }

  console.log(`\n✅ dedupeManualResolve ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
