#!/usr/bin/env node
/**
 * inspect-diag.js — 리뷰검수 진단(읽기 전용).
 *
 * 왜 있는가: 운영 DB 는 Railway 컨테이너 안에서만 닿고(공개 포트가 임의의 높은 포트라
 * 외부 도구로 붙을 수 없다), 긴 SQL 을 웹 콘솔에 붙여넣으면 bracketed paste 마커가 섞여
 * 깨진다. 그래서 **짧게 부를 수 있는 한 줄**로 만들어 둔다.
 *
 *   node scripts/inspect-diag.js                 전체
 *   node scripts/inspect-diag.js "탭이름"        그 작업만
 *
 * ★★ 읽기 전용 — SELECT 만 한다(이 파일에 INSERT/UPDATE/DELETE 를 절대 추가하지 말 것).
 * ★★ 유형 판정은 `server/src/utils/inspectIssueTypes` **단일 출처**를 그대로 쓴다 —
 *    여기에 규칙을 베껴 쓰면 화면 칩과 진단 숫자가 갈린다(이 저장소의 반복된 사고).
 * ★ PII 를 뽑지 않는다 — 집계와 슬롯 등록 여부만 본다.
 */
const path = require('path');

// `| head` 로 잘라 볼 때 EPIPE 스택이 튀지 않게(콘솔 도구라 조용히 끝내는 게 맞다)
process.stdout.on('error', () => {});

function loadPg() {
  const tries = [
    'pg',
    path.join(__dirname, '..', 'server', 'node_modules', 'pg'),
    '/app/server/node_modules/pg',
    '/app/node_modules/pg',
  ];
  for (const p of tries) { try { return require(p); } catch (_) { /* 다음 후보 */ } }
  console.error('pg 모듈을 찾지 못했습니다. server/ 에서 실행하거나 npm i 후 다시 시도하세요.');
  process.exit(1);
}

const { issueTypeCountSql, ISSUE_KEYS } = require(path.join(__dirname, '..', 'server', 'src', 'utils', 'inspectIssueTypes'));

const LABEL = {
  format_fail: '📵 리뷰화면 아님', channel: '🔀 채널 다름', product: '🏷 상품명 다름',
  duplicate: '📄 같은 파일', similarity: '✍ 본문 겹침', author: '👤 작성자 표기',
};
const KIND_LABEL = {
  review: '리뷰 화면', receipt: '현금영수증', purchase_confirm: '구매확정 완료 화면',
  order_capture: '주문내역(구매캡처)', other: '그 외',
};
const SAMPLE_LABEL = {
  route_sample_order_capture: '🛒 구매캡처(주문내역)',
  route_sample_purchase_confirm: '✅ 구매확정 완료 (모바일)',
  route_sample_purchase_confirm_pc: '🖥️ 구매확정 완료 (PC)',
};

const n = (v) => Number(v || 0).toLocaleString('ko-KR');
const head = (s) => console.log('\n' + s + '\n' + '─'.repeat(46));

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL 이 없습니다. Railway 앱 컨테이너 안에서 실행하세요.'); process.exit(1); }
  const pg = loadPg();
  const c = new pg.Client({ connectionString: url });
  await c.connect();

  const tab = process.argv[2] || null;
  const where = tab ? 'AND i.tab_name = $1' : '';
  const args = tab ? [tab] : [];
  console.log(tab ? `대상 작업: ${tab}` : '대상: 전체 작업');

  /* ① 판별 예시 등록 현황 — 구매확정 판별 정확도의 핵심 재료 */
  head('① AI 판별 예시(자동 분류) 등록 현황');
  const s = await c.query(
    'SELECT key, COALESCE(length(value), 0) AS len FROM app_settings WHERE key LIKE $1', ['route_sample_%']);
  const got = new Map(s.rows.map(r => [r.key, Number(r.len)]));
  for (const k of Object.keys(SAMPLE_LABEL)) {
    const len = got.get(k);
    console.log(`  ${SAMPLE_LABEL[k].padEnd(24)} ${len ? '등록됨' : '미등록  ← 등록하면 판별 정확도가 오릅니다'}`);
  }

  /* ② 검수 상태 요약 */
  head('② 검수 상태');
  const sum = await c.query(
    `SELECT i.status, COUNT(*)::int AS c FROM review_inspections i WHERE TRUE ${where} GROUP BY i.status`, args);
  const m = {}; for (const r of sum.rows) m[r.status] = r.c;
  console.log(`  통과 ${n(m.pass)} · 의심 ${n(m.suspect)} · 불량 ${n(m.fail)} · 미검수 ${n(m.pending)} · 판정불가 ${n(m.unverifiable)} · 확인됨 ${n(m.resolved)}`);
  console.log(`  → 손볼 것(의심+불량) ${n((m.suspect || 0) + (m.fail || 0))}`);

  /* ③ 오류유형 분포 — 판정은 utils/inspectIssueTypes 단일 출처에서 파생 */
  head('③ 오류유형별 (의심+불량 기준 · 한 건이 여러 유형이면 중복 계수)');
  const t = await c.query(
    `SELECT COUNT(*)::int AS total, ${issueTypeCountSql('i.checks')}
       FROM review_inspections i WHERE i.status IN ('suspect','fail') ${where}`, args);
  const row = t.rows[0] || {};
  console.log(`  전체 ${n(row.total)}건`);
  for (const k of ISSUE_KEYS) console.log(`  ${LABEL[k].padEnd(20)} ${n(row[k])}`);

  /* ④ 불량 건이 무슨 화면으로 판별됐나 — 구매확정 작업 진단의 핵심 */
  head('④ 불량(리뷰화면 아님) 건의 AI 판별 종류');
  const k = await c.query(
    `SELECT COALESCE(i.checks->'format'->>'kind', '(없음)') AS kind, COUNT(*)::int AS c
       FROM review_inspections i
      WHERE i.status IN ('suspect','fail') AND i.checks->'format'->>'verdict' = 'fail' ${where}
      GROUP BY 1 ORDER BY 2 DESC`, args);
  if (!k.rows.length) console.log('  없음');
  for (const r of k.rows) console.log(`  ${(KIND_LABEL[r.kind] || r.kind).padEnd(24)} ${n(r.c)}`);

  /* ⑤ 리뷰타입이 구매확정인 작업 — 그 작업들이 지금 어떤 상태인지 */
  head('⑤ 리뷰타입 = 구매확정 인 작업의 검수 현황');
  let q = { rows: [] };
  try {
  q = await c.query(
    `SELECT i.tab_name,
            COUNT(*) FILTER (WHERE i.status IN ('suspect','fail'))::int AS open,
            COUNT(*) FILTER (WHERE i.checks->'format'->>'kind' = 'order_capture'
                               AND i.checks->'format'->>'verdict' = 'fail')::int AS as_order
       FROM review_inspections i
       JOIN tab_configs tc ON tc.sheet_id = i.sheet_id AND tc.tab_name = i.tab_name
       LEFT JOIN LATERAL (
            SELECT review_type FROM recruit_campaigns
             WHERE linked_sheet_id = tc.sheet_id
               AND (linked_tab_name = tc.tab_name
                    OR (COALESCE(tc.tab_gid,'') <> '' AND linked_tab_gid = tc.tab_gid))
               AND COALESCE(review_type,'') <> ''
             ORDER BY created_at DESC LIMIT 1
       ) rt ON TRUE
      WHERE COALESCE(rt.review_type, tc.review_type) = 'confirm' ${where}
      GROUP BY i.tab_name HAVING COUNT(*) FILTER (WHERE i.status IN ('suspect','fail')) > 0
      ORDER BY 2 DESC LIMIT 20`, args);
  } catch (e) {
    // ★ fail-soft — 이 절이 실패해도 위 ①~④ 는 이미 출력됐다(진단이 통째로 죽지 않게)
    console.log('  조회 실패:', e.message);
  }
  if (!q.rows.length) console.log('  해당 없음');
  for (const r of q.rows) {
    console.log(`  ${String(r.tab_name).slice(0, 34).padEnd(36)} 손볼 것 ${n(r.open).padStart(5)}  그중 주문내역 판별 ${n(r.as_order)}`);
  }
  if (q.rows.length) {
    console.log('\n  ※ "주문내역 판별"이 크면 → 위 ①의 구매확정 예시를 등록하고 [♻ 재검수]');
  }

  await c.end();
  console.log('');
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
