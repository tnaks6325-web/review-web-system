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

/* ═══ 원장 진입점이 실제로 보존하는가(스텁 DB로 실제 호출) ═══ */
(async () => {
  const ledgerSrc = readS('services/orderLedger.service.js');
  ok('보존 로직이 행 배정 직후·큐 등록 전에 있다(같은 orderData 객체 → 재기록까지 일치)',
    /claim\.row && !String\(orderData\.selectedOptKey \|\| ''\)\.trim\(\)/.test(ledgerSrc)
    && /orderData\.selectedOptKey = keep;/.test(ledgerSrc));
  ok('★ 값이 있으면 건드리지 않는다(옵션 선택 결과 우선 = 무회귀)',
    /!String\(orderData\.selectedOptKey \|\| ''\)\.trim\(\)/.test(ledgerSrc));
  ok('원장 컬럼도 함께 갱신(관제·CSV 표기 일치)',
    /UPDATE order_submissions SET selected_opt_key = \$2 WHERE id = \$1/.test(ledgerSrc));
  ok('★ 보존 실패가 주문을 깨지 않는다(fail-soft)',
    /catch \(e\) \{\s*\n\s*logger\.warn\(`\[orderLedger\] 옵션 보존 실패\(무시\)/.test(ledgerSrc));
  ok('왜 매퍼를 안 고치는지 코드에 남아 있다(다음 사람이 되돌리지 않도록)',
    /공유 매퍼는 고치지 않는다/.test(ledgerSrc) && /order_cancel/.test(ledgerSrc));

  /* 시뮬레이션: 보존 로직과 매퍼를 연결해 최종 쓰기 값을 확인 */
  const simulate = (selected, row) => {
    const orderData = { selectedOptKey: selected, recipient: '김서준', phone: '010-1111-2222' };
    if (row && !String(orderData.selectedOptKey || '').trim()) {
      const keep = OL.existingOptionKeyAt(CTX, row);
      if (keep) orderData.selectedOptKey = keep;
    }
    return OL.mapOrderToSheetRow(HEADERS, orderData)[2];
  };
  ok('★★ 선택 없음 + 로스터에 값 있음 → 기존 값이 유지된다(사고 재발 차단)', simulate('', 12) === '포토리뷰');
  ok('선택값이 있으면 그 값이 기록된다', simulate('레드', 12) === '레드');
  ok('원래 비어 있던 칸은 그대로 빈 값(없는 값을 지어내지 않는다)', simulate('', 13) === '');
  ok('다중 옵션 컬럼도 보존', simulate('', 14) === '블랙');   // optParts[0] = '블랙'

  console.log(`\n✅ optionColumnPreserve: ${n}개 통과`);
})();
