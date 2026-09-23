/**
 * duplicateSubmitPrevent.test.js — 같은 사진 두 번 제출 방지(첨부 즉시 경고) 회귀가드.
 *
 * 고정하는 불변식:
 *   A. findOwnDuplicate — **본인 것만** 대조, **같은 자리 재첨부는 중복이 아님**(정상 재제출 보호),
 *      휴지통 제외, 연락처를 알면 동명이인 배제, 실패는 null(경고 없음 = 오늘과 동작 동일)
 *   B. precheck 라우트 — `duplicate` 는 **가산 필드**(기존 verdict/blocked 계약 불변),
 *      AI 판정과 **독립**(형식이 통과여도 중복 경고가 나간다), 어떤 경우에도 500 없음
 *   C. 화면 — 첨부 안내는 경고까지만(차단 없음)·줄 번호 미노출·내 제출 현황 렌더
 *
 * 실행: node tests/duplicateSubmitPrevent.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const front = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const RI = require('../src/services/reviewInspect.service');

function stubPool(handler) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); } };
}

(async () => {
  /* ═══ A. findOwnDuplicate ═══ */
  console.log('\nA) 첨부 즉시 중복 대조');
  {
    // A1: 본인이 다른 건에 낸 같은 사진 → 경고 재료 반환
    let p = stubPool(async () => ({ rows: [{
      file_id: 'OLD', sheet_id: 'S', tab_name: 'T', row_index: 388,
      uploaded_at: '2026-07-29T12:58:00Z', phone8: '12345678',
    }] }));
    RI.__setPoolForTest(p);
    const d = await RI.findOwnDuplicate({
      fileHash: 'H', sheetId: 'S', tabName: 'T', rowIndex: 394, reviewerName: '김예진', phone8: '12345678',
    });
    assert.ok(d && d.fileId === 'OLD' && d.sameTab === true && d.rowIndex === 388);
    ok('A1: 본인이 같은 작업 다른 건에 낸 사진을 찾아 알려줄 재료를 준다');

    // A2: ★★ 같은 자리 재첨부는 중복이 아니다 — SQL 이 그 자리를 제외한다
    const sql = p.calls[0].sql;
    assert.ok(/NOT \(s\.sheet_id = \$3 AND s\.tab_name = \$4/.test(sql) && /row_index, -1\) = COALESCE\(\$5/.test(sql),
      '★★ 같은 작업·같은 줄은 대조 대상에서 제외(정상 재제출 보호)');
    assert.ok(/reviewer_name/.test(sql) && /REPLACE/.test(sql), '본인(이름) 것만 대조');
    assert.ok(/<> 'trashed'/.test(sql), '이미 제거된 파일은 대조 대상 아님');
    ok('A2: ★★ 같은 자리 재첨부 제외 · 본인 것만 · 휴지통 제외');

    // A3: 연락처가 다르면(동명이인) 제외
    p = stubPool(async () => ({ rows: [{ file_id: 'X', sheet_id: 'S2', tab_name: 'T2', row_index: 3, phone8: '99999999' }] }));
    RI.__setPoolForTest(p);
    assert.strictEqual(await RI.findOwnDuplicate({ fileHash: 'H', reviewerName: '김예진', phone8: '12345678' }), null);
    // 연락처를 모르면 이름만으로 진행(경고는 나가되 차단이 아니라 안전)
    p = stubPool(async () => ({ rows: [{ file_id: 'X', sheet_id: 'S2', tab_name: 'T2', row_index: 3, phone8: '99999999' }] }));
    RI.__setPoolForTest(p);
    assert.ok(await RI.findOwnDuplicate({ fileHash: 'H', reviewerName: '김예진' }));
    ok('A3: 연락처를 알면 동명이인 배제, 모르면 이름만으로 진행');

    // A4: 다른 작업이면 sameTab=false(화면이 작업명 없이 "다른 작업"으로만 말한다)
    p = stubPool(async () => ({ rows: [{ file_id: 'Y', sheet_id: 'OTHER', tab_name: 'OT', row_index: 35, phone8: null }] }));
    RI.__setPoolForTest(p);
    const d2 = await RI.findOwnDuplicate({ fileHash: 'H', sheetId: 'S', tabName: 'T', reviewerName: '백은미' });
    assert.strictEqual(d2.sameTab, false);
    ok('A4: 다른 작업의 사진 재사용도 잡는다(사용자 확정 ② — 본인 전체 대조)');

    // A5: 재료 부족·조회 실패 = null(경고 없음 = 오늘과 동작 동일)
    assert.strictEqual(await RI.findOwnDuplicate({ reviewerName: '김' }), null, '지문 없으면 대조 안 함');
    assert.strictEqual(await RI.findOwnDuplicate({ fileHash: 'H' }), null, '이름 없으면 대조 안 함');
    RI.__setPoolForTest(stubPool(async () => { throw new Error('db down'); }));
    assert.strictEqual(await RI.findOwnDuplicate({ fileHash: 'H', reviewerName: '김' }), null, '조회 실패도 null');
    ok('A5: ★ 재료 부족·조회 실패는 경고 없음(fail-open — 첨부를 막지 않는다)');
    RI.__setPoolForTest(null);
  }

  /* ═══ B. precheck 라우트 배선 ═══ */
  console.log('\nB) 첨부 즉시 판정 라우트');
  {
    const dg = read('src/routes/diag.routes.js');
    const block = dg.slice(dg.indexOf("router.post('/review-precheck'"), dg.indexOf("router.post('/review-precheck'") + 3500);
    assert.ok(/rowIndex, reviewerName, phone8 \} = req\.body/.test(block), '문맥(줄·이름·연락처) 수신');
    assert.ok(/findOwnDuplicate\(\{[\s\S]*?fileHash: inspect\.hashBase64\(base64\)/.test(block),
      '지문은 서버가 계산(클라가 보내지 않는다)');
    assert.ok(/duplicate: await dupOf\(\)/.test(block), '응답에 duplicate 가산');
    assert.ok(/verdict: v\.verdict/.test(block) && /blocked: v\.verdict === 'block'/.test(block),
      '★ 기존 응답 계약(verdict·blocked) 불변 — 구버전 프론트 무영향');
    // ★ 중복 조회 실패가 형식 판정을 죽이지 않는다(독립 · 이중 try)
    assert.ok(/const dupOf = async \(\) => \{[\s\S]*?catch \(_\) \{ return null; \}/.test(block),
      '★ 중복 조회 실패는 그 값만 null(형식 판정은 그대로 나간다)');
    ok('B1: 문맥 수신 · 지문 서버 계산 · duplicate 가산 · 기존 계약 불변');

    // 업로드 경로: 지나쳐 제출된 중복은 안내만(파일 삭제·반려 없음)
    assert.ok(/r\.duplicateNotice = '앞서 제출하신 사진과 같은 사진이에요/.test(dg), '제출 시 리뷰어 안내');
    const upBlock = dg.slice(dg.indexOf('duplicateNotice') - 900, dg.indexOf('duplicateNotice') + 300);
    assert.ok(!/trashFiles|rejected = /.test(upBlock), '★ 파일을 지우거나 반려하지 않는다(정당한 재제출 보호)');
    ok('B2: ★ 제출된 중복은 안내까지만 — 삭제·반려 없음');
  }

  /* ═══ C. 화면 ═══ */
  console.log('\nC) 리뷰어 화면');
  {
    const sa = front('js/search-app.js');
    assert.ok(/rowIndex: ctx\.rowIndex, reviewerName: ctx\.reviewerName, phone8: ctx\.phone8/.test(sa),
      'precheck 호출에 문맥 전달');
    const dupFn = /function _preRenderDup\(scope, anchor\)\{?[\s\S]*?\n\}/.exec(sa)[0];
    assert.ok(/이미 제출한 사진이에요/.test(dupFn) && /다른 리뷰 화면/.test(dupFn), '안내 문구');
    assert.ok(!/행\b/.test(dupFn.replace(/rowIndex/g, '')), '★ 줄 번호를 리뷰어에게 노출하지 않는다');
    assert.ok(/_dupOrdinal\(d\.rowIndex\)/.test(dupFn) && /번 건/.test(dupFn),
      '★ 참여 순번(①②③)으로 가리킨다');
    assert.ok(/그래도 이 사진이 맞다면 그대로 제출하셔도 됩니다/.test(dupFn),
      '★★ 경고까지만 — 제출을 막지 않는다(사용자 확정 ①)');
    assert.ok(!/blocked\s*=\s*true/.test(dupFn), '★★ 중복이 제출 차단으로 이어지지 않는다');
    ok('C1: ★★ 첨부 즉시 안내 — 순번 표기 · 차단 없음 · 줄 번호 미노출');

    const st = /function _renderMySubmitStatus\(items\) \{[\s\S]*?\n\}/.exec(sa)[0];
    assert.ok(/if \(!list\.some\(it => it && it\.isSubmitted\)\) return;/.test(st),
      '낸 것이 없으면 빈 상자를 그리지 않는다');
    assert.ok(/\$\{i \+ 1\}\. \$\{label\}/.test(st), '★ 참여 순번 + 상품(옵션)으로 표기(줄 번호 아님)');
    assert.ok(/reviewFileId/.test(st) && /api\/drive\/image/.test(st), '제출한 사진 썸네일');
    assert.ok(/_renderMySubmitStatus\(items\);[\s\S]{0,120}_renderMultiInfoGrid\(items\)/.test(sa),
      '정보 확인 그리드보다 먼저 보여준다');
    ok('C2: 내 제출 현황 — 순번·상품·제출일·썸네일(서버 목록만 사용)');

    // 목록 데이터(썸네일)는 검색 응답에서 온다
    const ss = read('src/services/search.service.js');
    assert.ok(/ri\.review_file_id\s+AS "reviewFileId"/.test(ss) && /reviewFileId: row\.reviewFileId \|\| null/.test(ss),
      '검색 응답에 대표 이미지 파일ID 포함(본인 행의 값)');
    ok('C3: 썸네일 재료 = 그 행의 대표 이미지(본인 것)');
  }

  console.log(`\n✅ duplicateSubmitPrevent 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
