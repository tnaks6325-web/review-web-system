# 세션 작업 보고서 (교차검증용) — 구글 시트 쿼터 사고 대응 & order-ledger 배포

> 목적: **다른 세션이 이 세션의 진단·결정·배포를 독립적으로 교차검증**하기 위한 자기완결 기록.
> 모든 주장에 검증 가능한 근거(커밋 SHA·PR·운영 데이터·재조회 방법)를 붙였다.
> 작성 2026-06-26 · 저장소 `tnaks6325-web/review-web-system`

---

## 0. 교차검증 빠른 시작 (검증자가 먼저 할 것)

운영 API: `https://sublime-magic-production-790b.up.railway.app` (로그인 `POST /api/admin/login` `{name, pw}` → `token` → `Authorization: Bearer`; 자격증명은 사용자 보유, 본 문서 미기재).

독립 재확인 항목:
1. **사고 근거 재조회**: `GET /api/admin/error-logs?status=all&category=quota` / `category=timeout` → §2 수치 대조.
2. **중복 재실측**: `GET /api/diag/viewer-data?sheetId=1JqV25Q1VtkhvY_A8gCrTA22ZrQRkIR9TvbZpqMe0ZKI&tabName=<6/25 공영쇼핑 탭>` → 주문번호 기준 중복 그룹 카운트(§2).
3. **머지 산출물**: `git show 9f83da6`(#135 머지), `git log origin/main` 에 035/orderLedger 존재(§3).
4. **마이그 멱등성/원자성**: `server/migrations/035_*.sql`, `server/src/services/orderLedger.service.js`의 `claimRow`·`createOrderLedgerEntry` 정독(§3·§6).
5. **단위테스트 재실행**: `node server/tests/orderLedger.test.js` → "orderLedger tests passed".
6. **배포 상태**: `GET /health`(db connected), `GET /api/diag/sync-queue`, `GET /api/raw/status`.

---

## 1. 타임라인 (이 세션이 한 일)

1. **진단**: 6/25 구매폼 딜레이·중복·재제출 신고 → 운영 로그/시트 직접 조회로 원인 확정(§2).
2. **1차 수정안 PR #116**(이 세션): `033_sheet_row_claims` + `sheetRowClaim.service` 원자적 행 점유 + 신원 즉시기록. code-reviewer 검토(H1/M2) 반영. → **이후 #135로 대체되어 CLOSE**.
3. **사고/인수인계 보고서 작성** → 다른(codex) 세션이 더 완성도 높은 DB-원장화 구현.
4. **codex PR #135 라인 리뷰**: HIGH-1(내구성 롤백)·MEDIUM-1(가드 덮어쓰기) 필수수정 지적 → codex 반영(커밋 `820c072`) → 재검토 통과 + LOW(가드 자기-재시도) 발견.
5. **후속 PR #142**(이 세션): 가드 자기-재시도 수정(`guardBlocksWrite`) + 리뷰제출 DB화 설계안.
6. **머지·배포·카나리 검증**: #142→codex, #135→main(운영 배포), 035 적용·HIGH-1 동작 양성 확인. 아침 러시 모니터 예약(§5).

---

## 2. 진단 — 사고 원인 (운영 실데이터)

**인과 사슬**: 아침 동시 제출 폭주 → 빈행 탐색용 시트 통읽기(`A1:ZZ500`)×N → **구글 Sheets 읽기 쿼터(기본 300/분) 고갈** → 시트 쓰기 15초 타임아웃 → 백그라운드 큐(`order_append`) 적체 → 3분 캐시 빈행 스캔 동시 경합(같은 행 덮어쓰기) + 큐 경로 중복차단 부재로 **행 증식** → 시트 반영 지연 → 리뷰폼 이름 미표시 → 재제출 → 렉.

**근거 수치(error_logs/실측, 검증자 재조회 가능)**:
- 쿼터 33회: `Quota exceeded 'Read requests'` 24(시스템14+구매9+리뷰1), `Resource exhausted` 8, SA storage 403 1. 폭주 구간 **6/25 06:37–06:57 KST**(UTC 21:37–21:57), 카톡 신고 시각과 일치.
- 타임아웃 149회: 리뷰제출 시트쓰기 63, 구매양식 시트쓰기 58, Gemini 28.
- `order_submit/sheet_write "동시 제출 감지"` 누적 276회(전부 사고 시트; 6/26 시점 344로 증가 관측).
- 문제 탭 실측 중복: **25개 주문 그룹 중복(3회중복 4 + 2회중복 21), 잉여 29행 = 데이터 199행의 14.6%**.

관련 문서(이전 세션, **CLOSED PR #116 브랜치에만 존재 — main 미반영**): `docs/2026-06-25_sheets-quota-incident-report.md`, `docs/2026-06-25_handoff-quota-and-sql-migration.md`.

---

## 3. 무엇이 머지·배포됐나 (사실)

**main 머지 = 운영 자동배포(Railway+Cloudflare).**

| PR | 내용 | 결과 |
|---|---|---|
| **#116** (이 세션) | 033 sheet_row_claims + sheetRowClaim.service | **CLOSED**(#135로 대체). main 미반영 |
| **#135** (codex) | order-ledger: DB 우선 저장 + RAW 헤더 기반 행 배정 + 미러 큐 + 035 마이그 | **MERGED→main**, 머지커밋 `9f83da6` |
| **#142** (이 세션) | 가드 자기-재시도 수정 + 리뷰제출 DB화 설계안 | **MERGED→codex**(squash `2f9201e`) → #135 통해 main 반영 |

**#135가 main에 가져간 실제 변경(검증자 확인)**: `git diff e7d07a4...codex` 기준 순수 order-ledger 2커밋(`2baf2f7` persist, `820c072` preserve-on-claim-failure) + #142 1커밋, **서버 10+파일**. (#132/133/134 등은 그 사이 main에 별도 머지돼 #135 범위엔 없음 = 스코프 혼재 없음.)

핵심 파일(현재 main 존재 확인됨):
- `server/migrations/035_order_ledger_and_raw_headers.sql` — `sheet_row_claims`(행/주문 2중 유니크), `order_submissions` 확장(tab_gid/sheet_row/dedup_key/bank…/mirror_status/sheet_error/queued_at), `raw_sheet_tabs.detected_headers`. **멱등 DDL**(ADD/CREATE … IF NOT EXISTS), 단일 파일 1트랜잭션(부분적용 없음).
- `server/src/services/orderLedger.service.js` — `computeDedupKey`/`claimRow`/`createOrderLedgerEntry`/`buildMirrorGuardRange`/`guardBlocksWrite`/`recordReviewIdentity`/RAW 컨텍스트 로더.
- `server/src/routes/submit.routes.js`(POST /order DB우선), `server/src/services/syncQueue.service.js`(order_append: RAW헤더+가드, 시트 통읽기 제거), `cron.js`(5분 미러+버킷 스킵), `sheetsThrottle.js`(45/min).

---

## 4. 리뷰 발견·수정 이력 (교차검증 핵심)

이 세션이 #135를 라인 리뷰해 남긴 지적과 그 처리:

- **HIGH-1 (내구성 롤백 회귀)** — 초기 `createOrderLedgerEntry`가 INSERT+claim을 한 트랜잭션에 묶어, claim 일시오류 시 주문 INSERT까지 롤백·사용자 실패. → **수정됨(`820c072`)**: 주문 INSERT를 **트랜잭션 밖에서 먼저 커밋**, 행 배정은 별도 try/catch, 실패 시 `pending_no_row` 강등(제출 보존). **운영 카나리에서 양성 확인**(§5).
- **MEDIUM-1 (가드 덮어쓰기)** — order_append가 라이브 셀 확인 없이 써서 stale RAW + 외부 기입 덮어쓰기 위험. → **수정됨(`820c072`)**: 쓰기 직전 가드 셀 1칸 readSheet.
- **LOW (가드 자기-재시도 오탐)** — 가드가 "비어있지 않으면 차단"이라 자기 1차 쓰기 후 재시도 시 자기값을 외부기입으로 오인. → **이 세션 PR #142에서 수정**: `guardBlocksWrite`(빈칸/내값=통과 멱등, 다른값=차단), 연락처는 숫자만 비교. 단위테스트 추가.
- 비블로커(검증자 판단 권장): ① `order_submissions` 진짜 중복제출 시 원장 2행(시트는 claim으로 1행) — **감사 흔적으로 의도, 제거 안 함** ② 리뷰제출 경로는 여전히 시트 직접 read/write(다음 증분, 설계안 §아래) ③ `sheet_row_claims` TTL 없음(무한 증식) ④ dedup_key 약fallback에 옵션 포함.

**원자성 주장(검증자 정독 권장)**: `claimRow`는 `INSERT … ON CONFLICT DO NOTHING RETURNING`(2개 유니크: 행 / dedup_key)으로 ① 두 주문이 같은 행 점유 불가 ② 한 주문이 두 행 점유 불가 보장. 충돌 시 dedup 재조회로 "내 행" 반환(멱등). INSERT throw(일시오류)는 호출자로 전파(거짓 소진 방지). → 동시성 정확성의 근거.

---

## 5. 머지·배포·카나리 검증 결과

- **#142→codex**(squash `2f9201e`), **#135→main**(merge `9f83da6`) 머지. 21:0x KST 한산시간(주문은 아침에 몰림) 카나리.
- **배포 무결성**: `/health` 새 컨테이너·db connected·Sentry active. 배포(12:01 UTC) 이후 신규 오류 0. sync_queue pending 0/done 263/failed 1(기존 별건). RAW 990탭·144k행.
- **마이그 035 양성 확인**: 가짜 sheetId로 canary 주문 1건 제출 → `dbSaved:true`(신규 컬럼 전부 포함 INSERT 성공) + `mirrorStatus:"pending_no_row"`(행 배정 실패에도 제출 보존=HIGH-1 동작). 
  - canary 흔적: `order_submissions` 1행, `sheet_id='ZZZ_CANARY_035_CHECK_DELETE_ME'`, `orderSubmissionId=162136bf-48a0-4c08-b055-7c0cec02fda3`. **시트/캠페인 영향 없음**. 정리: `DELETE FROM order_submissions WHERE sheet_id='ZZZ_CANARY_035_CHECK_DELETE_ME';` (claim/큐 흔적 없음).
- **미완**: 진짜 동시성 검증은 **내일 아침 홈쇼핑 러시**. 자동 모니터 예약(07:10 KST, 세션 한정 cron): order_submit 쿼터·타임아웃·동시제출·claim_failed·pending_no_row 재발 점검 후 "성공/재발" 보고.
- 롤백: 머지 `9f83da6` revert(035 additive라 잔존 안전).

---

## 6. 교차검증 시 집중 점검 포인트 (의심 우선순위)

1. **claimRow 동시성**: 다중 인스턴스(Railway 스케일아웃) 환경에서 단일 프로세스 가정이 깨지지 않는지 — 점유는 DB 유니크라 다중 인스턴스에도 유효하나, `submit.routes`의 `withTabLock`(프로세스 내 직렬화)은 인스턴스 간엔 무효. 동시성 보호의 최종 보루가 DB 유니크임을 확인.
2. **RAW 미러 staleness(≤5분) + 가드**: stale 사이 외부 수동편집 덮어쓰기 위험의 잔여도. 가드 셀(연락처) 1칸 비교가 충분한지(다중 슬롯/주소만 채운 행 등 엣지).
3. **HIGH-1 재현**: claim 트랜잭션이 throw해도 `order_submissions`가 남는지 실제 DB로 재현.
4. **035 멱등·재적용**: 재기동 시 035 재실행이 무해한지(_migrations 추적 + IF NOT EXISTS).
5. **pending_no_row 운영 가시성**: RAW 메타 없는 활성 탭의 제출이 시트에 영영 안 뜨는 사일런트 누락 방지책(라이브 폴백 성공률, 관리자 노출 부재).
6. **dedup_key 신뢰도**: 주문번호 없는 캠페인 존재 시 fallback(`수취인|연락처8|날짜|옵션`)의 충돌/누락.
7. **원장 중복행**: 진짜 중복제출 시 order_submissions 2행이 다운스트림(통계/중복검사)에 주는 영향.

---

## 7. 산출물 색인

- 머지커밋: #135 `9f83da6`(main), #142 squash `2f9201e`(codex). order-ledger: `2baf2f7`,`820c072`. 가드수정 `6090594`(PR #142 head).
- 문서(main 반영): `docs/2026-06-26_design_review-submit-db-ledger.md`(리뷰제출 DB화 설계안, 다음 증분).
- 문서(CLOSED #116 브랜치 `claude/sweet-turing-oookis`만, main 미반영): `docs/2026-06-25_sheets-quota-incident-report.md`, `docs/2026-06-25_handoff-quota-and-sql-migration.md`.
- 본 보고서: `docs/2026-06-26_session-report-order-ledger-crossval.md`.
- PR: #116(closed), #135(merged), #142(merged→codex).

## 8. 정리/후속
- [ ] canary 테스트 행 1건 삭제(§5 SQL).
- [ ] 아침 러시 모니터 결과 확인(자동 보고 예정).
- [ ] (다음 증분) 리뷰제출 DB화 — 설계안의 smartBuild 보존 규칙 최우선.
- [ ] (후속) sheet_row_claims TTL/정리 잡, read/write throttle 분리, 이미지 업로드 OAuth(SA 403).
