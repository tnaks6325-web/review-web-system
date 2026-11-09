# 2026-11-09 동시진행 주문의 「구매캡처 없음」 오판 제거

## 적용 대상
- 본섭(main) — 리뷰어 홈 보완 목록 · 직원 리뷰어 기록 경고 · 캡처 연결 백필

## 변경
- 네이버·쿠팡 두 구매처 사진을 다 낸 동시진행 주문을 「구매 캡처 보완 필요」·「구매캡쳐를 첨부하지 않았습니다」에서 뺀다(결정 355).
- 이미 쌓인 잘못된 경고 17건은 배포 뒤 5분 주기 자동 해결이 정리한다(사용자 승인 2026-11-09).
- 사진이 정말 빠진 동시진행 주문은 리뷰어 화면에서 "담당자에게 문의해주세요" 안내(카드 모양 그대로).
- 캡처 연결 백필은 동시진행 주문을 대상에서 뺀다.

## 검증
- `server/tests/dualCaptureFalseMissing.test.js`(13) · 관련 회귀(captureRequiredFlow·reviewerTaskLabel·writtenVerify·captureLinkBackfill·purchaseCaptureSecond·reviewerLogTable) · 전체 suite.
- 운영 읽기 전용: 자동 해결 조건에 걸리는 미해결 경고 = 정확히 17건.

## 롤백
- `git revert -m 1 <머지SHA>` PR → 머지. 스키마 변경 없음(해결 처리된 경고는 되돌리지 않는다 — 오판이었다).
