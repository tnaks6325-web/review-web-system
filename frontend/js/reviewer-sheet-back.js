/* 리뷰어 홈 — 휴대폰 뒤로가기로 열린 창 닫기 (결정 372)
 *
 * 창(시트·팝업)이 열릴 때 같은 주소로 히스토리 한 칸을 쌓는다(결정 078 과 같은 방식 — 주소는 그대로).
 * 뒤로가기(popstate)가 오면 맨 위 창 하나만 닫고 홈에 남는다.
 * 창을 제 단추로 닫으면 쌓아 둔 칸을 조용히 되돌린다 → 그다음 뒤로가기 한 번에 페이지를 떠난다(두 번 누르기 없음).
 *  · 같은 창을 다시 열면(내용만 바꿈) 칸을 더 쌓지 않는다.
 *  · 닫자마자 다른 창을 열면(경고 → 참여상품 정보, 참여상품 정보 → 1:1 대화) 칸을 되돌리지 않고 새 창이 이어 쓴다.
 *  · 창을 연 채 다른 화면으로 가는 단추는 leave(url) — 창 칸을 그 주소로 바꿔(location.replace) 돌아왔을 때 헛 칸이 남지 않는다.
 *  · 창을 연 채 새로고침하거나 「앞으로」로 닫힌 창 칸에 돌아오면 칸만 남는다(창은 없음). 그 칸에서 뒤로가기가
 *    아무것도 닫지 못하면 한 번 더 뒤로 가서 「한 번 눌러 떠나기」를 지킨다. 첫 창을 열 때의 깊이를 기준으로 센다.
 *  · 하단 탭 전환은 쌓지 않는다.
 * history API 가 없거나 막히면 아무 일도 하지 않는다(창은 단추로 종전처럼 닫힌다).
 */
(function (w) {
  'use strict';
  if (!w || w.RhSheetBack) return;
  var KEY = 'rhSheetDepth';
  var stack = [];       // 열린 창 [{ id, close }] — 맨 뒤가 맨 위
  var base = 0;         // 첫 창을 열 때의 칸 깊이(새로고침 뒤 남은 칸 위에서도 셈이 맞게)
  var owed = 0;         // 단추로 닫혀 되돌려야 할 칸 수
  var timer = null;
  var leaving = false;
  var selfNav = false;  // 되돌리기(go(-n))가 일으킨 popstate 는 사람의 뒤로가기가 아니다
  var lastDepth = 0;

  function depthOf(state) {
    var d = state && state[KEY];
    return typeof d === 'number' && d > 0 ? d : 0;
  }
  function curDepth() {
    try { return depthOf(w.history.state); } catch (_) { return 0; }
  }
  function stamp(push) {
    var st = {}; st[KEY] = base + stack.length;
    lastDepth = st[KEY];
    try {
      if (push) w.history.pushState(st, '', w.location.href);
      else w.history.replaceState(st, '', w.location.href);
    } catch (_) {}
  }
  function indexOf(id) {
    for (var i = 0; i < stack.length; i++) if (stack[i].id === id) return i;
    return -1;
  }
  function flush() {
    timer = null;
    var n = owed; owed = 0;
    if (!n || leaving) return;
    selfNav = true;
    try { w.history.go(-n); } catch (_) { selfNav = false; }
  }

  function opened(id, close) {
    if (!id || indexOf(id) >= 0) return;          // 이미 열린 창 = 칸 그대로
    if (!stack.length && !owed) base = curDepth();
    stack.push({ id: id, close: close });
    if (owed > 0) { owed--; stamp(false); return; } // 방금 닫힌 창의 칸을 이어 쓴다
    stamp(true);
  }

  function closed(id) {
    var i = indexOf(id);
    if (i < 0) return;                             // 뒤로가기로 이미 빠졌거나 등록된 적 없음 → 두 번 되돌리지 않는다
    stack.splice(i, 1);
    owed++;
    if (!timer) timer = w.setTimeout(flush, 0);
  }

  function leave(url) {
    var onSheetEntry = (stack.length > 0 || owed > 0) && curDepth() > base;
    if (timer) { try { w.clearTimeout(timer); } catch (_) {} timer = null; }
    owed = 0; stack = []; leaving = true;
    try {
      if (onSheetEntry) w.location.replace(url);
      else w.location.assign(url);
    } catch (_) { w.location.href = url; }
  }

  lastDepth = curDepth();
  w.addEventListener('popstate', function (e) {
    var d = depthOf(e && e.state);
    if (selfNav) { selfNav = false; lastDepth = d; return; }
    var target = d - base;
    if (target < 0) target = 0;
    var closedAny = false;
    while (stack.length > target) {
      var top = stack.pop();
      closedAny = true;
      try { if (top && typeof top.close === 'function') top.close(); } catch (_) {}
    }
    var wasted = !closedAny && !stack.length && !owed && !leaving && d < lastDepth;
    lastDepth = d;
    // 창 없는 헛 칸에서 누른 뒤로가기 — 화면이 그대로면 한 번 더 뒤로(사람 입장에선 한 번 눌러 떠나기).
    if (wasted) { try { w.history.back(); } catch (_) {} }
  });
  // 다른 화면으로 넘어가는 중에는 되돌리기를 부르지 않는다(이동이 취소되지 않게).
  w.addEventListener('pagehide', function () { leaving = true; });
  w.addEventListener('pageshow', function () { leaving = false; });

  w.RhSheetBack = { opened: opened, closed: closed, leave: leave };
})(typeof window !== 'undefined' ? window : this);
