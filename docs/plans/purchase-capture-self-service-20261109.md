# 구매캡처 셀프 보완 — 승인 범위와 구현 계약
## 운영 반영 승인 후 재통합
- 사용자 「운영에 반영해」 및 「기존 운영 수정 유지하고 합쳐 반영」 승인. 최신 main 기반 별도 release 작업폴더에서 재통합했다.
- 기존 결정 355의 shared dualCaptureComplete 판정·옛 캐시 fallback과 결정 356 차례 타이머는 유지한다. 새 화면은 인증된 새 목록을 사용하고 옛 목록에 의존하지 않는다. 기존 SQL 소비처 검사는 판정 의미를 유지하도록 재연결했다.
- 이미 점유된 217/218 대신 새 저장 공간은 219/220, 결정은 357로 조정했다. 기존 번호의 운영 기능·마이그레이션을 수정하지 않는다.
- 전체 저장소 검사·배포 확인은 이 재통합 버전에서 별도로 수행한다.


## 사용자 확정
- 승인 시안: `~/Documents/리뷰어-구매양식-UI계획/2026-11-09-캡처-셀프보완-v1/`.
- 사진 수 확대: 기존 첫째/둘째 사진은 덮거나 지우지 않고, 제출 후 추가 사진을 별도 원장에 누적한다. 일반 주문과 네이버·쿠팡 묶음 모두 포함한다.
- 직원은 기존 C/S 문의함에서 보완 사유와 사진 확인 완료를 남긴다. 리뷰어 화면은 그 결과를 표시한다.
- 사진 확인은 기존 명의 승인·리뷰 완료·입금 승인과 별개다. 확인 요청·추가 첨부·사진 확인만으로 이들 상태를 갱신하지 않는다.
- 사진 접수/실패/연결 불명과 직원 확인 상태는 서로 다른 축이다. 일반 주문에 없는 기존 최종 확인 기록을 만들어내지 않는다.
- 운영 반영 전에 실제 연결된 리뷰어 화면과 새 직원 처리 부분을 함께 미리보기로 확인받는다.

## 구현 순서와 소유권
1. 새 조회·사진 추가·강한 주문 소유권·사진 원장: core 작업자. migration 219 예약.
2. C/S 확인요청·중복방지·직원 처리: checks 작업자. migration 220 예약.
3. 승인된 모양의 새 JS/CSS 모듈: UI 작업자. 공유 HTML·라우트는 변경하지 않음.
4. 부모: 공용 라우트·리뷰어 홈·직원 문의함 연결, 스키마/사진 허용목록/삭제 분류 최종 점검, 실제 응답×실제 모듈 통합 시험, 전후 미리보기.
- 새 결정 문서 355는 부모만 작성. 번호는 통합 직전 최신 main·열린 PR과 다시 대조한다.
- 기능 브랜치 기준: a0a84cb8 (main 0e646992 + 사용자 승인된 문자규격 강제 제거).
- 현재 단계에서는 푸시·PR·머지·운영 자료 쓰기 금지. 테스트는 가짜 데이터·별도 로컬 DB와 가짜 Drive만 사용한다.

## 공통 데이터 계약
- `channel`: 일반 주문 `single`, 묶음 `naver`/`coupang`. 주문 종류와 허용 구매처는 서버가 확정한다.
- 공개 item: `{orderSubmissionId, displayName, participantName, channels:[channelView]}`.
- channelView: `{channel,label,photos:[{id,fileId,createdAt,isSupplement}],evidenceHash,saveState,reviewState,reason,request,capabilities}`.
- `saveState`: `saved|failed|unknown|missing|uploading`. 실패 근거 없이 failed/missing으로 만들지 않음. saved는 DB 연결 기록이며 실제 이미지 접근 실패는 화면에서 연결 확인 불가로 별도 안내한다.
- `reviewState`: `not_requested|pending|needs_photo|confirmed`. 단순 AI 정상이나 리뷰 제출완료로 사진 최종 확인을 만들지 않음. 원본 묶음 명의 확인 대기는 별도 안전한 문구로 안내한다.
- request: null 또는 `{id,status,createdAt,updatedAt,note}`. 리뷰어에게 직원 실명·원문 AI·계좌·전체 연락처는 반환하지 않음.
- capabilities: `{canAdd,canRequestCheck,reason}`. 조회와 쓰기의 판정을 같은 함수로 계산한다. 없는 기능을 기존 업로드로 우회하지 않음.
- evidenceHash: 해당 주문·구매처의 원본 현재 파일/버전 + 추가사진 ID/파일/해시를 안정적으로 정렬하여 서버 계산. C/S 확인의 CAS 기준이며 기존 지급 증빙 해시를 대체하지 않음.

## HTTP 계약 — 부모가 라우트를 연결
모든 리뷰어 경로는 `reviewerSessionMiddleware`와 현재 탭의 X-Reviewer-Token으로 인증한다.
- GET `/api/reviewer/purchase-captures`: `{ok:true,items,hasMore}`. 홈에는 조치가 필요한 항목을 표시하되 전체 건수인 척하지 않는다. 오래된 정상 이력을 불필요한 새 독촉으로 만들지 않는다.
- GET `/api/reviewer/purchase-captures/:orderId`: `{ok:true,item}`.
- POST `/api/reviewer/purchase-captures/:orderId/supplements`: 허용 body `{channel,imageBase64,mimeType,requestKey,expectedEvidenceHash}`. 결과 `{ok:true,item,request}`. 실제 사진 추가와 필요한 사진 확인요청/C/S 메시지를 같은 트랜잭션으로 저장한다.
- POST `/api/reviewer/purchase-captures/:orderId/check-requests`: `{channel,expectedEvidenceHash,note}` → `{ok:true,request,item,created}`.
- GET `/api/trackb/purchase-capture-checks/:requestId`: 내부 직원 전용 `{ok:true,request,item}`.
- POST `/api/trackb/purchase-capture-checks/:requestId/decision`: 내부 직원 전용 body `{decision:'needs_photo'|'confirmed',note,expectedEvidenceHash}` → `{ok:true,request,item}`. 보완 사유는 필수. 다른 사진 버전에 대한 늦은 확인은 거부한다.
- 오류는 `{ok:false,code,error}`, 401/403/404/409/413/503 의미를 보존. 내부 오류는 쉬운 문구로 숨긴다.

## core 서비스 계약
신규 `server/src/services/purchaseCaptureSelfService.service.js`:
- `createService({db,drive,requestInTx?})`를 내보내며 테스트는 DB·Drive를 주입한다.
- 인스턴스 및 production wrapper: `listForReviewer({session,limit})`, `getForReviewer({session,orderSubmissionId})`, `addSupplement({session,orderSubmissionId,channel,imageBase64,mimeType,requestKey,expectedEvidenceHash})`.
- checks가 재사용할 함수: `withOrderTransaction({session,actor,orderSubmissionId,forStaff=false},run)`. run은 `(client,context)`를 받는다. 기존 일반 주문 잠금과 묶음 lifecycle·행 잠금 순서를 지킨다. actor만으로 reviewer 권한 우회 금지, forStaff는 허용된 내부 역할 actor를 검증한다.
- context는 `{order,channels,evidenceByChannel,displayName,participantName,session,actor}`. `evidenceByChannel[channel]`은 `{evidenceHash,photos,...}`. 주문 원본·실제 연결에서 도출하며 HTTP 내부필드를 신뢰하지 않음.
- `inspectInTx(client,{session,actor,orderSubmissionId,forStaff=false})`와 `viewInTx(client,context)`를 내보낸다. 전자는 소유권과 상태를 다시 읽고 후자는 공개 item을 만든다.
- addSupplement는 새 파일의 임시 저장 뒤 잠금 안에서 다시 검증→추가사진 INSERT→context 재조회→checks의 `requestInTx(client,{context,channel,note})`를 호출한다. 순환 import를 피하도록 요청 시 lazy require 또는 의존성 주입한다.
- 새 request만 생성됐다는 알림 정보는 응답 내부에 둘 수 있으나 공개 응답에는 내부 actor/phone을 노출하지 않는다. 외부 웹훅 자동 호출 금지.

## checks 서비스 계약
신규 `server/src/services/purchaseCaptureCheck.service.js`:
- `createService({db,core?,notify?})` 및 production wrapper.
- `requestCheck({session,orderSubmissionId,channel,expectedEvidenceHash,note})` → `{request,item,created}`.
- `getForStaff({actor,requestId})` → `{request,item}`.
- `decideForStaff({actor,requestId,decision,note,expectedEvidenceHash})` → `{request,item}`.
- `requestInTx(client,{context,channel,note})` → `{request,created}`. core.context의 현재 증빙 해시를 사용. 같은 주문/구매처/해시의 요청은 기존 것을 돌려주며 새 메시지·미확인수·알림을 만들지 않는다.
- 기존 cs_threads/cs_messages에 연결. msg_type='text', meta에 `{purchaseCaptureCheck:{requestId,orderSubmissionId,channel,evidenceHash,status}}`. 구화면도 읽을 수 있는 한국어 content를 넣는다. thread key·이름·작업 라벨은 서버 context에서 도출.
- 스레드+요청+메시지·미확인수는 한 트랜잭션. 확인 결과 메시지의 표시명은 '담당자', 내부 actor는 별도 요청 이력에만 보관.
- reviewer request 또는 사진 확인의 기록만 쓴다. `purchase_identity_review`, `purchase_identity_result`, 지급·리뷰 상태 쓰기 0.
- 다른 사진이 추가되어 현재 해시가 달라진 요청에 대한 결정은 409. 현재 사진을 다시 본 뒤 새 요청을 처리한다.

## UI 모듈 계약
신규 `frontend/js/reviewer-purchase-capture.js`/`frontend/css/reviewer-purchase-capture.css`:
- `window.ReviewerPurchaseCapture.mount({container,user,getToken,apiBase,onOpenThread?})`, `open({orderSubmissionId,user,getToken,apiBase})`, `reset()`.
- getToken은 현재 탭의 신원 snapshot에 대한 토큰을 Promise로 반환한다. API 호출의 계정·주문·요청 세대 방어를 둔다.
- 홈 목록과 단건 시트에서 동일 renderer 사용. 상태/가능 동작은 위 공개 계약만 읽는다. 401은 로그인 갱신 후 최대 한 번, 실패를 빈 목록으로 바꾸지 않음.
- 사진 추가는 새 append 경로만 사용. ImageShrink가 있으면 기존 축소 유틸을 재사용한다. requestKey는 요청별 random UUID로 재시도 동안 유지. 응답 소실은 재조회하고 이미 접수된 사진을 성공으로 오인하지 않음.
- 추가 사진 수는 기존 두 장 제한을 적용하지 않고 가로 썸네일 목록으로 보여준다. 원본/추가 구분. 임의로 최종 승인하지 않음.
- 직원 모듈 `window.PurchaseCaptureStaff.open({requestId,apiBase,getToken,onChanged?})`. 기존 문의함 메시지의 meta.requestId에서 부모가 연다. 사진 보기·보완 사유 입력·사진 확인 완료. '명의/입금 승인은 별도' 안내를 유지한다.
- 직원 부분은 신규 같은 JS 파일 안에 넣어도 되며 reviewer/staff API·토큰·상태는 분리한다. 공유 HTML은 부모만 편집한다.

## 필수 검증
- RED→GREEN: 묶음 사진 2개가 이미 저장됐는데 기존 누락 알림에 뜨는 경우.
- 일반/묶음의 기존 사진 2개 이상에서도 새 사진 추가, 원본/배송메모/다른 구매처 불변.
- 타인 주문·타계정 다른 명의·취소된 주문·잘못된 구매처·잘못된 사진/과대 본문 거부.
- 같은 업로드 재시도·두 탭 동시 요청·COMMIT 응답 소실·늦은 실패. DB 반영 불명은 파일 보존.
- 요청 중복은 새로고침·동시 호출에도 메시지/미확인 증가 1회. 직원 결과는 원자적이고 다른 버전 확인 거부.
- 요청·추가·직원 사진 확인 후 기존 명의 승인·리뷰 완료·지급 기록 불변.
- 실제 서비스 응답 × 실제 프론트 모듈, 본인 인증된 HTTP 흐름, 크롬·사파리 엔진 PC/휴대폰, 외부 접속 0.
- 새 사진 원장의 image allowlist/삭제 분류/required schema는 부모가 마지막에 별도로 확인한다.

## 승인 후 동시 처리 보강
사용자 「진행해」 승인 뒤 공통 capture advisory lock을 재사용해 추가 접수와 삭제를 직렬화했다. 조기 주문 행 잠금은 이름 변경의 review→order 순서와 새 교착 가능성이 있어 채택하지 않았다. 실제 로컬 PostgreSQL에서 전체 core·삭제·이름변경 서비스를 겹쳐 실행한 16경우와 관련 검사 38파일이 통과했다. 독립 최종 코드 검토도 통과했으며 운영 미반영이다. 결정 357 및 capture-native-full-service-green.json을 참조한다.

## 최초 후속 안전검사 RED 기록
별도 안전 연결을 로컬 통합하고 신규 7개 SQL 검사를 재실행해 통과했다. 그러나 실제 로컬 PostgreSQL 16.15의 두 연결로 생산 tombstone SQL과 주문 CASCADE 사이에 추가사진을 COMMIT한 결과, 그 사진 좌표가 원장과 tombstone 양쪽에서 사라지는 RED를 확인했다. 운영 접속 없이 임시 클러스터만 사용했고 즉시 중지했다. 이때는 보강 미적용으로 배포를 보류했으며, 뒤이어 사용자 승인을 받아 위 보강을 적용했다. 결정 357 및 승인 시안 폴더의 capture-delete-race-result.json을 참조한다.

## 로컬 연결 검증 결과 (2026-11-09)
- 실제 production wrapper + JWT HTTP + core/checks + 실제 migrations 030/080/146/215/219/220 SQL(PGlite), Drive만 메모리 가짜로 실행했다. 일반/single·묶음/naver·묶음/coupang 모두 기존 2장→3장 추가, 재시도 중복 방지, 이미 제출 확인요청 중복 방지, 기존 문의방/카드 생성, 직원 사유/확인 완료 및 재조회 반영을 단언했다.
- 브라우저는 실제 index.html의 `_mountPurchaseCapture`·현재 탭 token getter·신규 renderer를 실행한다. 직원 쪽은 기존 `cs-inquiry.js`와 `api.js`를 독립 시험 호스트에 올려 실제 문의방 목록→방 선택→카드 버튼→직원 처리 창을 조작한다. workdesk 전체 화면의 로그인/배치 검증은 아니다.
- Chromium/WebKit × 390/1280 × single/naver/coupang 12/12 통과. 목록 조회·사진 업로드·문의·직원 처리의 실제 HTTP/SQL을 사용하며 fetch 대역으로 결과를 만들지 않는다. 기존 주문(명의 승인·배송메모 포함)·원본 artifacts·구매처 원장·비어 있지 않은 지급 대기/리뷰 제출 원장을 전후 비교해 보존을 확인했다.
- 통합 중 발견/수정: 정상 사진 주문이 목록에서 빠지는 막다른 길, 오래된 주문의 최근 확인 완료가 사라지는 문제, 추가 업로드의 커밋 후 신규 문의 알림 누락, 새 사진 허용목록 누락(실제 404 RED), 일반 구매사진 제목 중복. 기존 인덱스 회귀검사는 inline UNIQUE도 실제 인덱스로 인정하도록 갱신했으며 EXPLAIN 검사·이체결과 차단 의미는 불변/강화했다.
- 기록: `server/tests/purchaseCaptureIntegration.test.js`, `purchaseCaptureBrowserIntegration.test.js`, helpers 2개, `runPurchaseCapturePreview.cjs`. 전용 프론트 검사 25/25(skip 0), core 62/62, checks 16/16. 전체 집중 검사 22파일 통과; 전체 저장소 검사로 부르지 않는다.
- 스크린샷/원시 로그/집계는 저장소 밖 승인 시안 폴더의 `verification/implementation/connected-local-suite.json` 및 `verification/연결검증-결과.html`에 보존한다.
- 남음: 필수 스키마/삭제 묘비 보존을 별도 안전 작업으로 마무리 중. 실제 PostgreSQL 다중 연결 경합·실제 Drive·운영 배포는 미검증이며 push/PR/운영 쓰기는 하지 않았다. 일부 프론트 최초 구현은 동작별 검사보다 먼저 작성되어 모든 함수를 엄격한 테스트 선행으로 만들었다고 주장하지 않는다.
