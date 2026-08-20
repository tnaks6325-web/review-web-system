// 리뷰어 비정상 로그 "컬럼 표기" 가드.
//   ① 서버 describeEvent: 한 문장(message)을 파싱하지 않고 event_type+context 로 오류내용/조치안내를 만든다
//      → 과거 로그에도 적용되고, 문구를 바꿔도 화면이 안 깨진다.
//   ② 프론트 _renderLogsBody: 표(컬럼)로 그리고, 하단 회색 반복 메타줄이 없어야 한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { describeEvent } = require('../src/services/reviewerEventLog.service');

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok   ' + name); pass++; };

// ── 1) 서버 파생: 유형별 오류내용/조치안내 ─────────────────────
t('1. order_unmirrored(수동필요): 오류내용과 조치안내가 분리된다', () => {
  const d = describeEvent({ eventType: 'order_unmirrored', severity: 'critical',
                            context: { mirrorStatus: 'stuck_manual' } });
  assert.ok(/시트에 입력되지 못함/.test(d.problem), 'problem: ' + d.problem);
  assert.ok(/수동 입력이 필요/.test(d.action), 'action: ' + d.action);
  assert.ok(!/자동 재기록이 중단/.test(d.problem), '조치안내가 오류내용에 섞여 있음');
});

t('2. order_unmirrored(자동복구 대기): 수동필요와 다른 문구 — 불필요한 조치를 유도하지 않음', () => {
  const d = describeEvent({ eventType: 'order_unmirrored', severity: 'warn',
                            context: { mirrorStatus: 'queued' } });
  assert.ok(/아직 시트에 입력되지 못함/.test(d.problem));
  assert.ok(/자동복구 대기/.test(d.action));
  assert.ok(!/수동/.test(d.action), '자동복구 중인데 수동 입력을 지시하면 안 됨');
});

t('3. order_no_capture: 캡처 보완 안내', () => {
  const d = describeEvent({ eventType: 'order_no_capture', context: {} });
  assert.ok(/구매캡쳐를 첨부하지 않았음/.test(d.problem));
  assert.ok(/구매캡쳐 보완/.test(d.action));
});

t('4. order_lost: 사라진 행 번호가 오류내용에 포함되고 조치는 자동 재기록 안내', () => {
  const d = describeEvent({ eventType: 'order_lost', severity: 'critical', context: { row: 88 } });
  assert.ok(/88행/.test(d.problem), '행 번호 누락: ' + d.problem);
  assert.ok(/시스템 재기록/.test(d.action));
});

t('5. order_lost_manual: 반복 소실 → 수동 확인·입력', () => {
  const d = describeEvent({ eventType: 'order_lost_manual', severity: 'critical', context: { row: 12 } });
  assert.ok(/반복 소실/.test(d.problem));
  assert.ok(/수동 확인·입력이 필요/.test(d.action));
});

t('6. order_row_shifted: 이동 전후 행 + "조치 불필요"', () => {
  const d = describeEvent({ eventType: 'order_row_shifted', severity: 'info',
                            context: { oldRow: 10, newRow: 14 } });
  assert.ok(/10→14행/.test(d.problem), d.problem);
  assert.ok(/불필요/.test(d.action), '자동 보정된 건에 할 일이 있는 것처럼 보이면 안 됨');
});

t('7. order_row_ambiguous: 시트 확인 필요', () => {
  const d = describeEvent({ eventType: 'order_row_ambiguous', context: { row: 62, candidates: [62, 70] } });
  assert.ok(/62행/.test(d.problem));
  assert.ok(/시트 확인/.test(d.action));
});

t('8. capture_mismatch: 슬롯·확신도 + 확신 여부에 따른 조치 구분', () => {
  const sure = describeEvent({ eventType: 'capture_mismatch', severity: 'critical',
                               context: { slotKey: 'review', sure: true, confidence: 0.95 } });
  assert.ok(/95%/.test(sure.problem), '확신도 표기 누락: ' + sure.problem);
  assert.ok(/재첨부 안내/.test(sure.action));
  const soft = describeEvent({ eventType: 'capture_mismatch', severity: 'warn',
                               context: { slotKey: 'review', sure: false, confidence: 0.75 } });
  assert.ok(/오탐일 수 있음/.test(soft.action), '애매한 판정인데 단정적으로 안내하면 안 됨');
});

t('9. 미지 유형·빈 입력: 빈 값 반환(프론트가 message 원문으로 폴백)', () => {
  assert.deepStrictEqual(describeEvent({ eventType: 'brand_new_type', context: {} }), { problem: '', action: '' });
  assert.deepStrictEqual(describeEvent({}), { problem: '', action: '' });
  assert.deepStrictEqual(describeEvent(), { problem: '', action: '' });
});

t('10. context가 비어도(과거 로그) 크래시 없이 문장이 만들어진다', () => {
  for (const et of ['order_lost','order_lost_manual','order_row_shifted','order_row_ambiguous',
                    'order_unmirrored','order_no_capture','capture_mismatch']) {
    const d = describeEvent({ eventType: et });
    assert.ok(typeof d.problem === 'string' && d.problem.length > 0, et + ' problem 비어 있음');
    assert.ok(typeof d.action === 'string' && d.action.length > 0, et + ' action 비어 있음');
    assert.ok(!/undefined|null|NaN/.test(d.problem + d.action), et + ' 에 undefined 노출: ' + d.problem + d.action);
  }
});

t('11. snake_case 행(DB 원본 형태)도 인식한다', () => {
  const d = describeEvent({ event_type: 'order_no_capture', context: {} });
  assert.ok(/구매캡쳐/.test(d.problem), 'event_type(스네이크) 미인식');
});

// ── 2) 서버 배선: 목록 응답에 problem/action 동봉 ──────────────
t('12. listReviewerEvents 가 각 행에 problem/action 을 붙여 반환한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/reviewerEventLog.service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function listReviewerEvents'));
  assert.ok(/describeEvent\(r\)/.test(body.slice(0, body.indexOf('\n}\n'))),
    'listReviewerEvents 가 describeEvent 를 적용하지 않음 → 표 컬럼이 빈칸');
  assert.ok(/\bmessage\b/.test(src), 'message 원문 컬럼을 지우면 관리자 중요알림·SSE가 깨진다');
});

// ── 3) 프론트: 표로 그리고 반복 메타줄이 없어야 함 ─────────────
const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const script = (HTML.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
const lgBody = script.slice(script.indexOf('function _renderLogsBody'),
                            script.indexOf('function _canResolveLog'));
assert.ok(lgBody.length > 100, '_renderLogsBody 를 찾지 못함');

t('13. 로그를 표(thead/th)로 그린다 — 요청한 6개 컬럼이 모두 있음', () => {
  assert.ok(/<table class="lgtable">/.test(lgBody), '표가 아님');
  for (const h of ['발생시점','작업명','이름','전화번호','오류내용','조치안내']) {
    assert.ok(new RegExp('>' + h + '<').test(lgBody), '컬럼 누락: ' + h);
  }
});

t('14. 하단 회색 반복 메타줄(시각 · 탭 · 이름 · 번호)이 제거됐다', () => {
  assert.ok(!/color:var\(--muted\);margin-top:3px/.test(lgBody), '반복 메타줄이 남아 있음');
  assert.ok(!/_logPhone/.test(script), '메타줄 전용 함수가 죽은 코드로 남아 있음');
});

t('15. 오류내용은 서버 problem 우선, 없으면 message 원문 폴백(빈칸 방지)', () => {
  assert.ok(/l\.problem\s*\|\|\s*l\.message/.test(lgBody), 'problem/message 폴백 누락');
});

t('16. 표 셀 값은 전부 이스케이프된다(로그 원장 오염 시에도 주입 불가)', () => {
  const cells = lgBody.match(/<td class="c-[a-z]+"[^>]*>\$\{[^}]*\}/g) || [];
  assert.ok(cells.length >= 5, '셀을 찾지 못함');
  for (const c of cells) {
    assert.ok(/esc\(|sevBadge\(/.test(c), '이스케이프 없는 셀: ' + c);
  }
});

t('17. 조치는 펼침 패널로 이동 — 표의 [확인] 버튼 제거, 행 클릭 펼침 + [해결]', () => {
  assert.ok(/onclick="_toggleLogRow\(/.test(lgBody), '행 클릭 시 펼쳐져야 함');
  assert.ok(/class="lgdetail"/.test(lgBody), '펼침 상세행이 있어야 함');
  assert.ok(!/>확인<\/button>/.test(lgBody), '표 행의 [확인] 버튼은 제거돼야 함');
  assert.ok(/_logOpenWorkdesk\(/.test(lgBody), '작업보드 열기(펼침 패널) 유실');
  assert.ok(/_cancelLogOrder\(/.test(lgBody), '취소 처리(펼침 패널) 유실');
  assert.ok(/_resolveLog\(/.test(lgBody) && /✔ 해결/.test(lgBody), '해결 버튼(펼침 패널) 유실');
  assert.ok(/_canResolveLog\(\)/.test(lgBody), '해결/취소 권한 게이트 유실(staff가 타 담당 알림을 지움)');
});

t('17b. 캡처 형식오류 행은 펼치면 제출 이미지 미리보기(행 펼침과 이미지 클릭 분리)', () => {
  assert.ok(/_logCapFileId\(l\)/.test(lgBody), '행이 캡처 fileId 를 조회해야 함');
  assert.ok(/_logImgUrl\(cap\)/.test(lgBody), '무인증 이미지 프록시 URL 로 렌더');
  assert.ok(/onclick="event\.stopPropagation\(\);_logViewImage\(/.test(lgBody), '이미지 클릭은 stopPropagation 으로 행 토글과 분리');
});

// ── 4) 컬럼 순서·폭 + 캡처 미첨부 정밀확인 ────────────────────
t('18. 조치 버튼이 가장 왼쪽 컬럼이다', () => {
  const heads = [...lgBody.matchAll(/<th class="c-([a-z]+)"/g)].map(m => m[1]);
  assert.strictEqual(heads[0], 'btn', '헤더 첫 칸이 조치가 아님: ' + heads.join(','));
  const cells = [...lgBody.matchAll(/<td class="c-([a-z]+)"/g)].map(m => m[1]);
  assert.strictEqual(cells[0], 'btn', '본문 첫 칸이 조치가 아님: ' + cells.join(','));
  // 헤더와 본문 칸 순서가 어긋나면 값이 다른 컬럼에 들어간다
  assert.deepStrictEqual(cells.slice(0, heads.length), heads, '헤더와 본문 컬럼 순서 불일치');
});

t('19. 작업명 컬럼 폭 240px(기존 210 + 30)', () => {
  const m = HTML.match(/\.lgtable \.c-tab\{width:(\d+)px;max-width:(\d+)px/);
  assert.ok(m, 'c-tab 폭 규칙을 찾지 못함');
  assert.strictEqual(m[1], '240');
  assert.strictEqual(m[2], m[1], 'width와 max-width가 다르면 표가 흔들린다');
});

t('20. 캡처 미첨부 정밀확인: 버튼·핸들러가 있고 admin/master 에게만 노출', () => {
  assert.ok(/_auditNoCapture\(\)/.test(script), '정밀확인 핸들러 없음');
  assert.ok(/no-capture-audit/.test(script), '감사 엔드포인트 호출 없음');
  const btn = script.slice(script.indexOf('id="ncBtn"') - 200, script.indexOf('id="ncBtn"') + 60);
  assert.ok(/_canResolveLog\(\)\?/.test(btn), '권한 게이트 없이 노출됨(staff에게 전역 감사 노출)');
});

t('21. 감사 엔드포인트는 admin/master 전용 · 읽기 전용(DB/Drive 쓰기 없음)', () => {
  const diag = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
  const i = diag.indexOf("router.get('/no-capture-audit'");
  assert.ok(i > 0, '엔드포인트 없음');
  const body = diag.slice(i, diag.indexOf('module.exports', i));
  assert.ok(/authMiddleware, adminOrMasterMiddleware/.test(body.slice(0, 200)), '권한 미들웨어 누락');
  assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/i.test(body), '감사인데 쓰기 쿼리가 있음');
  /* ⚠ 판정이 `captureLinkBackfill.service` 로 이관됐다(연결 백필이 **같은 함수**로 후보를 고른다).
     검사 의미는 불변 — "Drive 실물을 대조한다" + "3분류를 낸다". 다만 그 근거를 서비스에서 읽는다.
     ★ 라우트가 자체 대조 사본을 되살리면(그러면 감사와 백필이 갈린다) 첫 단언이 잡는다. */
  assert.ok(/captureLinkBackfill\.auditCaptureLinks\(/.test(body) && !/listFolderFilesRecursive/.test(body),
    '감사가 판정 서비스를 태우지 않음(사본 부활)');
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/captureLinkBackfill.service.js'), 'utf8');
  assert.ok(/listFolderFilesRecursive/.test(svc), 'Drive 실물 대조를 안 함 → DB만 봐선 오탐을 못 가림');
  assert.ok(/attachedButUnlinked/.test(svc) && /notAttached/.test(svc) && /unknown/.test(svc),
    '판정 3분류(오탐/진짜 미첨부/보류)가 없음');
  assert.ok(/summary: tally\(r\.items\)/.test(body) && /current: tally\(post\)/.test(body) && /legacy: tally\(pre\)/.test(body),
    '감사 응답 계약(summary/current/legacy)이 깨졌다');
});

t('22. 구매캡쳐 업로드가 재시도 + 실패 시 리뷰어에게 고지(오탐 근본원인)', () => {
  const sa = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
  /* ⚠ 고정 길이 슬라이스로 자르면 그 블록이 자라는 순간 조용히 빨개진다(레포 규율).
     업로드 블록을 **경계 문자열**로 잘라 본다 — 검사 의미는 불변. */
  const i = sa.indexOf('const _capSlot = {');
  assert.ok(i > 0, '업로드 블록을 찾지 못함');
  const blk = sa.slice(i, sa.indexOf('_renderCaptureChecklist();', i));
  assert.ok(/uploadOrderImage/.test(blk), '업로드 액션 유실');
  assert.ok(/attempt < 3|attempt \+\+|for \(let attempt/.test(blk), '업로드 재시도 없음 — 1회 실패로 미첨부 오탐');
  assert.ok(/showToast\(/.test(blk), '최종 실패를 리뷰어에게 안 알리면 첨부했다고 믿고 창을 닫는다');
  assert.ok(/orderSubmissionId/.test(blk), '주문 연결 키 누락 → 폴백 매칭에만 의존');
});

t('23. 감사 결과를 컷오프 기준으로 분리한다(과거 미링크를 오탐으로 오해하지 않게)', () => {
  const diag = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
  const i = diag.indexOf("router.get('/no-capture-audit'");
  const body = diag.slice(i, diag.indexOf('module.exports', i));
  /* ⚠ 컷오프 조회·구간 표시는 판정 서비스로 이관됐다(감사·백필 공용). 검사 의미는 불변 —
     "컷오프를 읽는다 · 주문별 구간을 표시한다 · 실패해도 감사가 죽지 않는다"를 서비스에서 본다.
     라우트는 그 재료로 current/legacy 집계를 낸다는 계약만 남는다. */
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/captureLinkBackfill.service.js'), 'utf8');
  assert.ok(/reviewer_log_capture_cutoff/.test(svc), '컷오프를 읽지 않으면 배포 이전 주문까지 오탐으로 잡힌다');
  assert.ok(/preCutoff/.test(svc), '주문별 구간 표시 없음');
  assert.ok(/current:/.test(body) && /legacy:/.test(body), '구간별 집계(current/legacy) 없음');
  // 컷오프 조회 실패가 감사 전체를 죽이면 안 됨(fail-soft)
  assert.ok(/catch \(_\) \{ \/\* 못 읽으면/.test(svc), '컷오프 조회 실패 시 fail-soft 아님');
});

t('24. 정밀확인 화면은 current 기준으로 집계하고 legacy 를 따로 고지한다', () => {
  const i = script.indexOf('function _auditNoCapture');
  const fn = script.slice(i, script.indexOf('function _canResolveLog', i));
  assert.ok(/r\.current/.test(fn), '화면이 전체 합산을 쓰면 과거 데이터가 오탐으로 보인다');
  assert.ok(/preCutoff/.test(fn), '목록에서 배포 이전 건을 걸러내지 않음');
  assert.ok(/legacy/.test(fn), 'legacy 건수 고지 없음');
});

console.log('\n' + pass + ' runtime checks passed');
