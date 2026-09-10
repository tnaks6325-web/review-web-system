/**
 * duplicateSubmitPrevent.test.js — 반영 완료된 같은 사진 재제출 차단 회귀가드.
 *
 * 고정하는 불변식:
 *   A. findOwnDuplicate — 검증된 phone8 본인 + 다른 행 + 리뷰 슬롯 + 구매양식 매핑 +
 *      review_index/campaign_participants 중 하나가 제출완료인 파일만 반환한다.
 *   B. precheck와 upload — 선택 즉시 차단하고, 프런트 우회도 Drive 업로드 전에 다시 차단한다.
 *   C. 화면 — 중복은 우회 불가, 제출일·수취인 참여건을 표시하고 다른 사진 선택만 허용한다.
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
    // A1: 본인이 다른 구매양식에 제출 완료한 같은 사진 → 차단 재료 반환
    let p = stubPool(async () => ({ rows: [{
      file_id: 'OLD', sheet_id: 'S', tab_name: 'T', row_index: 388,
      submitted_at: '2026-09-10T12:58:00Z', recipient_name: '김수만',
    }] }));
    RI.__setPoolForTest(p);
    const d = await RI.findOwnDuplicate({
      fileHash: 'H', sheetId: 'S', tabName: 'T', rowIndex: 394, reviewerName: '김예진', phone8: '12345678',
    });
    assert.ok(d && d.fileId === 'OLD' && d.sameTab === true && d.rowIndex === 388);
    assert.strictEqual(d.recipientName, '김수만');
    assert.strictEqual(d.submittedAt, '2026-09-10T12:58:00Z');
    ok('A1: 제출 완료된 다른 구매양식의 동일 파일과 표시용 제출일·수취인을 반환');

    // A2: ★★ 같은 자리 재첨부는 중복이 아니다 — SQL 이 그 자리를 제외한다
    const sql = p.calls[0].sql;
    assert.ok(/NOT \(s\.sheet_id = \$3 AND s\.tab_name = \$4/.test(sql) && /row_index, -1\) = COALESCE\(\$5/.test(sql),
      '★★ 같은 작업·같은 줄은 대조 대상에서 제외(정상 재제출 보호)');
    assert.ok(/COALESCE\(s\.slot_key, 'review'\) = 'review'/.test(sql), '리뷰 캡처만 대조');
    assert.ok(/ri\.phone8[\s\S]*?= \$6 OR[\s\S]*?cp\.phone8[\s\S]*?= \$6/.test(sql), '서버가 확인한 phone8로 본인만 대조');
    ok('A2: ★★ 같은 자리 재첨부 제외 · 리뷰 슬롯만 · phone8 본인만');

    // A3: 업로드 흔적만으로는 부족 — 양쪽 완료 상태 중 하나가 TRUE여야 한다.
    assert.ok(/LEFT JOIN review_index/.test(sql) && /LEFT JOIN campaign_participants/.test(sql), '두 완료 원장 결합');
    assert.ok(/COALESCE\(ri\.is_submitted, FALSE\) OR COALESCE\(cp\.is_submitted, FALSE\)/.test(sql),
      'review_index 또는 작업보드 참여자 제출완료만');
    assert.ok(/s\.completed_at IS NOT NULL/.test(sql)
      && /s\.upload_batch_id IS NULL AND ri\.review_file_id = s\.file_id/.test(sql),
      '신규 완료 이력 또는 레거시 대표 캡처만 중복 처리');
    ok('A3: 구매양식 매핑 + 두 원장 중 하나의 is_submitted=TRUE 필수');

    // A4: 다른 작업이면 sameTab=false
    p = stubPool(async () => ({ rows: [{ file_id: 'Y', sheet_id: 'OTHER', tab_name: 'OT', row_index: 35,
      submitted_at: '2026-09-09T01:00:00Z', recipient_name: '백은미' }] }));
    RI.__setPoolForTest(p);
    const d2 = await RI.findOwnDuplicate({ fileHash: 'H', sheetId: 'S', tabName: 'T', reviewerName: '백은미', phone8: '12345678' });
    assert.strictEqual(d2.sameTab, false);
    ok('A4: 다른 작업의 반영 완료 사진도 차단');

    // A5: 서버 검증 phone8 없거나 조회 실패 = 차단하지 않음
    assert.strictEqual(await RI.findOwnDuplicate({ reviewerName: '김' }), null, '지문 없으면 대조 안 함');
    assert.strictEqual(await RI.findOwnDuplicate({ fileHash: 'H', reviewerName: '김' }), null, 'phone8 없으면 차단 안 함');
    RI.__setPoolForTest(stubPool(async () => { throw new Error('db down'); }));
    assert.strictEqual(await RI.findOwnDuplicate({ fileHash: 'H', reviewerName: '김', phone8: '12345678' }), null, '조회 실패도 null');
    ok('A5: ★ 검증 신원 없음·조회 실패는 오차단하지 않음');
    RI.__setPoolForTest(null);
  }

  /* ═══ B. precheck 라우트 배선 ═══ */
  console.log('\nB) 첨부 즉시 판정 라우트');
  {
    const dg = read('src/routes/diag.routes.js');
    const block = dg.slice(dg.indexOf("router.post('/review-precheck'"), dg.indexOf("router.post('/review-precheck'") + 3500);
    assert.ok(/verifiedReviewerIdentity\(req\)/.test(block), '리뷰어 세션에서 검증한 신원 사용');
    assert.ok(/findOwnDuplicate\(\{[\s\S]*?fileHash: inspect\.hashBase64\(base64\)/.test(block),
      '지문은 서버가 계산(클라가 보내지 않는다)');
    assert.ok(/duplicate: await dupOf\(\)/.test(block), '응답에 duplicate 가산');
    assert.ok(/verdict: v\.verdict/.test(block) && /blocked: v\.verdict === 'block'/.test(block),
      '★ 기존 응답 계약(verdict·blocked) 불변 — 구버전 프론트 무영향');
    // ★ 중복 조회 실패가 형식 판정을 죽이지 않는다(독립 · 이중 try)
    assert.ok(/const dupOf = async \(\) => \{[\s\S]*?catch \(_\) \{ return null; \}/.test(block),
      '★ 중복 조회 실패는 그 값만 null(형식 판정은 그대로 나간다)');
    ok('B1: 검증 세션 신원 · 지문 서버 계산 · duplicate 가산 · 기존 계약 불변');

    // 업로드 경로: 프런트 우회도 Drive 저장 전에 차단
    const uploadAt = dg.indexOf("router.post('/review-upload'");
    const hardBlockAt = dg.indexOf("rejected: 'duplicate_submitted'", uploadAt);
    const driveUploadAt = dg.indexOf('driveService.uploadFileBase64', uploadAt);
    assert.ok(hardBlockAt > uploadAt && hardBlockAt < driveUploadAt, '중복 차단이 Drive 업로드보다 먼저');
    assert.ok(/message: '이미 제출됬던 사진이에요'/.test(dg.slice(uploadAt, driveUploadAt)), '서버 차단 문구');
    assert.ok(/REVIEW_UPLOAD_AUTH_REQUIRED/.test(dg.slice(uploadAt, driveUploadAt)),
      '리뷰어 토큰이나 내부 담당자 인증이 없으면 업로드 자체를 거부');
    assert.ok(/replacedCurrent/.test(dg.slice(uploadAt)), '같은 행 재첨부는 교체 결과로 반환');
    const migration = read('migrations/154_review_duplicate_completed_lookup.sql');
    assert.ok(/\(sheet_id, tab_name, row_index\)/.test(migration) && /INCLUDE \(is_submitted, phone8, recipient_name\)/.test(migration),
      '완료 상태 결합은 행 복합 커버링 인덱스를 사용');
    const batchMigration = read('migrations/155_review_submission_upload_batch.sql');
    const sa = front('js/search-app.js');
    assert.ok(/ADD COLUMN IF NOT EXISTS upload_batch_id UUID/.test(batchMigration)
      && /ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ/.test(batchMigration),
      '다중 캡처 업로드 묶음과 완료 이력 저장');
    const submitRoute = read('src/routes/submit.routes.js');
    const manualSvc = read('src/services/trackB.service.js');
    assert.ok(/s\.file_id = lr\.review_file_id/.test(submitRoute)
      && /completed_count/.test(submitRoute) && /marked_count/.test(submitRoute),
      '현재 대표 이미지의 정확한 업로드 묶음만 완료·제출 상태를 원자적으로 처리');
    assert.ok(/REVIEW_COMPLETION_HISTORY_FAILED/.test(submitRoute)
      && /review_completion_history_failed/.test(submitRoute),
      '완료 이력 기록 실패를 제출 성공으로 반환하지 않음');
    assert.ok(/if \(!reviewerIdentity && !internalIdentity\)/.test(dg),
      '요청 슬롯과 무관하게 리뷰어 또는 내부 신원을 검증');
    assert.ok(/REVIEW_UPLOAD_TARGET_FORBIDDEN/.test(dg)
      && /REVIEW_SUBMIT_TARGET_FORBIDDEN/.test(submitRoute),
      '업로드와 제출 모두 세션 소유자의 구매양식 행만 허용');
    const ownership = read('src/services/reviewerTargetOwnership.service.js');
    assert.ok(/cp\.owner_reviewer_id IS NULL AND pl\.owner_reviewer_id = \$4::uuid/.test(ownership),
      '현재 작업보드 소유자가 있으면 과거 참여 링크보다 우선');
    const trackB = read('src/routes/trackB.routes.js');
    const workdesk = front('workdesk.html');
    assert.ok(/trackBUploadAuthorized !== true/.test(dg)
      && /'reviewer_campaign', 'intranet'/.test(submitRoute),
      'Track B 인트라넷 토큰은 Track A 업로드·제출 경로에서 거부');
    assert.ok(/router\.post\('\/workdesk\/review-upload'[\s\S]*?trackBUploadAuthorized = true/.test(trackB)
      && /\/api\/trackb\/workdesk\/review-upload/.test(workdesk),
      '작업보드 수동 캡처는 내부 권한을 거친 Track B 전용 프록시 사용');
    assert.ok(/REVIEW_SUBMISSION_LEDGER_FAILED/.test(dg) && /uploadBatchId/.test(dg),
      '업로드 원장 기록 실패를 성공으로 숨기지 않고 묶음 ID를 반환');
    assert.ok(/requiresReviewHistory = required\.includes\('review'\)/.test(submitRoute)
      && /lr\.review_file_id = s2\.file_id/.test(submitRoute),
      '리뷰 슬롯 작업만 완료 이력을 요구하고 보완 제출은 현재 대표 묶음을 확정');
    assert.ok(/cr\.upload_batch_id IS NULL[\s\S]*?s\.file_id = cr\.file_id/.test(submitRoute),
      '배치 도입 전 미완료 파일은 현재 대표 파일 한 건만 완료 처리');
    assert.ok((submitRoute.match(/FOR UPDATE/g) || []).length >= 2,
      '대표 파일 검증부터 제출 상태 전환까지 행 잠금으로 재첨부와 직렬화');
    assert.ok(/r\.routed\.to === 'review'/.test(sa),
      '자동 이동 후 최종 리뷰 슬롯에 들어간 업로드 묶음을 제출 요청에 전달');
    assert.ok(/uploadBatchId: reviewUploadBatchId/.test(sa), '프런트가 업로드 응답의 정확한 묶음 ID를 제출 요청에 전달');
    assert.ok(/SET completed_at = COALESCE\(completed_at, NOW\(\)\)[\s\S]*?file_id = ANY\(\$4::text\[\]\)/.test(manualSvc),
      '작업보드 수동 제출은 선택 파일을 완료 처리');
    ok('B2: ★ 프런트 우회도 Drive 업로드 전에 차단 · 같은 행은 교체 허용');
  }

  /* ═══ C. 화면 ═══ */
  console.log('\nC) 리뷰어 화면');
  {
    const sa = front('js/search-app.js');
    assert.ok(/'Content-Type': 'application\/json', \.\.\._getAuthHeaders\(\)/.test(sa),
      'precheck 호출에 리뷰어 세션 헤더 전달');
    const dupFn = /function _preRenderDup\(scope, anchor\)\{?[\s\S]*?\n\}/.exec(sa)[0];
    assert.ok(/이미 제출됬던 사진이에요/.test(dupFn), '확정 문구');
    assert.ok(/다른 구매양식에 제출되어 반영됐어요/.test(dupFn), '반영 완료 설명');
    assert.ok(/_duplicateHistoryLine\(d\)/.test(dupFn), '제출일·수취인 참여건 한 줄');
    assert.ok(!/이번 구매양식의 리뷰 화면을 새로 캡처해 올려주세요/.test(sa), '삭제 확정 문구 없음');
    assert.ok(/s\.duplicateBlocked/.test(sa) && /if \(s\.duplicateBlocked\) return/.test(sa),
      '★★ 중복 차단은 제출 및 AI 우회 체크로도 해제 불가');
    assert.ok(/사진 중복 여부를 확인하고 있어요/.test(sa), '비동기 확인 중 제출 경쟁 차단');
    assert.ok(/다른 사진 선택/.test(sa) && /_showDuplicateBlockModal/.test(sa), '차단 팝업과 재선택 버튼');
    assert.ok(/querySelector\?\.\('input\[type="file"\]'\)/.test(sa), '다른 사진 선택은 슬롯 내부 파일 입력을 직접 연다');
    assert.ok(/현재 건의 리뷰 캡처를 교체하였습니다\./.test(sa), '같은 행 재첨부 완료 문구');
    ok('C1: ★★ 첨부 즉시 차단 팝업 · 제출이력 표시 · 우회 불가 · 같은 행 교체 허용');

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
