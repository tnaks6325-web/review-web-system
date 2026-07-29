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

t('17. 조치 버튼(작업대 열기·취소·확인)이 표에서도 유지된다', () => {
  assert.ok(/_logOpenWorkdesk\(/.test(lgBody), '작업대 열기 버튼 유실');
  assert.ok(/_cancelLogOrder\(/.test(lgBody), '취소 처리 버튼 유실');
  assert.ok(/_resolveLog\(/.test(lgBody), '확인 버튼 유실');
  assert.ok(/_canResolveLog\(\)/.test(lgBody), '확인/취소 권한 게이트 유실(staff가 타 담당 알림을 지움)');
});

console.log('\n' + pass + ' runtime checks passed');
