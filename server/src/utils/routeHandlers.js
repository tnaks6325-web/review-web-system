/**
 * routeHandlers — 라우터 모듈이 다른 라우터(Track B 프록시)에 핸들러를 **이름으로** 내주는 장치(결정 270).
 *
 * 배경: trackB.routes.js 의 옛 `_delegate(router, method, path)` 는 남의 라우터 스택을 **경로 문자열로** 뒤져
 *   마지막 핸들러를 꺼냈다. 그래서 옛 공개 경로 한 줄을 지우면 서버가 기동 시 throw 했고, 옛 관리자 대시보드
 *   전용 경로를 지울 수 없었다. 지금은 각 라우터 모듈이 `router.handlers.<이름>` 으로 핸들러를 내보내고
 *   trackB 는 그 이름을 직접 가리킨다 — 옛 공개 경로가 있든 없든 Track B 동작은 같다.
 *
 * `lastRouteHandler(router)` = 방금 등록한 라우트의 마지막 핸들러(= 실제 처리 함수, 앞은 authMiddleware 등).
 *   등록 바로 다음 줄에서 부른다 — 경로 문자열을 다시 적지 않으므로 경로를 바꿔도 어긋나지 않는다.
 *   마지막 스택이 라우트가 아니면(중간에 router.use 가 끼면) 기동 시 바로 throw 한다(fail-closed).
 */
function lastRouteHandler(router) {
  const layer = router && router.stack && router.stack[router.stack.length - 1];
  if (!layer || !layer.route) throw new Error('[routeHandlers] 직전에 등록된 라우트가 없습니다');
  const stack = layer.route.stack;
  const fn = stack[stack.length - 1] && stack[stack.length - 1].handle;
  if (typeof fn !== 'function') throw new Error(`[routeHandlers] 핸들러를 찾지 못함: ${layer.route.path}`);
  return fn;
}

module.exports = { lastRouteHandler };
