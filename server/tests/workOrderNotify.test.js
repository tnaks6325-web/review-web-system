/**
 * workOrderNotify.test.js — 작업오더 도착 알림(우측하단 카드+OS 알림+상세 팝업) 구조 회귀가드 (소스 grep)
 * 실행: node tests/workOrderNotify.test.js
 *
 * 고정하는 것:
 *  - 서버: 신규 제출(submit/intake)·보완 재제출(my/update revision→submitted) 시 SSE work_order_new 발신
 *  - 페이로드 최소화: emit 헬퍼가 리뷰가이드/유입가이드 본문을 싣지 않음 (상세는 admin API로 조회)
 *  - (프론트 알림 카드·OS 알림·SSE 수신은 옛 관리자 대시보드와 함께 결정 267 로 폐기 — 작업보드 nav 뱃지만 본다)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readSrv = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const sse = readSrv('utils/sse.js');
const orderRoutes = readSrv('routes/order.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 서버: sse.js ──
ok('sse: emitWorkOrderNew 정의', /function emitWorkOrderNew\(/.test(sse));
ok("sse: broadcast('work_order_new') 사용(기본 admin 필터)", /broadcast\('work_order_new'/.test(sse));
ok('sse: emitWorkOrderNew export', /module\.exports[\s\S]*emitWorkOrderNew,/.test(sse));
ok('sse: 재제출 문구 분기', /resubmitted \? ' \(재제출\)' : ''/.test(sse));

// ── 서버: order.routes.js ──
ok('order: _emitWorkOrderNew 헬퍼 + 호출 3곳(intake/submit/my-update)',
  (orderRoutes.match(/_emitWorkOrderNew\(/g) || []).length >= 4); // 정의 1 + 호출 3
ok('order: 헬퍼가 sse.emitWorkOrderNew 위임 + try/catch best-effort',
  /function _emitWorkOrderNew[\s\S]{0,600}sse\.emitWorkOrderNew\(/.test(orderRoutes)
  && /function _emitWorkOrderNew[\s\S]{0,800}logger\.warn/.test(orderRoutes));
// 페이로드 최소화: 헬퍼 본문에 리뷰/유입 가이드 본문 필드 미포함
{
  const m = orderRoutes.match(/function _emitWorkOrderNew\([\s\S]*?\n\}/);
  ok('order: emit 페이로드에 review_guide/inflow_guide 미포함(최소 필드)',
    !!m && !/review_guide|inflow_guide|special_notes/.test(m[0]));
}
// 재제출: revision→submitted 복귀 문맥에서 resubmitted:true
{
  // 재제출 알림은 AE 수정 경로(PUT /my/update)에만 있었다 (AE 수정 경로 PUT /my/update 는 staff.html 과 함께 결정 186 49번에서 제거).
  ok('order: AE 재제출 경로가 되살아나지 않았다', !orderRoutes.includes("router.put('/my/update'"));
}

// ── 프론트 ──
// 옛 관리자 대시보드 폐기(결정 267) — 도착 알림 카드·OS 알림·SSE 수신(index-app.js·index-payment.js)은 화면째 사라졌다.
//   서버 발신(work_order_new)은 그대로 남아 있다. 리뷰웹시스템[3버전]은 작업오더 nav 뱃지(🔵 대기 건수)로 보여 준다.
ok('리뷰웹시스템[3버전]: 작업오더 nav 뱃지가 대기(submitted) 건수를 그린다',
  /const n=\(STATE\.woCounts&&STATE\.woCounts\.submitted\)\|0; nb\.textContent=n>0\?\(' 🔵'\+n\):''/.test(readF('workdesk.html')));

console.log(`\n✅ workOrderNotify: ${passed}개 통과`);
