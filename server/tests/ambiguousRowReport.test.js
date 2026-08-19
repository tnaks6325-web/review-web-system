/**
 * ⚠중복(앵커 겹침) 진단 회귀가드 — 2026-08-19
 *
 * 왜 이 창이 필요한가(사고가 아니라 구조적 눈속임):
 *   그리드 배지 `중복 줄 N`(= 앵커 겹침으로 **수정 오버레이를 적용하지 못한** 줄)과
 *   ♻ 중복 줄 정리(`dedupeRows`)는 **보는 집합도 판정 키도 다르다**.
 *     · 배지 = 앵커(order_submission_id → identity_key) 겹침 · **주문 링크 없는 줄도 포함**
 *     · 정리 = JOIN order_submissions(링크된 줄만) + 표/원장 주문번호·연락처 3개 일치
 *   그래서 "중복 줄 116 · 정리 대상 0"(2026-08-19 장수산업 실측)이 **정상적으로** 나온다.
 *   그 116줄의 실체를 볼 창구가 없으면 담당자가 원인을 엉뚱한 데서 찾는다.
 *
 * 이 가드가 고정하는 것
 *   1. 겹침 판정 사본 0 — 그리드가 쓰는 `_deriveAnchor` 를 그대로 쓴다(배지 숫자 ≡ 진단 숫자).
 *   2. "정리 도구가 잡는가" 는 `dedupeRows({dryRun:true})` 를 **실제로 불러** 대조한다(조건 재작성 금지).
 *   3. 읽기 전용 — 쓰기 SQL 0.
 *   4. 모르는 것을 0 으로 꾸미지 않는다(이체 담김 조회 실패 = payUnavailable · inPayment null).
 *   5. dedupe 대조 실패해도 진단은 나온다(fail-soft) + 사유를 싣는다.
 *   6. 게이트 = adminOrMaster, 화면 버튼도 같은 조건(눌러도 403 나는 죽은 버튼 금지).
 *   7. 로딩 자리표시자를 깐 창은 어떤 예외에도 화면을 종결시킨다(무한 '불러오는 중' 금지).
 *
 * 실행: node tests/ambiguousRowReport.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = p => fs.readFileSync(path.join(root, 'src', p), 'utf8');
const SVC = SRC('services/trackB.service.js');
const ROUTES = SRC('routes/trackB.routes.js');
const HTML = fs.readFileSync(path.join(root, '..', 'frontend', 'workdesk.html'), 'utf8');
const NUL = String.fromCharCode(0);   // ★ 소스에 리터럴 NUL 을 넣으면 이 파일까지 바이너리가 된다

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

// 서비스 본문만 잘라 검사(다른 함수의 SQL 이 섞이지 않게)
function body() {
  const i = SVC.indexOf('async function ambiguousRowReport(');
  assert.ok(i > 0, 'ambiguousRowReport 가 없다');
  const j = SVC.indexOf('\n}\n', i);
  return SVC.slice(i, j);
}

/* ── 스텁 pool ────────────────────────────────────────────────────────
   roster / order_submissions / payment_batch_items 세 조회에만 답한다. */
function makePool({ roster, orders = [], pay = [], payFail = false }) {
  const sqls = [];
  return {
    sqls,
    query: async (sql) => {
      const q = String(sql);
      sqls.push(q);
      if (/FROM campaign_participants/.test(q)) return { rows: roster };
      if (/FROM order_submissions/.test(q)) return { rows: orders };
      if (/FROM payment_batch_items/.test(q)) {
        if (payFail) throw Object.assign(new Error('boom'), { code: '42P01' });
        return { rows: pay };
      }
      return { rows: [] };
    },
  };
}
function loadSvc(pool) {
  const poolPath = require.resolve(path.join(root, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const svcPath = require.resolve(path.join(root, 'src/services/trackB.service'));
  delete require.cache[svcPath];
  return require(svcPath);
}
const row = (o) => Object.assign({
  id: 'r' + o.seq, name: '홍길동', recipient: '홍길동', phone8: '90411926',
  option: '', source: 'import', order_submission_id: null, identity_key: null,
  row_json: {}, submitted: false, paid: false,
}, o);

(async () => {
  console.log('\n[A] 겹침 세기 — 배지와 같은 값 (판정 사본 0)');
  {
    // 주문 링크 없는 두 줄이 표 주문번호(num:)로 겹침 + 안 겹치는 줄 1개 + manual 2개
    const pool = makePool({
      roster: [
        row({ seq: 1, row_json: { 주문번호: '1102364660866' } }),
        row({ seq: 2, row_json: { 주문번호: '1102364660866' } }),
        row({ seq: 3, row_json: { 주문번호: '9999999999999' } }),
        row({ seq: 4, source: 'manual', row_json: {} }),
        row({ seq: 5, source: 'manual', row_json: {} }),
      ],
    });
    const svc = loadSvc(pool);
    const r = await svc.ambiguousRowReport({ sheetId: 'wt_x', tabName: 'T' });
    ok('겹친 줄만 센다(안 겹치는 줄 제외)', r.ambiguousRows === 2 && r.groupCount === 1);
    ok('★ manual 앵커는 물리행 id 라 구조적으로 유일 — 겹침에서 제외', !r.groups.some(g => g.seqs.includes(4)));
    ok('앵커 종류를 말한다(무엇 때문에 겹쳤나)', r.groups[0].anchorKind === 'row_order_num');
    ok('★ 주문 링크 없는 그룹은 정리 도구 대상 밖이라고 사유를 말한다',
      r.groups[0].reason === 'no_order_link' && /연결된 줄만/.test(r.groups[0].detail));
    ok('★ 읽기 전용 — 쓰기 SQL 0',
      !pool.sqls.some(q => /\b(INSERT|UPDATE|DELETE)\b/i.test(q)));
  }

  console.log('\n[B] 정리 도구와 대조 — 조건 재작성이 아니라 실제 호출');
  {
    const pool = makePool({
      roster: [
        row({ seq: 10, order_submission_id: 'os-a', row_json: { 주문번호: '111111111' } }),
        row({ seq: 11, order_submission_id: 'os-a', row_json: { 주문번호: '111111111' } }),
      ],
      orders: [
        { id: 'os-a', order_num: '111111111', phone: '010-9041-1926', submitted_at: '2026-08-18T05:00:00Z' },
      ],
    });
    const svc = loadSvc(pool);
    const calls = [];
    const r = await svc.ambiguousRowReport({
      sheetId: 'wt_x', tabName: 'T',
      dedupeFn: async (a) => { calls.push(a); return { plan: [{ keepSeq: 10, removeSeqs: [11] }], skipped: [] }; },
    });
    ok('★ dedupeRows 를 실제로 부른다(사본 금지)', calls.length === 1);
    ok('★★ 대조도 읽기 전용 — dryRun 으로만 부른다', calls[0].dryRun === true);
    ok('정리 도구가 잡는 그룹은 그렇게 말한다', r.groups[0].reason === 'dedupe_target');
  }
  {
    const pool = makePool({
      roster: [
        row({ seq: 20, order_submission_id: 'os-a', row_json: { 주문번호: '111111111' } }),
        row({ seq: 21, order_submission_id: 'os-a', row_json: { 주문번호: '111111111' } }),
      ],
      orders: [{ id: 'os-a', order_num: '111111111', phone: '010-9041-1926' }],
    });
    const svc = loadSvc(pool);
    const r = await svc.ambiguousRowReport({
      sheetId: 'wt_x', tabName: 'T',
      dedupeFn: async () => ({ plan: [], skipped: [{ seqs: [20, 21], reason: 'in_payment_batch' }] }),
    });
    ok('정리 도구가 보류한 그룹도 구분해 말한다', r.groups[0].reason === 'dedupe_skipped');
  }
  {
    // 같은 주문 id 를 두 줄이 쓰는데 표 주문번호가 어긋난 상태(신다인 계열)
    const pool = makePool({
      roster: [
        row({ seq: 30, order_submission_id: 'os-a', row_json: { 주문번호: '111111111' } }),
        row({ seq: 31, order_submission_id: 'os-a', row_json: { 주문번호: '222222222' } }),
      ],
      orders: [{ id: 'os-a', order_num: '111111111', phone: '010-9041-1926' }],
    });
    const svc = loadSvc(pool);
    const r = await svc.ambiguousRowReport({
      sheetId: 'wt_x', tabName: 'T', dedupeFn: async () => ({ plan: [], skipped: [] }),
    });
    ok('★ 같은 주문 링크를 여러 줄이 쓰는 경우를 앵커 종류로 드러낸다', r.groups[0].anchorKind === 'order_link');
    ok('★ 표 주문번호가 어긋나 정리 대상이 안 되는 사유를 말한다',
      r.groups[0].reason === 'row_order_num_differs');
    ok('표/원장 주문번호를 나란히 실어 사람이 눈으로 대조할 수 있다',
      r.groups[0].rows[0].rowOrderNum === '111111111' && r.groups[0].rows[1].rowOrderNum === '222222222'
      && r.groups[0].rows.every(x => x.ledgerOrderNum === '111111111'));
  }

  console.log('\n[C] 모르는 것을 0 으로 꾸미지 않는다 · fail-soft');
  {
    const pool = makePool({
      roster: [
        row({ seq: 40, row_json: { 주문번호: '333333333' } }),
        row({ seq: 41, row_json: { 주문번호: '333333333' } }),
      ],
      payFail: true,
    });
    const svc = loadSvc(pool);
    const r = await svc.ambiguousRowReport({
      sheetId: 'wt_x', tabName: 'T',
      dedupeFn: async () => { throw Object.assign(new Error('시트 기반 탭입니다'), { code: 'not_sheetless' }); },
    });
    ok('★ 이체 담김 여부를 못 읽으면 그렇게 말한다(0 위장 금지)',
      r.payUnavailable === true && r.groups[0].rows.every(x => x.inPayment === null)
      && r.groups[0].inPaymentCount === null);
    ok('★ dedupe 대조가 실패해도 진단은 나오고 사유를 싣는다',
      r.ok === true && r.groupCount === 1 && /시트 기반/.test(r.dedupeError));
    ok('대조가 없으면 관측한 사실로 사유를 말한다', r.groups[0].reason === 'no_order_link');
  }

  console.log('\n[D] 라우트 (라우터 스택 실검사)');
  {
    const tb = require('../src/routes/trackB.routes');
    const layers = tb.stack.filter(l => l.route && l.route.path === '/worktable/ambiguous-rows')
      .map(l => ({ m: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
    ok('GET 한 창구로 등록', layers.length === 1 && layers[0].m.includes('get'));
    ok('★ authMiddleware 뒤 — 무인증 도달 불가', layers[0].mw.includes('authMiddleware'));
    ok('★★ adminOrMaster — 이름·연락처·주문번호가 실린다(정리 도구와 같은 급)',
      layers[0].mw.includes('adminOrMasterMiddleware'));
    const i = ROUTES.indexOf("router.get('/worktable/ambiguous-rows'");
    const seg = ROUTES.slice(i, ROUTES.indexOf('\nrouter.', i + 10));
    ok('스키마 미적용은 not_ready 로 말한다(500 마스킹 금지)', /not_ready/.test(seg));
  }

  console.log('\n[E] 판정 사본 0 · 소스 위생');
  {
    const b = body();
    ok('★★ 겹침은 그리드와 같은 `_deriveAnchor` 로 센다(사본 금지)',
      /_deriveAnchor\(r\)/.test(b) && /_akey\(/.test(b));
    ok('★★ 정리 도구의 그룹 키 SQL 을 여기서 다시 쓰지 않는다',
      !/JOIN order_submissions os2/.test(b) && !/jsonb_each_text/.test(b));
    ok('그리드와 같은 명단 조건(활성·미삭제) — 배지 숫자와 갈리지 않는다',
      /deleted_at IS NULL AND active = TRUE/.test(b));
    ok('★ 리터럴 NUL 금지(git 이 바이너리 취급 → grep 가드 무력화)',
      !SVC.includes(NUL) && !HTML.includes(NUL));
  }

  console.log('\n[F] 화면 배선');
  {
    ok('배지에 진단 창구가 붙었다', /onclick="openAmbiguousModal\(\)"/.test(HTML));
    ok('★★ 화면 게이트 = 서버 게이트(master/admin) — 죽은 버튼 금지',
      /function _abCan\(\)\{ return STATE\.role === 'master' \|\| STATE\.role === 'admin'; \}/.test(HTML)
      && /const ambCan = _abCan\(\);/.test(HTML));
    ok('★ 오버레이는 body 직속(뷰 스크롤 컨테이너에 넣지 않는다)',
      /ov\.id = 'abOv';[\s\S]{0,600}document\.body\.appendChild\(ov\)/.test(HTML));
    ok('★ Esc 리스너는 최상위 1회', /window\._abKeyBound/.test(HTML));
    ok('★★ 조회 실패도 화면을 종결시킨다(무한 로딩 금지)',
      /_AB\.busy = false; _AB\.err = '조회 실패/.test(HTML) && /다시 시도/.test(HTML));
    ok('★ 화면은 서버 사유를 그대로 그린다(프론트 재판정 0)',
      /esc\(g\.detail \|\| g\.reason/.test(HTML));
    ok('★ 읽기 전용 — 이 창에 실행 버튼이 없다',
      !/id="abOv"[\s\S]{0,900}정리 실행/.test(HTML));
  }

  console.log(`\n✅ ambiguousRowReport ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
