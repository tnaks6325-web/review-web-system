/**
 * workOrderNotify.test.js — 작업오더 도착 알림(우측하단 카드+OS 알림+상세 팝업) 구조 회귀가드 (소스 grep)
 * 실행: node tests/workOrderNotify.test.js
 *
 * 고정하는 것:
 *  - 서버: 신규 제출(submit/intake)·보완 재제출(my/update revision→submitted) 시 SSE work_order_new 발신
 *  - 페이로드 최소화: emit 헬퍼가 리뷰가이드/유입가이드 본문을 싣지 않음 (상세는 admin API로 조회)
 *  - 프론트: SSE 리스너 등록 + 단일 진입점(_woCheckNewOrders) 수렴 + 2분 폴링 폴백
 *  - 알림 카드는 자동 소멸 없음(클릭해야만 닫힘), 확인 기록은 localStorage(재접속에도 유지)
 *  - OS 알림 requireInteraction:true + 오더별 tag(중복 방지), 클릭 → 상세 모달
 *  - 구 중앙 팝업(_showNewOrderPopup) 완전 제거
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readSrv = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const sse = readSrv('utils/sse.js');
const orderRoutes = readSrv('routes/order.routes.js');
const app = readF('js/index-app.js');
const pay = readF('js/index-payment.js');

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
  const idx = orderRoutes.indexOf('resubmitted: true');
  ok('order: 재제출 emit(resubmitted:true)은 revision 복귀 문맥',
    idx > 0 && orderRoutes.slice(Math.max(0, idx - 400), idx).includes("cur[0].status === 'revision'"));
}

// ── 프론트: index-payment.js (SSE 수신) ──
ok('pay: 이벤트 배열에 work_order_new 등록', /'order_update', 'work_order_new'/.test(pay));
ok('pay: _SSE_ICONS에 work_order_new 항목', /work_order_new:\{ icon/.test(pay));
ok('pay: 수신 시 _onWorkOrderNewSSE 훅 호출(가드 포함)',
  /evtType === 'work_order_new'[\s\S]{0,200}_onWorkOrderNewSSE === 'function'/.test(pay));

// ── 프론트: index-app.js (카드·seen·모달·폴링) ──
ok('app: 확인 기록 localStorage 키(wo_notif_seen_v1) — 재접속에도 미확인 유지', /wo_notif_seen_v1/.test(app));
ok('app: seen 프루닝 = 생존 교집합(현재 submitted 목록 기준)', /function _woSeenPrune\(liveIds\)/.test(app));
ok('app: OS 알림 requireInteraction:true (클릭 전까지 유지)', /requireInteraction: true/.test(app));
ok('app: OS 알림 오더별 tag(중복 방지)', /tag: "wo_" \+ o\.id/.test(app));
ok('app: OS 알림 4건 이상 = 요약 1건(알림 폭탄 방지)', /toNotify\.length > 3\) _woSendDesktopNotifBatch/.test(app));
ok('app: 카드 클릭 → 확인 + 상세 모달', /function _woNotifCardClick\(id\) \{[\s\S]{0,200}openWoDetailModal\(id\)/.test(app));
ok('app: 상세 모달은 _woDetailHtml(내용 전체) + 메모로그 렌더',
  /function openWoDetailModal[\s\S]*?_woDetailHtml\(o\)/.test(app)
  && /function openWoDetailModal[\s\S]*?_woMemoLogInner\(o\)/.test(app));
ok('app: 폴링 폴백 = setInterval(_woCheckNewOrders)', /setInterval\(_woCheckNewOrders, _WO_BADGE_POLL_MS\)/.test(app));
ok('app: SSE 재제출 수신 시 seen 해제 후 재알림', /data\.resubmitted\) _woSeenRemove\(data\.id\)/.test(app));
ok('app: 구 중앙 팝업(_showNewOrderPopup) 완전 제거', !/_showNewOrderPopup/.test(app));
ok('app: 구 카운트 증가 감지(_woLastNewCount) 제거', !/_woLastNewCount/.test(app));
// 카드에 자동 소멸 타이머 없음 (클릭해야만 닫힘)
{
  const m = app.match(/function _woRenderNotifCard\([\s\S]*?\n\}/);
  ok('app: 알림 카드에 자동 소멸 setTimeout 없음', !!m && !/setTimeout/.test(m[0]));
}
// 로그아웃 시 잔존 카드 정리
ok('app: stopWorkOrderBadgePoll이 알림 스택 클리어',
  /function stopWorkOrderBadgePoll\(\) \{[\s\S]{0,400}woNotifStack[\s\S]{0,200}innerHTML = ""/.test(app));

console.log(`\n✅ workOrderNotify: ${passed}개 통과`);
