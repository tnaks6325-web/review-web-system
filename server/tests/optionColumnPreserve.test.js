/**
 * optionColumnPreserve.test.js — 제출 시 옵션 칸이 지워지던 사고 회귀가드.
 *
 * 증상(7/31 올리브영): 리뷰어가 구매양식을 제출하면 그 행의 옵션 컬럼 값('포토리뷰')이 사라짐.
 *
 * ★★ 메커니즘: `mapOrderToSheetRow`는 옵션 칸에 `''`를 반환하고 `buildBatchUpdateData`는
 *   `null`만 걸러낸다 → **빈 옵션은 "쓰지 않음"이 아니라 그 칸을 지우는 쓰기**가 된다.
 *   시트 옵션 피커가 뜨지 않는 탭(로스터 매칭 성공 등)은 선택값이 비어 그대로 지워졌다.
 *
 * ⚠ 공유 매퍼는 고치지 않는다 — `order_cancel`의 칸 비우기와 Track B write-back의
 *   컬럼 disjoint 마스크가 `''` 반환에 의존한다. **호출부에서 기존 값을 되쓴다.**
 *
 * 실행: node tests/optionColumnPreserve.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const OL = require('../src/services/orderLedger.service');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const HEADERS = ['번호', '구매일자', '옵션', '주문자', '수취인', '연락처', '주소'];
const CTX = {
  headers: HEADERS,
  tabGid: '123',
  headerRowIndex: 1,
  dataRows: [
    { rowIndex: 12, cells: ['1', '7 / 31 (금)', '포토리뷰', '', '', '', ''] },
    { rowIndex: 13, cells: ['2', '7 / 31 (금)', '', '', '', '', ''] },
    { rowIndex: 14, cells: ['3', '7 / 31 (금)', '블랙|L', '', '', '', ''] },
  ],
};

/* ═══ 지우는 쓰기 메커니즘 자체를 고정(이게 바뀌면 이 가드의 전제가 무너진다) ═══ */
{
  const row = OL.mapOrderToSheetRow(HEADERS, { selectedOptKey: '' });
  ok('★★ 빈 옵션은 매퍼에서 ""(=지우는 값)로 나온다 — 매퍼는 일부러 그대로 둔다', row[2] === '');
  const upd = OL.buildBatchUpdateData({ tabName: 'T', headers: HEADERS, targetRow: 12, orderData: { selectedOptKey: '' } });
  ok('★★ buildBatchUpdateData가 그 빈 값을 실제 쓰기로 내보낸다(null만 거름)',
    upd.some(u => /!C12$/.test(u.range) && u.values[0][0] === ''));
}

/* ═══ 기존 값 되읽기(단일 출처) ═══ */
ok('배정 행의 옵션값을 그대로 읽는다', OL.existingOptionKeyAt(CTX, 12) === '포토리뷰');
ok('다중 옵션 컬럼은 | 로 결합(매퍼 optParts 역순)', OL.existingOptionKeyAt(CTX, 14) === '블랙|L');
ok('옵션이 비어 있던 행은 빈 값(되쓸 게 없음)', OL.existingOptionKeyAt(CTX, 13) === '');
ok('없는 행·컨텍스트 없음은 빈 값(안전)',
  OL.existingOptionKeyAt(CTX, 99) === '' && OL.existingOptionKeyAt(null, 12) === '');
ok('옵션 컬럼이 없는 탭은 빈 값',
  OL.existingOptionKeyAt({ headers: ['번호', '수취인'], dataRows: [{ rowIndex: 12, cells: ['1', 'x'] }] }, 12) === '');
ok('옵션 컬럼 인덱스 판정은 매퍼와 같은 규칙',
  JSON.stringify(OL.optionColIndexes(HEADERS)) === '[2]'
  && JSON.stringify(OL.optionColIndexes(['Option A', '옵션2'])) === '[0,1]');

/* ═══ 단일 출처 — 사본 금지 ═══ */
{
  const mo = readS('services/manualOrder.service.js');
  ok('★ manualOrder가 자체 구현을 갖지 않고 원장 것을 쓴다(드리프트 차단)',
    /require\('\.\/orderLedger\.service'\)/.test(mo)
    && !/function existingOptionKeyAt\(/.test(mo) && !/function optionColIndexes\(/.test(mo));
}

/* ═══ C′(2026-08) 이후: 보존은 "원장 역주입"이 아니라 "쓰기 시점 blank-only"가 담당한다.
   ★ 옛 방식(시트값을 selected_opt_key 로 되쓰기)은 폐기됐다 — 재배정 시 옛 행의 관리자
     작업지시값이 새 행으로 전이하고, 원장이 리뷰어 선택을 잃어 CS·TrackB·홀드검증이 오독했다.
   그래서 아래 가드는 "그 역주입이 **없다**"를 고정한다(되살아나면 실패). ═══ */
(async () => {
  const ledgerSrc = readS('services/orderLedger.service.js');
  ok('★★ 원장에 시트값을 역주입하지 않는다 — selected_opt_key 되쓰기 UPDATE 부재',
    !/UPDATE order_submissions SET selected_opt_key = \$2 WHERE id = \$1/.test(ledgerSrc)
    && !/orderData\.selectedOptKey = keep;/.test(ledgerSrc));
  ok('★ 폐기 이유가 코드에 남아 있다(다음 사람이 되돌리지 않도록)',
    /재배정 시 옛 행의 관리자 작업지시값이 새 행으로 전이/.test(ledgerSrc)
    && /역주입하지 말 것/.test(ledgerSrc));
  ok('왜 매퍼를 안 고치는지도 그대로 남아 있다',
    /공유 매퍼는 고치지 않는다/.test(ledgerSrc) && /order_cancel/.test(ledgerSrc));
  ok('reconcile 은 원장 값(리뷰어 선택)을 그대로 쓴다(재배정 전이 없음)',
    /selectedOptKey: row\.selected_opt_key/.test(ledgerSrc));

  /* ═══ 쓰기 시점 blank-only 필터 — 실제 함수 실행 ═══ */
  const probeOf = (map) => (col) => ({ known: true, value: map[col] == null ? '' : map[col] });
  const bd = (selected) => OL.buildBatchUpdateData({
    tabName: 'T', headers: HEADERS, targetRow: 12,
    orderData: { selectedOptKey: selected, recipient: '김서준', phone: '010-1111-2222' },
  });
  const optWrite = (res) => {
    const hit = res.data.find(u => /!C12$/.test(u.range));
    return hit ? hit.values[0][0] : null;      // null = 쓰기 자체가 나가지 않음(=보존)
  };
  const run = (selected, cell, probe) => OL.filterOptionWritesBlankOnly({
    batchData: bd(selected), headers: HEADERS, tabName: 'T', targetRow: 12,
    probe: probe === undefined ? probeOf({ 2: cell }) : probe,
  });

  ok('★★ 선택 없음 + 셀에 값 있음 → 옵션 쓰기 제거(7/31 사고 재발 차단)', optWrite(run('', '포토리뷰')) === null);
  ok('★★ 선택 있음 + 셀에 다른 값 → 덮지 않는다(확정 요구: 어떤 경우에도)',
    optWrite(run('우레온 바디미스트 150ml', '텍스트')) === null);
  ok('빈 칸에는 기입한다(하단 신규 append 행)', optWrite(run('레드', '')) === '레드');
  ok('같은 값이면 쓰기 생략(멱등)', optWrite(run('레드', '레드')) === null);
  ok('★ probe 없음 = 확인 불가 → 기입 생략(fail-closed)',
    optWrite(run('레드', '', null)) === null
    && run('레드', '', null).suppressed.some(s => s.reason === 'unverified'));
  ok('★ 옵션 아닌 칸은 하나도 사라지지 않는다(수취인·연락처·주소·금액 생존)', (() => {
    const before = bd('레드');
    const after = OL.filterOptionWritesBlankOnly({
      batchData: before, headers: HEADERS, tabName: 'T', targetRow: 12, probe: probeOf({ 2: '포토리뷰' }),
    }).data;
    const gone = before.filter(u => !after.includes(u));
    return gone.length === 1 && /!C12$/.test(gone[0].range);
  })());
  ok('옵션 열이 없는 탭은 batchData 완전 동일(무영향)', (() => {
    const H2 = ['번호', '수취인', '연락처'];
    const b = OL.buildBatchUpdateData({ tabName: 'T', headers: H2, targetRow: 5, orderData: { recipient: 'A' } });
    return OL.filterOptionWritesBlankOnly({ batchData: b, headers: H2, tabName: 'T', targetRow: 5, probe: probeOf({}) }).data === b;
  })());

  /* ═══ ★ 오분류 차단 — optionWriteColumns 는 매퍼에서 파생한다 ═══ */
  {
    const H3 = ['번호', '리뷰옵션', '옵션금액', '상품옵션', '비고(옵션확인)', '수취인'];
    const w = OL.optionWriteColumns(H3);
    ok('★★ 옵션금액(=결제금액 칸)·비고(옵션확인)은 옵션 칸이 아니다 — 오분류하면 금액 쓰기가 조용히 삭제된다',
      JSON.stringify(w) === '[1]');
    ok('optionColIndexes(헤더 문자열 규칙)와 다르다는 사실 자체를 고정',
      JSON.stringify(OL.optionColIndexes(H3)) !== JSON.stringify(w));
    // 매퍼가 그 칸에 실제로 무엇을 넣는지로 교차검증(규칙이 갈리면 실패)
    const mapped = OL.mapOrderToSheetRow(H3, { selectedOptKey: 'X', price: '22000' });
    ok('교차검증: 옵션금액 칸에는 결제금액이 들어간다', mapped[2] === '22000');
  }

  /* ═══ range 판정이 fail-open 이 아니다(탭명 표기차에도 인덱스로 잡는다) ═══ */
  {
    const b = [{ range: `'다른표기'!C12`, values: [['상품명']] }];
    const r = OL.filterOptionWritesBlankOnly({ batchData: b, headers: HEADERS, tabName: 'T', targetRow: 12, probe: probeOf({ 2: '텍스트' }) });
    ok('★ 탭명이 달라도 열 인덱스로 옵션 칸을 잡아낸다(문자열 단독 매칭 금지)', r.data.length === 0);
    ok('_colIdxFromRange 파싱', OL._colIdxFromRange(`'T'!AA7`).col === 26 && OL._colIdxFromRange(`'T'!C12`).row === 12);
  }

  /* ═══ 킬스위치 ═══ */
  {
    process.env.ORDER_OPTION_BLANK_ONLY = '0';
    const r = OL.filterOptionWritesBlankOnly({ batchData: bd(''), headers: HEADERS, tabName: 'T', targetRow: 12, probe: probeOf({ 2: '포토리뷰' }) });
    ok('ORDER_OPTION_BLANK_ONLY=0 이면 무동작(현행 복귀)', r.data.length === bd('').length);
    delete process.env.ORDER_OPTION_BLANK_ONLY;
  }

  /* ═══ Track B write-back 마스크 불변(매퍼 무수정의 귀결) ═══ */
  ok('mapOrderToSheetRow(headers,{})의 non-null 집합 불변 — _wbOrderMappedMask 무영향',
    JSON.stringify(OL.mapOrderToSheetRow(HEADERS, {}).map(v => v !== null)) === JSON.stringify([false, true, true, true, true, true, true]));

  /* ═══ 배선: 두 쓰기 경로 + 취소 경로 ═══ */
  {
    const q = readS('services/syncQueue.service.js');
    ok('★ 단건 order_append: buildBatchUpdateData → filterOptionWritesBlankOnly → batchUpdateSheet',
      /const _bd = buildBatchUpdateData\(\{[\s\S]{0,300}?const _optFilt = filterOptionWritesBlankOnly\(\{[\s\S]{0,300}?const batchData = _optFilt\.data;/.test(q));
    ok('★ 배치 드레인도 같은 필터를 통과한다(경로 드리프트 차단)',
      /batchData\.push\(\.\.\._optFilt\.data\);/.test(q));
    ok('★ 가드 사각형에 옵션 열이 합류한다(콜 순증 0 · 라이브 판정)',
      /const _probeCols = \[\.\.\.new Set\(\[\.\.\.guards\.map\(g => g\.col\), \.\.\._optCols\]\)\]/.test(q)
      && /for \(const c of _optCols\) allCols\.add\(c\);/.test(q));
    ok('★ probe 오프셋이 가드와 같은 minCol 기준이다(어긋나면 가드 오판)',
      /_optProbe = \(col\) => \(\{ known: true, value: String\(cells\[col - minC\] \|\| ''\) \}\)/.test(q)
      && /x\.optProbe = \(col\) => \(\{ known: true, value: String\(cells\[col - minCol\] \|\| ''\) \}\)/.test(q));
    ok('★ 취소(order_cancel)도 옵션 칸은 비우지 않는다(작업지시 보호)',
      /_cancelOptCols/.test(q) && /_blankAll\.filter\(u => !_cancelOptCols\.has\(u\.range\)\)/.test(q));
    ok('★ 경고는 reviewer_event_logs 가 아니라 logAbnormal(warn) — 알림 도배 금지',
      /step: 'option_cell_occupied', severity: 'warn'/.test(q));
  }

  console.log(`\n✅ optionColumnPreserve: ${n}개 통과`);
})();
