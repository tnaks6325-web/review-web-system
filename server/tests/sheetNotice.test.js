/**
 * 시트 상단 강제 공지문(C1:R1) 회귀가드
 *   ★★ 최우선 불변식: 공지문에 헤더 탐지 키워드가 2개 이상 들어가면 `detectSheetHeader`가
 *     공지 줄을 헤더로 오인해 그 탭의 파싱이 통째로 깨진다(공지는 헤더보다 위 + 위에서부터 첫 매칭 확정).
 *     → 위험 문구는 **절대 시트에 써지면 안 된다**. 여기서 실제 탐지기와 교차검증해 고정한다.
 *   + 기본 문구 안전성 / 점유 셀 비파괴 / 멱등 / 행 삽입 없음(C1:R1 고정)
 * 실행: node tests/sheetNotice.test.js
 */
const assert = require('assert');
const svc = require('../src/services/sheetNotice.service');
const { detectSheetHeader, isSheetHeaderRow } = require('../src/utils/sheetHeader');

// 실제 탭 구조(메타 8행 + 헤더 9행)에 공지문을 얹어 헤더 탐지가 그대로인지 확인
const HEADER = ['번호', '담당자', '구매일자', '인애드명단', '주문자제출', '수취인', '쿠팡id', '연락처', '주소',
                '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금', '주문번호', '택배송장번호', '비고'];
function sheetWithNotice(notice) {
  const row1 = ['캠페인명', '0721)장수돌침대_쿠팡_탄소매트 900건'];
  row1[2] = notice;                       // C1 = 공지문 (실제 삽입 위치)
  return [
    row1,
    ['구매시간대', '15시 이전 완료'], ['배송유형', '빈박스 택배대행'], ['마감자료URL', ''],
    ['상품링크1', 'https://...'], ['플랫폼', '쿠팡'], ['사이즈', '멀티싱글'], ['색상', '자율'],
    HEADER,
    ['1', '만두', '7 / 28 (화)', '', '김서준', '김서준'],
  ];
}

async function run() {
  // ═══ 1. 기본 문구(사유 포함형)는 안전하고, 헤더 탐지를 흔들지 않는다 ═══
  {
    const v = svc.validateNoticeText(svc.DEFAULT_NOTICE);
    assert.equal(v.ok, true, '기본 문구는 안전해야 함');
    assert.deepEqual(v.hits, [], `기본 문구에 금지어 없음 (검출: ${v.hits.join(',')})`);

    const det = detectSheetHeader(sheetWithNotice(svc.DEFAULT_NOTICE));
    assert.equal(det.headerRowIndex, 9, '공지문을 넣어도 헤더는 여전히 9행');
    assert.equal(det.dataStartRow, 10, '데이터 시작행도 그대로');
    assert.deepEqual(det.headers, HEADER, '헤더 내용 불변');
  }

  // ═══ 2. 위험 문구(키워드 2개+)는 거부 — 그리고 실제로 헤더를 오염시킨다는 사실도 함께 고정 ═══
  {
    const bad = '⚠️ 리뷰어 이름과 연락처는 시스템이 자동 입력합니다';   // 이름 + 연락처 = 2개
    const v = svc.validateNoticeText(bad);
    assert.equal(v.ok, false, '위험 문구는 거부되어야 함');
    assert.equal(v.reason, 'header_collision');
    assert.ok(v.hits.length >= 2, `검출 키워드 2개 이상 (${v.hits.join(',')})`);

    // 만약 이게 시트에 써졌다면 1행이 헤더로 오인된다 = 탭 파싱 붕괴
    assert.equal(isSheetHeaderRow([''.padEnd(0), '', bad]), true, '위험 문구가 든 줄은 헤더로 오인됨(거부 이유의 근거)');
    const det = detectSheetHeader(sheetWithNotice(bad));
    assert.equal(det.headerRowIndex, 1, '오인 시 1행이 헤더가 됨 — 그래서 절대 쓰면 안 됨');
  }

  // ═══ 3. 키워드 1개는 허용하되(안전), 0개가 권장 ═══
  {
    const one = '⚠️ 주소 변경은 관리자에게 알려주세요';                  // 주소 1개
    const v = svc.validateNoticeText(one);
    assert.equal(v.ok, true, '키워드 1개는 헤더 오인 임계(2) 미만이라 허용');
    assert.equal(v.hits.length, 1);
    assert.equal(detectSheetHeader(sheetWithNotice(one)).headerRowIndex, 9, '헤더 탐지 영향 없음');
  }

  // ═══ 4. 빈 문구 거부 ═══
  assert.equal(svc.validateNoticeText('').ok, false);
  assert.equal(svc.validateNoticeText('   ').ok, false);
  assert.equal(svc.validateNoticeText(null).ok, false);

  // ═══ 5. setNoticeText 는 위험 문구를 저장하지 않는다(운영 중 교체 경로 봉쇄) ═══
  {
    const calls = [];
    svc.__setPoolForTest({ async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } });
    const bad = await svc.setNoticeText('수취인 연락처 확인 요망');       // 수취인 + 연락처
    assert.equal(bad.ok, false, '위험 문구 저장 거부');
    assert.equal(calls.filter(c => /INSERT INTO app_settings/.test(c.sql)).length, 0, 'DB 기록 없음');

    const good = await svc.setNoticeText('⚠️ 줄을 지우지 마세요 — 값만 지워주세요');
    assert.equal(good.ok, true);
    assert.ok(calls.some(c => /INSERT INTO app_settings/.test(c.sql)), '안전 문구는 저장');
    svc.__setPoolForTest(null);
  }

  // ═══ 6. 삽입 위치는 C1:R1 고정 — 행 삽입이 없어야 기존 기록의 행번호가 안 밀린다 ═══
  {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/services/sheetNotice.service'), 'utf8');
    assert.ok(/NOTICE_START_COL\s*=\s*2/.test(src), 'C열(0-based 2) 고정');
    assert.ok(/startRowIndex:\s*0,\s*endRowIndex:\s*1/.test(src), '1행에만 씀(행 범위 1줄)');
    assert.ok(!/insertDimension|insertRange/.test(src), '행 삽입 요청이 없어야 함(행번호 밀림 금지)');
  }

  console.log('✅ sheetNotice.test.js — 전체 통과');
}

run().then(() => process.exit(0)).catch(e => { console.error('❌ 실패:', e); process.exit(1); });
