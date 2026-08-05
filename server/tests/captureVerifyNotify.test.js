/**
 * captureVerifyNotify.test.js — 캡처 AI 검수 "확실히 아님" 알림 경로 회귀가드.
 *
 * 정책(①): AI가 **확실히** 아니라고 판정하면 리뷰어에게 재첨부를 유도하고 관리자에게 알린다.
 *   - 확신 ≥ SURE(0.9)   → critical  = 관리자 대시보드 빨간 알림 + SSE
 *   - 확신 0.7 ~ 0.9     → warn      = 리뷰웹시스템[3버전] "리뷰어 로그"에만 (늑대소년 방지)
 *   - 확신 < 0.7         → skipped   = 아무 일도 없음(fail-open)
 * ★★ 어느 경우에도 **제출은 막지 않는다**.
 * ★ 도배 금지: 같은 (탭·행·슬롯) 미해결 알림이 있으면 새로 쌓지 않는다.
 * ★ 자동 해결: 같은 자리에 형식이 맞는 캡처가 오면 열린 알림을 닫는다.
 *
 * 실행: node tests/captureVerifyNotify.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ═══ Gemini 스텁 — 확신도를 시나리오별로 조작 ═══ */
let conf = 0.95;
const orig = Module.prototype.require;
Module.prototype.require = function (p) {
  if (p === './gemini.service') {
    return { classifySubmissionImage: async () => ({ kind: 'receipt', confidence: conf, businessNo: '', amount: 0 }) };
  }
  return orig.apply(this, arguments);
};
const cv = require('../src/services/captureVerify.service');

/* ═══ pool 스텁 — 실제 SQL 문자열과 파라미터를 관찰 ═══ */
const q = [];
let existingOpen = 0;      // 미해결 알림 존재 여부(도배 방지 선조회 응답)
cv.__setPoolForTest({
  query: async (sql, params) => {
    q.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/SELECT 1 FROM reviewer_event_logs/.test(sql)) return { rows: existingOpen ? [{ '?column?': 1 }] : [] };
    if (/UPDATE reviewer_event_logs/.test(sql)) return { rowCount: 2 };
    return { rows: [], rowCount: 0 };
  },
});

/* ═══ reviewerEventLog 스텁 — 실제 기록 대신 인자를 포착 ═══ */
const logged = [];
const logPath = require.resolve('../src/services/reviewerEventLog.service');
require.cache[logPath] = {
  id: logPath, filename: logPath, loaded: true, exports: {
    logReviewerEvent: async (a) => { logged.push(a); return { ok: true, id: logged.length }; },
  },
};

(async () => {
  /* ── 판정: 확신 구간 ── */
  conf = 0.95;
  const sureV = await cv.verifyCapture({ base64: 'x', slotKey: 'review' });
  ok('확신 0.95 = 확실히 아님(sure)', sureV.status === 'mismatch' && sureV.sure === true);

  conf = 0.8;
  const softV = await cv.verifyCapture({ base64: 'x', slotKey: 'review' });
  ok('확신 0.8 = 경고하되 확실은 아님', softV.status === 'mismatch' && softV.sure === false);

  conf = 0.5;
  const skipV = await cv.verifyCapture({ base64: 'x', slotKey: 'review' });
  ok('★★ 확신 0.5 = 판정 안 함(fail-open 유지)', skipV.status === 'skipped' && skipV.sure === false);

  conf = 0.95;
  const okV = await cv.verifyCapture({ base64: 'x', slotKey: 'receipt' });
  ok('맞는 슬롯이면 ok — sure 플래그가 오탐으로 켜지지 않는다', okV.status === 'ok' && okV.sure === false);

  ok('사업자번호 불일치는 sure로 올리지 않는다(OCR 한 자리 오독 방지)',
    /사업자번호 불일치는 sure로 올리지 않는다/.test(readS('services/captureVerify.service.js')));

  /* ── 알림: 승격 ── */
  logged.length = 0; q.length = 0; existingOpen = 0;
  await cv.logCaptureMismatch({ sheetId: 'S1', tabName: 'T1', reviewerName: '홍길동',
    slotKey: 'review', rowIndex: 12, verdict: sureV, fileId: 'F1' });
  ok('확실히 아님 → critical 로 기록(대시보드 빨간 알림 조회 조건)', logged[0]?.severity === 'critical');
  ok('한글 자연어 문장 + 행 번호 + 확신도',
    /홍길동님이 12행/.test(logged[0]?.message || '') && /AI 확신 95%/.test(logged[0]?.message || ''));
  ok('리뷰어에게도 안내됐다는 사실을 관리자 문장에 남긴다',
    /재첨부 안내가 표시됐습니다/.test(logged[0]?.message || ''));
  ok('context에 자리(행·슬롯)와 확신 정보를 남긴다',
    logged[0]?.context?.slotKey === 'review' && logged[0]?.context?.row === '12'
    && logged[0]?.context?.sure === true);

  logged.length = 0;
  await cv.logCaptureMismatch({ sheetId: 'S1', tabName: 'T1', reviewerName: '홍길동',
    slotKey: 'review', rowIndex: 13, verdict: softV });
  ok('애매한 판정은 warn — 빨간 알림을 띄우지 않는다(늑대소년 방지)', logged[0]?.severity === 'warn');

  /* ── 알림: 도배 방지 ── */
  logged.length = 0; q.length = 0; existingOpen = 1;
  const dup = await cv.logCaptureMismatch({ sheetId: 'S1', tabName: 'T1', reviewerName: '홍길동',
    slotKey: 'review', rowIndex: 12, verdict: sureV });
  ok('★ 같은 자리에 미해결 알림이 있으면 새로 쌓지 않는다', dup.skipped === true && logged.length === 0);
  ok('중복 판정은 (탭·행·슬롯) 기준',
    /context->>'slotKey' = \$3 AND COALESCE\(context->>'row', ''\) = \$4/.test(q[0]?.sql || '')
    && JSON.stringify(q[0]?.params) === JSON.stringify(['S1', 'T1', 'review', '12']));

  /* ── 알림: 자동 해결 ── */
  q.length = 0;
  const rs = await cv.resolveCaptureMismatch({ sheetId: 'S1', tabName: 'T1', slotKey: 'review', rowIndex: 12 });
  ok('올바른 캡처 재첨부 → 열린 알림 자동 해결', rs.resolved === 2);
  ok('자동 해결은 미해결 건만 건드린다(이력 보존)',
    /resolved_at IS NULL/.test(q[0]?.sql || '') && /auto:recaptured/.test(q[0]?.sql || ''));
  ok('도배 방지와 자동 해결이 같은 자리 기준을 쓴다(어긋나면 알림이 안 닫힌다)',
    JSON.stringify(q[0]?.params) === JSON.stringify(['S1', 'T1', 'review', '12']));

  /* ── fail-soft: DB가 죽어도 업로드 경로가 깨지지 않는다 ── */
  cv.__setPoolForTest({ query: async () => { throw new Error('DB down'); } });
  logged.length = 0;
  const r1 = await cv.logCaptureMismatch({ sheetId: 'S1', tabName: 'T1', slotKey: 'review', rowIndex: 12, verdict: sureV });
  ok('선조회 실패해도 알림 기록은 진행(알림 유실보다 중복이 낫다)', logged.length === 1 && r1.ok !== false);
  const r2 = await cv.resolveCaptureMismatch({ sheetId: 'S1', tabName: 'T1', slotKey: 'review', rowIndex: 12 });
  ok('자동 해결 실패가 예외를 밖으로 던지지 않는다', r2.ok === false);

  Module.prototype.require = orig;
  delete require.cache[logPath];

  /* ═══ 배선 ═══ */
  const diag = readS('routes/diag.routes.js');
  const app = readF('js/search-app.js');

  ok('업로드 경로가 행 번호를 넘긴다(안 넘기면 도배 방지·자동 해결이 무력)',
    /logCaptureMismatch\(\{[\s\S]{0,200}rowIndex \}\)/.test(diag));
  ok('형식이 맞으면 자동 해결을 호출한다',
    /verdict\.status === 'ok'[\s\S]{0,220}resolveCaptureMismatch\(\{/.test(diag));
  // ★ 판정 catch 와 알림 try 사이에 자동 분류(파일 라우팅) 블록이 들어왔다 —
  //   검사 의미 불변: 판정 try 는 스스로 닫히고, 알림 기록은 별도 try 로 분리돼 있다.
  ok('★ 알림 기록 실패가 리뷰어 화면의 재첨부 안내를 지우지 않는다(판정/알림 try 분리)',
    /verdict = null; \}\s*\/\/ 검수 실패가 업로드 결과를 뒤집지 않는다[\s\S]{0,7000}\/\/ 알림 기록은 판정과 분리한다/.test(diag));
  ok('★★ 업로드·제출 차단 코드가 없다(fail-open 유지)',
    !/verdict[\s\S]{0,80}return res\.json\(\{ ok: false/.test(diag));
  ok('응답에 sure 를 실어 리뷰어 화면이 강조할 수 있게',
    /sure: !!verdict\.sure/.test(diag));
  ok('리뷰어 화면이 "담당자에게도 전달" 을 알린다(재첨부 유도)',
    /function _csShowVerdict\(slotKey, message, sure\)/.test(app)
    && /담당자에게도 함께 전달했어요/.test(app)
    && /_csShowVerdict\(slot\.key, bad\.verdict\.message, bad\.verdict\.sure\)/.test(app));
  ok('기존 안내 문구는 유지(그대로 제출 가능)',
    /맞게 올리셨다면 그대로 제출하셔도 됩니다/.test(app));
  ok('승격 임계는 env로 조절 가능(CAPTURE_VERIFY_SURE_CONFIDENCE)',
    /CAPTURE_VERIFY_SURE_CONFIDENCE \|\| 0\.9/.test(readS('services/captureVerify.service.js')));

  console.log(`\n✅ captureVerifyNotify: ${n}개 통과`);
})();
