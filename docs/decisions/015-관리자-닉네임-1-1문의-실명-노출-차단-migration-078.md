# 관리자 닉네임 — 1:1문의 실명 노출 차단 (migration 078)
- **문제**: 답장은 `cs_messages.sender_name`에 **로그인 계정명(=관리자 실명)** 을 기록해 왔고 그 값이 리뷰어 대화창에 그대로 나갔다(박세희·박은비·master).
- **모델**: 계정 테이블에 컬럼을 붙이지 않고 **`admin_nicknames(login_name PK, nickname)`** 매핑 하나로 둔다 — 마스터(env 계정)·staff·인트라넷 SSO는 `admin_users` 행이 없어 로그인명 키만이 전 로그인 경로를 덮는다. 시드 = `박세희→만두`·`박은비→망고`(`utils/workManager.js`의 작업담당 닉네임과 같은 값, `ON CONFLICT DO NOTHING`으로 기존 값 보존).
- ★★ **표시 규칙(완화 금지)**: 리뷰어 화면 = `닉네임 || '관리자'` **fail-closed**(맵에 없는 값은 실명인지 판단할 수 없으므로 무조건 가림 — "설정 전까지 실명 노출"로 두면 막으려던 사고가 그대로 남는다) / 관리자 화면 = `닉네임 || 로그인명`(내부 책임추적 유지).
- ★ **저장은 로그인명 그대로, 치환은 읽는 시점**(`adminNickname.service.maskMessages`) — 그래서 **닉네임을 바꾸면 이미 보낸 답장의 이름까지 함께 바뀐다**(이미 노출된 이름을 되돌릴 유일한 방법). 소비처 3곳: `/api/cs/messages`(admin) · `/api/reviewer/cs/messages`(reviewer) · **`emitCsReplyToReviewer` SSE 푸시**(목록 API만 막으면 실시간 푸시로 샌다).
- **설정**: 관리자 설정탭 "내 닉네임" → `GET/POST /api/admin/my-nickname`(authMiddleware, **대상은 항상 `req.admin.name` = 본인**, body로 남의 닉네임 변경 불가). 로그인명과 같은 닉네임은 거부(실명 우회 저장 차단), 20자 상한, 빈 값 저장 = 해제(리뷰어에겐 '관리자'). `/api/admin/*` 경로라 `via:'intranet'`·`'reviewer_campaign'` 스코프 토큰은 도달 불가. 맵은 60초 캐시(저장 시 무효화), 조회 실패는 fail-soft(대화는 계속 뜬다).
- 회귀가드 `tests/adminNickname.test.js`.
