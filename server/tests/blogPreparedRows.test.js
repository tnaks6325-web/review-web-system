/**
 * 블로그체험단 M2 회귀가드 — 준비 행 기준 분기 + URL 열 하이재킹 차단
 *
 * 이 가드가 고정하는 것
 *   1. **블로그 준비 행 = 값이 하나라도 있는 행**(구매일자 무관). 날짜 기준으로 세면 준비 행이
 *      통째로 0이 되어 **무음 누락**된다 — (주)바를참스킨 0804 사고가 정확히 이것.
 *   2. 총원(연결 작업오더 recruit_count)이 있으면 **앞에서부터 그 수까지만**. 총원이 시트 실체 행보다
 *      많아도 **자리를 지어내지 않는다**(seq 는 시트 실제 행 번호여야 한다) — 대신 shortOfTotal 고지.
 *   3. 판정 실패·미등록 탭은 **종전 동작(날짜 기준)** — 모른다고 블로그로 단정하면 리뷰 작업의
 *      준비 행 기준이 통째로 바뀐다(오탐이 훨씬 비싸다).
 *   4. 분기는 `readPreparedRows` **한 곳** — 호출부 4곳이 전부 `tabName` 을 넘긴다(안 넘기면
 *      종류를 판정할 수 없어 블로그 탭이 조용히 날짜 기준으로 떨어진다).
 *   5. **블로그URL·포스팅URL 이 상품URL 을 하이재킹하지 않는다** — urlKeywords 는 'url' 부분일치 +
 *      첫 매칭 승이라, 그 열이 왼쪽에 있으면 review_index.product_url 이 통째로 블로그 주소가 된다.
 *   6. 사본 금지: 공고 LATERAL(gid 폴백·값 있는 최신 공고) = utils/campaignTabLateral ·
 *      작업오더 링크 우선순위(ORDER BY link_rank) = utils/workOrderLink — 두 소비처가 같은 것을 쓴다.
 *
 * 실행: node tests/blogPreparedRows.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SLOT = R('src/services/sheetSlotSync.service.js');
const CUT = R('src/services/sheetlessCutover.service.js');
const RES = R('src/services/columnResolver.js');
const WKC = R('src/services/workKindContext.service.js');
const LINK = R('src/utils/workOrderLink.js');
const LAT = R('src/utils/campaignTabLateral.js');
// ⚠ reviewTypeContext·reviewInspect 는 의도된 NUL(복합키 구분자)이 섞일 수 있어 이스케이프 표기로 제거하고 읽는다.
const SNUL = (p) => R(p).split(String.fromCharCode(0)).join('');
const RTC = SNUL('src/services/reviewTypeContext.service.js');
const RI = SNUL('src/services/reviewInspect.service.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/sheetSlotSync.service');
const wkc = require('../src/services/workKindContext.service');
const { parseTabRows } = require('../src/services/columnResolver');
const { workOrderForTabSql } = require('../src/utils/workOrderLink');
const { campaignColLateral } = require('../src/utils/campaignTabLateral');

/* ── 블로그 시트 픽스처: 구매일자 칸은 있으나 **전부 비어 있다**(모집 전이라 정할 수 없다) ── */
const HEADERS = ['번호', '구매일자', '블로그URL', '포스팅URL', '수취인', '연락처', '주소', '비고'];
const HEADER_ROW = 3;
const SOLID_ROWS = 6;      // 번호만 채워진 준비 행 6줄
function sheetRows() {
  const out = [];
  for (let i = 1; i <= SOLID_ROWS; i++) {
    const c = new Array(HEADERS.length).fill('');
    c[0] = String(i);                       // 번호만 채움 — 구매일자는 빈 칸
    out.push({ row_index: HEADER_ROW + i, cells: c });
  }
  out.push({ row_index: HEADER_ROW + SOLID_ROWS + 1, cells: new Array(HEADERS.length).fill('') }); // 빈 줄
  return out;
}
function headScan() {
  return [{ row_index: 1, cells: ['캠페인명', '0804)비타민,글루타치온_블로그'] },
          { row_index: HEADER_ROW, cells: HEADERS }];
}

/** @param {{kind?:string, total?:number, kindThrows?:boolean, totalThrows?:boolean, rows?:Function}} o */
function mkDb(o = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params });
      if (/raw_sheet_rows/.test(s) && /row_index <= 60/.test(s)) return { rows: headScan() };
      if (/FROM tab_configs c/.test(s) && /work_kind/.test(s)) {
        if (o.kindThrows) throw new Error('boom-kind');
        if (o.kind === undefined) return { rows: [] };            // 미등록 탭
        return { rows: [{ tab_work_kind: o.kind, camp_work_kind: o.campKind || null }] };
      }
      if (/FROM work_orders w/.test(s)) {
        if (o.totalThrows) throw new Error('boom-total');
        return { rows: o.total == null ? [] : [{ recruit_count: o.total }] };
      }
      if (/raw_sheet_rows/.test(s)) {
        const body = (o.rows ? o.rows() : sheetRows()).filter(r => r.row_index > HEADER_ROW);
        if (/SELECT row_index, cells FROM raw_sheet_rows/.test(s)) return { rows: body };
        // 감사 모드 — d(날짜) + filled(값 유무)
        const di = /cells->>\$4::int AS d/.test(s) ? parseInt(params[3], 10)
                 : (/cells->>\$3::int AS d/.test(s) ? parseInt(params[2], 10) : -1);
        return { rows: body.map(r => ({
          row_index: r.row_index,
          d: di >= 0 ? r.cells[di] : null,
          o: null,
          filled: r.cells.some(c => String(c || '').trim() !== ''),
        })) };
      }
      return { rows: [] };
    },
  };
}
const fresh = () => { wkc.__setPoolForTest(null); };   // 탭 캐시 초기화(60초 캐시가 케이스 간 새지 않게)

(async () => {

/* ══ 1) 블로그 준비 행 = 값 있는 행 ═══════════════════════════ */
console.log('\n1) 블로그 준비 행 — 구매일자가 비어도 누락되지 않는다');

await ta('★★ 구매일자 전부 빈 블로그 탭도 준비 행을 찾는다(사고 재현 방지)', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', total: 6 }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.blogMode, true, '블로그 모드로 안 들어갔다');
  assert.strictEqual(out.prepared.length, SOLID_ROWS,
    '구매일자가 비었다고 준비 행이 사라졌다 — 바를참스킨 0804 사고가 그대로 재현된다');
  assert.deepStrictEqual(out.prepared.map(p => p.seq), [4, 5, 6, 7, 8, 9],
    'seq 는 시트 실제 행 번호여야 한다(어긋나면 주문 유입 시 표가 두 겹)');
  assert.strictEqual(out.prepared[0].dateIso, null, '날짜가 없는데 날짜를 지어냈다');
});

await ta('★ 같은 시트를 리뷰 작업으로 보면 준비 행 0 — 두 기준이 실제로 다르다', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'review' }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.ok(!out.blogMode, '리뷰 탭인데 블로그 모드로 들어갔다');
  assert.strictEqual(out.prepared.length, 0, '날짜 기준인데 준비 행이 잡혔다(픽스처가 무의미해짐)');
});

await ta('빈 줄은 준비 행이 아니다', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', total: 99 }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.solidRows, SOLID_ROWS, '빈 줄까지 준비 행으로 셌다');
});

/* ══ 2) 총원(recruit_count)이 기준 ═══════════════════════════ */
console.log('\n2) 총원 — 앞에서부터 그 수까지만, 없는 자리는 지어내지 않는다');

await ta('★★ 총원이 실체 행보다 적으면 앞에서부터 총원 개까지만', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', total: 4 }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.prepared.length, 4, '총원 상한이 안 걸렸다');
  assert.deepStrictEqual(out.prepared.map(p => p.seq), [4, 5, 6, 7], '앞에서부터가 아니다');
  assert.strictEqual(out.beyondTotal, 2, '총원을 넘는 줄 수를 고지하지 않는다');
  assert.strictEqual(out.recruitTotal, 4);
  assert.strictEqual(out.totalSource, 'work_order', '총원 출처를 밝히지 않는다');
});

await ta('★★ 총원이 실체 행보다 많아도 자리를 지어내지 않는다(seq 를 알 수 없다) — shortOfTotal 로 고지', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', total: 50 }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.prepared.length, SOLID_ROWS, '시트에 없는 줄을 만들어냈다');
  assert.strictEqual(out.shortOfTotal, 50 - SOLID_ROWS, '부족분을 조용히 넘겼다');
});

await ta('총원을 모르면(오더 미연결) 실체 행 전부 + recruitTotal null 로 고지', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', total: null }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.prepared.length, SOLID_ROWS);
  assert.strictEqual(out.recruitTotal, null, '모르는 총원을 0/숫자로 꾸몄다');
  assert.strictEqual(out.totalSource, null);
});

await ta('총원 조회가 실패해도 준비 행은 나온다(fail-soft)', async () => {
  fresh();
  const out = await svc.readPreparedRows(mkDb({ kind: 'blog', totalThrows: true }),
    { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.ok, true, '총원 조회 실패가 준비 행 판독을 죽였다');
  assert.strictEqual(out.prepared.length, SOLID_ROWS);
  assert.strictEqual(out.recruitTotal, null);
});

/* ══ 3) 판정 불가 = 종전 동작(fail-safe) ═════════════════════ */
console.log('\n3) 판정 불가 — 모른다고 블로그로 단정하지 않는다');

for (const [label, opt] of [['미등록 탭', {}], ['조회 실패', { kindThrows: true }]]) {
  await ta(`★★ ${label} 이면 종전 동작(날짜 기준) — 리뷰 작업의 기준이 바뀌면 안 된다`, async () => {
    fresh();
    const out = await svc.readPreparedRows(mkDb(opt), { sheetId: 'S', tabGid: '77', tabName: 'T' });
    assert.strictEqual(out.ok, true, out.reason);
    assert.ok(!out.blogMode, `${label} 인데 블로그로 단정했다`);
    assert.strictEqual(out.prepared.length, 0, '날짜 기준이 아니다');
  });
}

await ta('tabName 을 안 넘기면 판정 자체를 안 한다(= 종전 동작)', async () => {
  fresh();
  const db = mkDb({ kind: 'blog', total: 6 });
  const out = await svc.readPreparedRows(db, { sheetId: 'S', tabGid: '77' });
  assert.ok(!out.blogMode, 'tabName 없이 블로그로 판정했다');
  assert.ok(!db.calls.some(c => /FROM tab_configs c/.test(c.sql)), '판정 못 할 조회를 쐈다');
});

await ta('★ 블로그 탭은 날짜 칸이 아예 없어도 no_date_column 으로 죽지 않는다', async () => {
  fresh();
  const noDateHeaders = ['번호', '블로그URL', '포스팅URL', '수취인'];
  const db = mkDb({
    kind: 'blog', total: 3,
    rows: () => [1, 2, 3].map(i => ({ row_index: HEADER_ROW + i, cells: [String(i), '', '', ''] })),
  });
  const orig = db.query;
  db.query = async (sql, params) => {
    if (/row_index <= 60/.test(String(sql))) {
      return { rows: [{ row_index: HEADER_ROW, cells: noDateHeaders }] };
    }
    return orig(sql, params);
  };
  const out = await svc.readPreparedRows(db, { sheetId: 'S', tabGid: '77', tabName: 'T' });
  assert.strictEqual(out.ok, true, '날짜 칸이 없다고 블로그 탭 판독이 막혔다: ' + out.reason);
  assert.strictEqual(out.prepared.length, 3);
});

/* ══ 4) 분기는 한 곳 — 호출부가 전부 tabName 을 넘긴다 ═══════ */
console.log('\n4) 분기 단일 지점 · 배선');

t('★★ readPreparedRows 호출부 4곳이 모두 tabName 을 넘긴다', () => {
  const calls = (SLOT + CUT).match(/readPreparedRows\(\s*db,\s*\{[^}]*\}/g) || [];
  assert.ok(calls.length >= 4, `호출부가 ${calls.length}곳뿐 — 배선이 빠졌다`);
  calls.forEach(c => assert.ok(/tabName/.test(c),
    'tabName 을 안 넘기는 호출부가 있다 — 그 경로에서 블로그 탭이 조용히 날짜 기준으로 떨어진다: ' + c));
});

t('★ 종류 판정 사본 0 — workKindContext(=utils/workKind) 를 쓴다', () => {
  const body = SLOT.replace(/\/\/.*$/gm, '');
  assert.ok(/workKindContext\.service/.test(body), '종류 조회를 workKindContext 에 위임하지 않는다');
  // 사본의 신호 = ① 정규화 규칙(`/블로그|blog/i`)을 다시 만들거나 ② 종류 칸을 SQL 로 직접 읽는 것.
  //   (정규화된 결과값 `kind !== 'blog'` 비교는 단일 출처의 산출물을 쓰는 것이라 사본이 아니다.
  //    설명 주석·로그 문구에 '블로그'가 나오는 것도 사본이 아니므로 문자열 존재로 재지 않는다.)
  assert.ok(!/\/블로그\|blog\//.test(body), '정규화 규칙 사본이 들어왔다 — utils/workKind 가 단일 출처다');
  assert.ok(!/SELECT[\s\S]{0,200}\bwork_kind\b/i.test(body), '종류 칸을 SQL 로 직접 읽는다(사본)');
});

t('★ 총원 조회는 workOrderForTabSql — 링크 우선순위 사본 금지', () => {
  assert.ok(/workOrderForTabSql\(\['recruit_count'\]\)/.test(SLOT), '총원 조회가 공유 SQL 을 안 쓴다');
  assert.ok(!/trackb_work_order_links/.test(SLOT), '링크 SQL 사본이 들어왔다');
});

/* ══ 5) URL 열 하이재킹 차단 ═════════════════════════════════ */
console.log('\n5) 블로그URL·포스팅URL 이 상품URL 을 가로채지 않는다');

const KW = {
  NAME_KEYWORDS: ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'],
  SUBMIT_KEYWORDS: ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'],
  DATA_TAB_KEYWORDS: ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'],
  SUBMITTED_VALUES: ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'],
};

t('★★ 블로그URL 이 상품URL 보다 왼쪽이어도 productUrl 은 상품 주소', () => {
  const v = [
    ['번호', '수취인', '블로그URL', '포스팅URL', '상품URL'],
    ['1', '홍길동', 'https://blog.naver.com/me', 'https://blog.naver.com/me/222', 'https://coupang.com/p/1'],
  ];
  const r = parseTabRows(v, 's', 't', 'g', null, KW);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].productUrl, 'https://coupang.com/p/1',
    '블로그·포스팅 주소가 상품URL 을 가로챘다 — 리뷰어 화면 "상품 페이지"가 남의 블로그로 나간다');
});

t('★ 상품URL 이 아예 없으면 빈 값 — 포스팅 주소를 상품 주소로 내보내지 않는다', () => {
  const v = [
    ['번호', '수취인', '포스팅URL'],
    ['1', '홍길동', 'https://blog.naver.com/me/222'],
  ];
  const r = parseTabRows(v, 's', 't', 'g', null, KW);
  assert.strictEqual(r[0].productUrl, '', '틀린 값을 채웠다 — 빈 값이 맞다');
});

t('무회귀: 평범한 상품URL·상품링크는 그대로 잡힌다', () => {
  const v1 = [['번호', '수취인', '상품URL'], ['1', '홍길동', 'https://a.com/1']];
  assert.strictEqual(parseTabRows(v1, 's', 't', 'g', null, KW)[0].productUrl, 'https://a.com/1');
  const v2 = [['번호', '수취인', '상품링크'], ['1', '홍길동', 'https://b.com/2']];
  assert.strictEqual(parseTabRows(v2, 's', 't', 'g', null, KW)[0].productUrl, 'https://b.com/2');
});

t('★ 제외 낱말은 둘뿐 — 넓히면 멀쩡한 상품열이 빈 값이 된다', () => {
  const m = RES.match(/const URL_EXCLUDE_PATTERNS = \[([^\]]*)\]/);
  assert.ok(m, 'URL_EXCLUDE_PATTERNS 가 없다');
  const list = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepStrictEqual(list, ['블로그', '포스팅'], '제외 목록이 바뀌었다: ' + list.join('|'));
});

/* ══ 6) 공유 조각 — 사본 금지 ════════════════════════════════ */
console.log('\n6) 공유 조각(공고 LATERAL · 작업오더 링크)');

t('★★ 공고 LATERAL 은 utils/campaignTabLateral 한 벌 — 리뷰타입·체험단 종류가 같은 걸 쓴다', () => {
  assert.ok(/campaignColLateral\('review_type'/.test(RTC), 'reviewTypeContext 가 공유 조각을 안 쓴다');
  assert.ok(/campaignColLateral\('work_kind'/.test(WKC), 'workKindContext 가 공유 조각을 안 쓴다');
  [RTC, WKC].forEach((src, i) => assert.ok(!/FROM recruit_campaigns\s*\n\s*WHERE linked_sheet_id/.test(src),
    `LATERAL 사본이 남아 있다(${i === 0 ? 'reviewTypeContext' : 'workKindContext'})`));
});

t('★★ 공유 LATERAL 이 gid 폴백 + "값이 있는 최신 공고" 규칙을 지킨다', () => {
  const sql = campaignColLateral('work_kind', 'wk');
  assert.ok(/linked_tab_name = c\.tab_name/.test(sql), '이름 매칭이 없다');
  assert.ok(/COALESCE\(c\.tab_gid, ''\) <> ''\s*AND linked_tab_gid = c\.tab_gid/.test(sql),
    'gid 폴백이 없다 — 리네임하면 설정이 조용히 풀린다(★ 빈 gid 는 키를 만들면 안 된다)');
  assert.ok(/COALESCE\(work_kind, ''\) <> ''/.test(sql),
    '값이 있는 최신 공고 조건이 없다 — 차수 재발행 시 최신 공고의 빈 값이 옛 설정을 가린다');
  assert.throws(() => campaignColLateral('status; DROP TABLE x', 'a'), '칸 이름 허용목록이 없다');
});

t('★★ 작업오더 링크는 ORDER BY link_rank — OR 로만 묶으면 최신 폴백 오더가 이긴다', () => {
  const sql = workOrderForTabSql(['recruit_count']);
  assert.ok(/ORDER BY link_rank, w\.created_at DESC/.test(sql), '우선순위를 ORDER BY 로 명시하지 않았다');
  assert.ok(/CASE WHEN EXISTS/.test(sql) && /trackb_work_order_links/.test(sql), '링크 판정이 없다');
  assert.ok(/w\.deleted_at IS NULL/.test(sql), '소프트 삭제된 오더를 거르지 않는다');
  assert.throws(() => workOrderForTabSql(['x; DROP TABLE y']), '칸 이름 검사가 없다');
});

t('★ reviewInspect 도 같은 공유 SQL 을 쓴다(사본 0)', () => {
  assert.ok(/workOrderForTabSql\(\[/.test(RI), 'reviewInspect 가 공유 SQL 을 안 쓴다');
  // ★ 줄 주석은 걷어내고 본다 — 설명에 규칙 이름이 나오는 것은 사본이 아니다.
  assert.ok(!/ORDER BY link_rank/.test(RI.replace(/\/\/.*$/gm, '')), '링크 SQL 사본이 남아 있다');
});

/* ══ 7) 위생 ═════════════════════════════════════════════════ */
console.log('\n7) 소스 위생');

t('★ 리터럴 NUL 없음(git 이 바이너리로 취급하면 grep 가드가 무력화된다)', () => {
  [['sheetSlotSync', SLOT], ['workKindContext', WKC], ['workOrderLink', LINK],
   ['campaignTabLateral', LAT], ['columnResolver', RES]].forEach(([n, s]) =>
    assert.ok(!s.includes(String.fromCharCode(0)), `${n} 에 리터럴 NUL 이 있다`));
});

t('★ 읽기 전용 — 준비 행 판독 경로에 쓰기 SQL 0', () => {
  [['workKindContext', WKC], ['workOrderLink', LINK]].forEach(([n, s]) => {
    const body = s.replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(body), `${n} 에 쓰기 SQL 이 있다`);
  });
});

/* ★★ campaignTabLateral 은 **파일 전체가 아니라 판독 조각만** 본다 (2026-08-24)
   ────────────────────────────────────────────────────────────────────────
   그 파일은 성격이 둘로 갈렸다: `campaignColLateral`(판독 경로가 쓰는 읽기 SQL 조각)과
   `renameCampaignLinkedTab`(탭 리네임 자가치유의 UPDATE — indexBuilder·indexScan 전용,
   준비 행 판독과 무관, 전용 가드 `campaignLinkFollowRename` 가 지킨다).
   파일 전체를 훑던 종전 검사는 그 쓰기 함수가 합류한 순간(#1134) 빨개졌다 — 판독 경로는
   그대로 읽기 전용인데도. 그래서 **판독 함수 본문으로 좁히고**, 대신 "그 파일의 쓰기는
   renameCampaignLinkedTab 안에만 있다"를 함께 고정한다(검사 의미는 더 강해진다). */
function _fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  // ★ 매개변수 목록을 먼저 건너뛴다 — `({ sheetId, ... } = {})` 같은 구조분해의 중괄호를
  //   본문 시작으로 세면 시그니처만 잘라 내고 "쓰기 0" 을 거짓으로 통과시킨다(실측).
  let p = src.indexOf('(', i), pd = 0, bodyStart = -1;
  for (let j = p; j < src.length; j++) {
    if (src[j] === '(') pd++;
    else if (src[j] === ')') { pd--; if (pd === 0) { bodyStart = src.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) return null;
  let d = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  return null;
}

t('★ 읽기 전용 — campaignTabLateral 의 판독 조각(campaignColLateral)에 쓰기 SQL 0', () => {
  const read = _fnBody(LAT, 'campaignColLateral');
  assert.ok(read, 'campaignColLateral 함수를 찾지 못했다(이름이 바뀌었으면 이 가드를 함께 고칠 것)');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(read.replace(/\/\/.*$/gm, '')),
    'campaignColLateral 에 쓰기 SQL 이 있다');
});

t('★ campaignTabLateral 의 쓰기는 renameCampaignLinkedTab 안에만 있다(딴 곳에 새 쓰기가 생기면 잡힌다)', () => {
  const body = LAT.replace(/\/\/.*$/gm, '');
  const total = (body.match(/\b(INSERT|UPDATE|DELETE)\b/gi) || []).length;
  const write = _fnBody(LAT, 'renameCampaignLinkedTab') || '';
  const inWrite = (write.replace(/\/\/.*$/gm, '').match(/\b(INSERT|UPDATE|DELETE)\b/gi) || []).length;
  assert.ok(total > 0 && total === inWrite,
    `쓰기 SQL ${total}개 중 ${inWrite}개만 renameCampaignLinkedTab 안에 있다`);
});

/* ══ 8) 진짜 PG — 스텁이 해석하지 않는 SQL 의미 ═════════════ */
// ★★ `filled` 판정은 jsonb 함수라 **스텁 DB 로는 절대 검증되지 않는다**(스텁은 SQL 을 해석하지
//   않는다 — 063 이 무음으로 꺼져 있던 것도 같은 이유). PGTEST_URL 이 있으면 실제로 돌린다.
if (process.env.PGTEST_URL) {
  console.log('\n8) [PG] 준비 행 판정 SQL — 빈 줄·공백만 줄 제외');
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  await c.query(`CREATE TEMP TABLE raw_sheet_rows(sheet_id TEXT, tab_gid TEXT, row_index INT, cells JSONB)`);
  const seed = [[3, ['번호', '구매일자', '블로그URL', '수취인']]];
  for (let i = 1; i <= SOLID_ROWS; i++) seed.push([3 + i, [String(i), '', '', '']]);
  seed.push([3 + SOLID_ROWS + 1, ['', '', '', '']]);        // 완전 빈 줄
  seed.push([3 + SOLID_ROWS + 2, ['   ', '', '', '']]);     // 공백만 — 빈 줄로 봐야 한다
  for (const [ri, cells] of seed) {
    await c.query(`INSERT INTO raw_sheet_rows VALUES ('S','77',$1,$2::jsonb)`, [ri, JSON.stringify(cells)]);
  }
  // 서비스가 쓰는 것과 **같은 식**(사본이 아니라 소스에서 뽑아 쓴다 — 갈라지면 이 검증이 무의미해진다)
  const m = SLOT.match(/const filledSql = `([^`]+)`/);
  assert.ok(m, 'filledSql 을 소스에서 못 찾았다');
  const { rows } = await c.query(
    `SELECT row_index, ${m[1]} AS filled FROM raw_sheet_rows
      WHERE sheet_id=$1 AND tab_gid=$2 AND row_index > $3 ORDER BY row_index`, ['S', '77', 3]);
  await ta('[PG] 값 있는 행만 준비 행 — 빈 줄·공백만 줄 제외', async () => {
    assert.strictEqual(rows.filter(r => r.filled).length, SOLID_ROWS,
      '빈 줄/공백만 줄이 준비 행으로 샜다(btrim 누락)');
  });
  await c.end();
} else {
  console.log('\n8) [PG] 건너뜀 — PGTEST_URL 미설정 (SQL 의미 검증은 진짜 PG 로만 가능)');
}

console.log(`\n✅ 블로그체험단 M2 회귀가드 통과 — ${pass}건`);
process.exit(0);
})();
