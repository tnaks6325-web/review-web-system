/**
 * worktableOptionColumn.test.js — 회귀가드: 작업표 옵션 열 (2026-08-20 실사고)
 * 실행: node tests/worktableOptionColumn.test.js
 *
 * 사고(「8/20(네이버)선물세트 3종 빈박스」): 리뷰어가 참여할 때 옵션 3종 중 하나를 골랐고
 *   그 값은 `campaign_applications.option_key` → `order_submissions.selected_opt_key` 까지
 *   정상 저장됐는데, **작업표에 옵션 칸이 없어** 아무 데도 기입되지 않았다(경고·로그 0).
 *   원인 = 작업표 열 구성은 **작업오더의 옵션만** 보고 `campaign_options` 는 참조하지 않는다.
 *
 * 고정하는 것:
 *  A. 판정 사본 0 — 옵션 칸 판정은 매퍼 파생(`optionWriteColumns`), 리뷰옵션 제외
 *  B. 소급 기입 값도 **매퍼가 정한다**(`|` 다중 옵션까지 앞으로의 쓰기와 같다)
 *  C. 게이트 fail-closed(무시트 탭 전용) · dryRun 은 쓰기 0
 *  D. blank-only — 값이 있는 칸은 덮지 않는다
 *  E. 작업표 생성(worktablePlan)도 옵션 칸을 **자동으로 덧붙인다**(리뷰옵션과 대칭)
 *  F. 공고 저장이 연결 작업표의 옵션 칸을 보장한다(실행부는 서비스 한 벌 · fail-soft)
 *  G. 기입할 칸이 없으면 **소리 내어 알린다**(조용한 누락 차단)
 *  H. 라우터 스택 실검사 — adminOrMaster · confirm 없으면 미리보기
 *  I. 화면 배선 — [⋯] 메뉴 · body 직속 · onclick 인자 없음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const SVC = require('../src/services/worktableOptionColumn.service');

/* ── A. 판정 사본 0 ─────────────────────────────────────────────────────── */
console.log('\n[A] 옵션 칸 판정 — 매퍼 파생 · 리뷰옵션 제외');
{
  ok('옵션 칸이 있으면 찾는다', SVC.productOptionColumns(['번호', '옵션', '수취인']).length === 1);
  ok('★ 옵션금액(=결제금액)을 옵션 칸으로 오분류하지 않는다',
    SVC.productOptionColumns(['번호', '옵션금액', '수취인']).length === 0);
  ok('★ 리뷰옵션(작업옵션=리뷰형태)은 상품옵션 기입처가 아니다',
    SVC.productOptionColumns(['번호', '리뷰옵션', '수취인']).length === 0);
  ok('리뷰옵션만 있으면 옵션 칸을 새로 만든다',
    SVC.withOptionColumn(['번호', '리뷰옵션', '수취인']).added === true);
  ok('이미 옵션 칸이 있으면 만들지 않는다', SVC.withOptionColumn(['번호', '옵션']).added === false);
  ok('만들지 않을 때 헤더가 그대로다',
    SVC.withOptionColumn(['번호', '옵션']).headers.join('|') === '번호|옵션');
}

console.log('\n[A2] 자리 — 자동 열(번호·구매일자) 바로 뒤');
{
  const r = SVC.withOptionColumn(['번호', '구매일자', '수취인', '연락처', '주소']);
  ok('옵션 칸이 3번째(자동 열 뒤)에 들어간다', r.headers[2] === '옵션', r.headers.join('|'));
  ok('기존 열 순서는 그대로', r.headers.join('|') === '번호|구매일자|옵션|수취인|연락처|주소');
}

/* ── B. 소급 값 = 매퍼 ───────────────────────────────────────────────────── */
console.log('\n[B] 소급 기입 값 — 매퍼가 정한다');
{
  const h = SVC.withOptionColumn(['번호', '구매일자', '수취인']).headers;
  const m = SVC.optionCellValues(h, '3.정성 500갈치 1호');
  ok('옵션 칸에 그 값이 들어간다', m.get('옵션') === '3.정성 500갈치 1호');
  const m2 = SVC.optionCellValues(['옵션1', '옵션2'], '블랙|유선');
  ok('★ 다중 옵션은 매퍼 규칙대로 칸마다 나뉜다', m2.get('옵션1') === '블랙' && m2.get('옵션2') === '유선');
  ok('빈 선택은 아무 칸도 채우지 않는다', SVC.optionCellValues(['옵션'], '').size === 0);
}

/* ── C·D. 서비스 실제 실행 ──────────────────────────────────────────────── */
function makePool({ sheetless = true, registered = true, headers = ['번호', '구매일자', '수취인'], parts = [], orders = [] } = {}) {
  const seen = [];
  const client = {
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      seen.push({ q, params });
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    seen.push({ q, params });
    if (/FROM tab_configs/.test(q)) return { rows: registered ? [{ tab_gid: '1', sheetless }] : [] };
    if (/FROM raw_sheet_tabs/.test(q)) return { rows: [{ detected_headers: headers, headers }] };
    if (/FROM campaign_participants/.test(q)) return { rows: parts };
    if (/FROM order_submissions/.test(q)) return { rows: orders };
    return { rows: [] };
  };
  return { seen, query, connect: async () => client };
}
const OID = '11111111-1111-1111-1111-111111111111';

console.log('\n[C] 게이트 · 미리보기');
(async () => {
  {
    const p = makePool({ sheetless: false });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureOptionColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('★ 시트 기반 탭은 거부(fail-closed)', err && err.code === 'not_sheetless');
    ok('거부 시 쓰기 0', !p.seen.some(s => /UPDATE|INSERT|DELETE/i.test(s.q)));
  }
  {
    const p = makePool({ registered: false });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureOptionColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('미등록 탭은 거부', err && err.code === 'tab_not_registered');
  }
  {
    const p = makePool({
      parts: [{ seq: 2, row_json: { 번호: '1' }, order_submission_id: OID }],
      orders: [{ id: OID, selected_opt_key: '2.갈옥 순살 듀오세트' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureOptionColumn({ sheetId: 's', tabName: 't' });
    ok('★ 기본이 미리보기(dryRun)', r.dryRun === true);
    ok('미리보기는 쓰기 0', !p.seen.some(s => /UPDATE |INSERT |DELETE /i.test(s.q)));
    ok('옵션 칸을 만든다고 말한다', r.headerAdded === true && r.headerName === '옵션');
    ok('소급 대상 1줄', r.backfillCount === 1 && r.rows[0].seq === 2);
  }

  console.log('\n[D] blank-only · 링크 없는 줄');
  {
    const p = makePool({
      headers: ['번호', '옵션', '수취인'],
      parts: [
        { seq: 2, row_json: { 옵션: '포토리뷰' }, order_submission_id: OID },   // 관리자 작업지시
        { seq: 3, row_json: {}, order_submission_id: null },                    // 링크 없음
      ],
      orders: [{ id: OID, selected_opt_key: '1.갈고 순살듀오 세트' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureOptionColumn({ sheetId: 's', tabName: 't' });
    ok('이미 칸이 있으면 만들지 않는다', r.headerAdded === false && r.alreadyHadColumn === true);
    ok('★ 값이 있는 칸은 덮지 않는다(blank-only)', r.backfillCount === 0 && r.skippedAlreadyFilled === 1);
    ok('선택 기록 없는 줄은 건너뛴다', r.skippedNoOrderOption === 1);
  }
  {
    // 실행(confirm) — 쓰기 표면이 헤더 + row_json 두 곳뿐인지
    const p = makePool({
      parts: [{ seq: 2, row_json: {}, order_submission_id: OID }],
      orders: [{ id: OID, selected_opt_key: '3.정성 500갈치 1호' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureOptionColumn({ sheetId: 's', tabName: 't', dryRun: false }).catch(e => ({ err: e }));
    const writes = p.seen.filter(s => /UPDATE |INSERT |DELETE /i.test(s.q));
    ok('★ UPDATE 대상은 raw_sheet_tabs · campaign_participants 뿐',
      writes.length > 0 && writes.every(w => /raw_sheet_tabs|campaign_participants/.test(w.q)),
      writes.map(w => w.q.slice(0, 60)).join(' | '));
    ok('★ 주문 원장·정원·홀드는 무접촉',
      !writes.some(w => /order_submissions|recruit_campaigns|campaign_applications/.test(w.q)));
    ok('실행 결과가 소급 줄 수를 말한다', r && (r.backfillCount === 1 || r.err));
  }

  /* ── E. 작업표 생성 자동 추가 ─────────────────────────────────────────── */
  console.log('\n[E] 작업표 생성 — 옵션 칸 자동 추가(리뷰옵션과 대칭)');
  {
    const { buildWorktablePlan } = require('../src/utils/worktablePlan');
    const wo = {
      recruit_count: 4, daily_count: 4, start_date: '2026-08-20',
      product_options_json: JSON.stringify([{ name: 'p', options: [{ label: 'A' }, { label: 'B' }] }]),
    };
    const tpl = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액'], channels: {}, workTypes: [] };
    const plan = buildWorktablePlan({ workOrder: wo, template: tpl });
    const optCols = plan.columns.filter(c => c.role === 'option');
    ok('★ 템플릿에 옵션 칸이 없어도 자동으로 생긴다', optCols.length === 1, plan.columns.map(c => c.name).join('|'));
    ok('시스템이 만든 칸이라고 표시한다', optCols[0].origin === 'system');
    ok('자리는 자동 열 뒤', plan.columns[2].role === 'option', plan.columns.map(c => c.name).join('|'));
    ok('★ 조용히 추가하지 않는다 — 사실을 알린다',
      plan.warnings.some(w => w.code === 'option_column_added'));
    ok('★ 옛 경고(칸 없어 기입 안 됨)는 더 이상 나오지 않는다',
      !plan.warnings.some(w => w.code === 'no_option_column'));
    const rows = plan.rows.filter(r => r.optionKey);
    ok('행 배분은 그대로', rows.length === 4);
  }
  {
    const { buildWorktablePlan } = require('../src/utils/worktablePlan');
    const tpl = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액'], channels: {}, workTypes: [] };
    const plan = buildWorktablePlan({ workOrder: { recruit_count: 3, daily_count: 3 }, template: tpl });
    ok('★ 옵션이 없는 작업은 옵션 칸을 만들지 않는다(무회귀)',
      !plan.columns.some(c => c.role === 'option'), plan.columns.map(c => c.name).join('|'));
  }

  /* ── F. 공고 저장 배선 ────────────────────────────────────────────────── */
  console.log('\n[F] 공고 저장 — 연결 작업표 옵션 칸 보장(fail-soft · 실행부 한 벌)');
  {
    const src = read('src/routes/campaign.routes.js');
    ok('헬퍼가 있다', /_ensureLinkedWorktableOptionColumn/.test(src));
    ok('★ 실행부는 서비스 한 벌(헤더를 여기서 직접 만지지 않는다)',
      /require\('\.\.\/services\/worktableOptionColumn\.service'\)/.test(src)
      && !/detected_headers/.test(src));
    const i = src.indexOf('async function _ensureLinkedWorktableOptionColumn');
    const body = src.slice(i, src.indexOf('\n}', i));
    ok('★ 옵션 2종 이상일 때만', /liveOpts[^\n]*<\s*2/.test(body));
    ok('★ 절대 throw 하지 않는다(공고 저장을 죽이지 않는다)', /catch \(e\) \{/.test(body) && !/throw/.test(body));
    ok('닫힌 옵션은 세지 않는다', /<> 'closed'/.test(body));
    const calls = src.match(/_ensureLinkedWorktableOptionColumn\((?!campaignId)/g) || [];
    ok('create·update 두 곳에서 부른다', calls.length === 2, String(calls.length));
  }

  /* ── G. 조용한 누락 차단 ─────────────────────────────────────────────── */
  console.log('\n[G] 기입할 칸이 없으면 소리 내어 알린다');
  {
    const SO = require('../src/services/sheetlessOrder.service');
    const noCol = SO.buildRowPatch(['번호', '수취인'], { recipient: 'x', selectedOptKey: 'A' }, {});
    ok('★ 옵션 칸이 없으면 신호를 남긴다', noCol.optionUnmapped === 'A');
    const withCol = SO.buildRowPatch(['번호', '옵션', '수취인'], { recipient: 'x', selectedOptKey: 'A' }, {});
    ok('칸이 있으면 신호 없음', !withCol.optionUnmapped && withCol.patch['옵션'] === 'A');
    const kept = SO.buildRowPatch(['번호', '옵션'], { selectedOptKey: 'A' }, { 옵션: '포토리뷰' });
    ok('★ 보존(blank-only)과는 다른 신호다', !kept.optionUnmapped && kept.optionSuppressed.length === 1);
    const none = SO.buildRowPatch(['번호', '수취인'], { recipient: 'x', selectedOptKey: '' }, {});
    ok('선택이 없으면 무음', !none.optionUnmapped);
    const src = read('src/services/sheetlessOrder.service.js');
    ok('logAbnormal(warn) 로 관측한다', /option_column_missing/.test(src) && /severity: 'warn'/.test(src));
    ok('★ reviewer_event_logs 를 쓰지 않는다(도배 방지)', !/reviewer_event_logs/.test(src));
  }

  /* ── H. 라우터 ───────────────────────────────────────────────────────── */
  console.log('\n[H] 라우터 스택 실검사');
  {
    const router = require('../src/routes/trackB.routes');
    const layer = (router.stack || []).find(l => l.route && l.route.path === '/worktable/option-column');
    ok('등록돼 있다', !!layer && !!layer.route.methods.post);
    const names = layer.route.stack.map(s => s.name);
    ok('authMiddleware 를 먼저 탄다', names[0] === 'authMiddleware', names.join(','));
    ok('★ adminOrMaster 게이트', names.some(n => /adminOrMaster/i.test(n)), names.join(','));
    const src = read('src/routes/trackB.routes.js');
    const i = src.indexOf("router.post('/worktable/option-column'");
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    ok('★ confirm:true 가 아니면 미리보기', /dryRun: b\.confirm !== true/.test(body));
    ok('판정 사본 0 — 서비스를 그대로 부른다', /ensureOptionColumn\(\{/.test(body));
  }

  /* ── I. 화면 ─────────────────────────────────────────────────────────── */
  console.log('\n[I] 화면 배선');
  {
    const h = read('../frontend/workdesk.html');
    ok('[⋯] 메뉴에 [🧩 옵션 열] 이 있다', /onclick="openOptColModal\(\)"/.test(h));
    ok('메뉴 노출 조건에 합류했다', /_rnCanRenumber\(\)\|\|_ocCan\(\)/.test(h));
    ok('★ 서버 게이트와 1:1(adminOrMaster)', /function _ocCan\(\)\{[\s\S]{0,220}role === 'master'[\s\S]{0,60}'admin'/.test(h));
    ok('★ 무시트 탭에서만', /function _ocCan\(\)\{[\s\S]{0,160}sheetless === true/.test(h));
    ok('★ 팝업은 body 직속', /ocOv[\s\S]{0,400}document\.body\.appendChild\(ov\)/.test(h));
    ok('★ Esc 리스너는 최상위 1회', /window\._ocKeyBound/.test(h));
    ok('실행은 confirm 경유', /function ocRun\(\)[\s\S]{0,900}if \(!confirm\(/.test(h));
    ok('★ 실행 요청에만 confirm:true', /ocRun[\s\S]{0,1200}confirm: true/.test(h));
    ok('onclick 에 시트발 문자열 보간 없음', !/openOptColModal\('/.test(h));
  }

  console.log(`\n✅ worktableOptionColumn — ${passed} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
