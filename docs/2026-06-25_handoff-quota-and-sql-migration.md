# 인수인계 보고서 — 구글 시트 쿼터 사고 & DB(SQL) 이관

> 목적: **다른 세션이 이 문제 해결을 이어받기 위한 자기완결 컨텍스트.**
> 작성 2026-06-25 · 저장소 `tnaks6325-web/review-web-system` · 작업 브랜치 `claude/sweet-turing-oookis` · PR **#116**(draft, CI green)
> 관련 문서: `docs/2026-06-25_sheets-quota-incident-report.md`(쿼터 사고 상세 보고서)

---

## 0. 30초 요약 (이어받는 세션이 가장 먼저 읽을 것)

- **증상**: 구매폼 제출 딜레이·중복제출, 리뷰폼에 본인 이름 안 떠서 재제출 다발(6/25 공영쇼핑 캠페인).
- **확정 원인**: 제출이 매 건 **구글 시트를 읽어 빈 행을 찾는 구조** → 아침 동시 제출이 몰리면 **구글 Sheets API 분당 읽기 쿼터 고갈** → 타임아웃 → 큐 적체 → 같은 빈 행 경합 → **중복 행 14.6%** + 이름 지연 → 재제출.
- **이미 한 일**: 1차 수정 PR #116(원자적 행 점유 락 + 이름 즉시표시) 머지 대기. 쿼터 사고 보고서 작성.
- **이어서 할 일**: (단기) 쿼터 완화ⓑ·이미지 OAuthⓓ·중복 29행 정리. **(본 목표) 구글 시트 의존을 끊고 PostgreSQL을 1차 원장으로 삼는 SQL 이관.**
- **열린 결정 1개**: 사용자의 **구글 시트 직접 편집을 계속 허용할지** — 이관 범위를 좌우(아래 §7).

---

## 1. 시스템 개요 & 운영 접근법

- 백엔드: Node.js + Express + PostgreSQL → **Railway** 배포. 프론트: Vanilla JS → Cloudflare Pages. 인증: JWT.
- **프로덕션 API**: `https://sublime-magic-production-790b.up.railway.app` (이 환경에서 도달 가능; `/health` 200, `db: connected`, Sentry active).
- **운영 로그/진단 조회법**(읽기 전용):
  - 로그인: `POST /api/admin/login` body `{ "name": "master", "pw": "<관리자 비밀번호>" }` → `token` → 이후 `Authorization: Bearer <token>`.
    - ⚠️ 비밀번호는 보안상 이 문서에 미기재. 사용자가 보유(관리자 대시보드 `sessionStorage.admin_token`으로도 획득 가능). 토큰은 발급 후 약 8시간 유효, 재로그인 시 무효화.
  - 오류로그: `GET /api/admin/error-logs?status=all&category=quota|timeout&limit=...` (admin/master 전용)
  - 큐: `GET /api/diag/sync-queue` · 행점유/슬롯: `GET /api/diag/slot-locks` · 시트행 조회: `GET /api/diag/viewer-data?sheetId=&tabName=` · 통계: `GET /api/diag/stats/overview`
- 배포: `main` 머지 = 자동배포(Cloudflare Pages + Railway). 별도 빌드 액션 없음. 마이그레이션은 **서버 시작 시 자동 적용**(`server/index.js` `runMigrations`, `_migrations` 테이블로 파일별 1회, 멱등 DDL 필요).

---

## 2. 사고 — 확정된 인과 사슬 (운영 실데이터)

```
아침 동시 제출 폭주(홈쇼핑 06:30~, KST)
 → 빈행 탐색용 탭 전체 읽기(A1:ZZ500) × N건 동시
 → 구글 Sheets API 분당 읽기 한도(기본 300/분) 고갈        [error_logs quota 32회]
 → 빈행 읽기 실패 → 시트 쓰기 15초 타임아웃               [timeout: 구매58 + 리뷰63]
 → DB엔 저장됐으나 시트 반영은 백그라운드 큐로 밀림
 → 큐(order_append)엔 중복 차단이 전무 → 재제출/타임아웃마다 행 증식
 → 3분 캐시 빈행 스캔이 동시요청에서 같은 행 선택          [동시제출감지 276회]
 → 같은 빈 행(예: 58번) 덮어쓰기 + 중복 행                  [실측 29행/199 = 14.6%]
 → 시트 반영 지연 → 리뷰폼 이름 안 뜸 → 사용자 재제출       [카톡 06:57~07:04]
 → 중복 더 증가 → 관리자 수동 삭제 시 캐시·인덱스 충돌 → 렉
```

**핵심 진단**: 거의 모든 증상이 "시트를 읽어야만 동작하는 구조" 한 곳에서 파생. 쿼터 폭주 핵심 구간 **6/25 06:37–06:57 KST**(error_logs UTC 21:37–21:57을 KST 환산), 카톡 시각과 분 단위 일치.

**근거 수치(error_logs/실측)**:
- quota 33회(읽기초과 24·자원고갈 8·SA저장403 1), timeout 149회(구매58·리뷰63·Gemini28), 동시제출감지 276회(전부 사고 시트), 실측 중복 29행(14.6%).

---

## 3. 이미 한 일 (PR #116 — draft, CI green)

브랜치 `claude/sweet-turing-oookis`. 3개 커밋(기능 → 리뷰반영 → 보고서).

### 3-1. 변경 파일
| 파일 | 내용 |
|---|---|
| `server/migrations/033_sheet_row_claims.sql` | **행 점유 락 테이블**(신규, 멱등). `UNIQUE(sheet_id,tab_name,sheet_row)`=같은행 중복점유 차단(58번행), `UNIQUE(sheet_id,tab_name,dedup_key)`=같은주문 두행점유 차단(중복증식) |
| `server/src/services/sheetRowClaim.service.js` | 신규 서비스: `computeDedupKey`(주문번호 우선, 없으면 수취인\|연락처8\|날짜), `claimRow`(원자적 점유, 테이블부재 42P01 시 비원자 폴백), `recordReviewIdentity`(리뷰폼 즉시표시용 UPDATE 전용 backfill) |
| `server/src/routes/submit.routes.js` | 인라인 `POST /order` 배경 쓰기에 점유 적용 + 신원을 시트쓰기 전 기록. 옛 `COUNT>1` 스킵 제거 |
| `server/src/services/syncQueue.service.js` | 큐 `order_append`에 점유 적용(중복 차단이 없던 핵심 경로) + payload에 `gid` 전달 |
| `docs/2026-06-25_sheets-quota-incident-report.md` | 쿼터 사고 상세 보고서 |

### 3-2. 설계 요지
- **원자적 행 점유**가 ① 중복 증식과 ② 같은행 덮어쓰기를 DB 유니크 제약으로 동시 차단. 인라인·큐 **양 경로 공유**.
- **신원(participation_links + review_index.phone8)을 시트 쓰기 성공 전에 기록** → 쿼터로 쓰기가 밀려도 리뷰폼 검색에 이름 즉시 노출(재제출 방아쇠 제거).

### 3-3. 코드리뷰 반영 완료
- H1: `ON CONFLICT DO NOTHING`은 충돌 시 0행 → INSERT throw는 일시적 DB오류로 보고 큐로 전파(거짓 소진 방지).
- H2: 큐 `recordReviewIdentity`에 `tabGid` 전달 → `review_index.tab_gid` 빈값 고착 방지.
- M2: `recordReviewIdentity`를 UPDATE 전용으로 → 팬텀 행 미생성 → smartBuild orphan-delete 플리커 제거.

### 3-4. 검증 상태 / 미검증
- ✅ 3개 JS 문법 통과, `computeDedupKey` 단위 확인(동일주문→동일키, 타인→상이), CI(Cloudflare Pages) green.
- ⚠️ **DB 연동 동시성/멱등 실측 미수행**(이 환경에 prod DB 미연결). 스테이징/검토 후 머지 권장 → 그래서 draft.

---

## 4. 남은 일 — 로드맵

### 단기(시트 유지 전제의 완화책)
- **ⓑ 쿼터 완화**: 빈행/검사/조회의 시트 Read 호출 축소·직렬화·캐시 강화, 탭 단위 쓰기 묶음.
- **ⓓ 이미지 업로드 OAuth 우선**: SA 저장공간 403 해소(코드에 OAuth 폴백 존재하나 일부 SA로 샘).
- **중복 29행 정리 도구**: 관리자 화면에서 캐시·인덱스 동기화하며 안전 제거.

### 본 목표(이번 사고가 가리키는 방향) — DB(SQL) 이관
시트를 1차 원장에서 내리고 **PostgreSQL을 원장 + 시트는 비동기 단방향 미러**로.
- 빈행탐색·중복검사·이름조회를 **시트 읽기 → DB 쿼리**로 교체(읽기 쿼터 소비 0 = 천장 제거).
- 행 번호 배정을 DB로(이번 `sheet_row_claims`를 정식 원장 배정으로 승격; `INSERT…RETURNING`/시퀀스/유니크).
- 조회 화면을 DB 기반으로(상당수 이미 `review_index` 기반).
- 시트 쓰기는 묶음·저빈도로 격하. 실패해도 DB가 원본이라 무손실.
- 정합 검증은 기존 `raw_sheet_mirror`(마이그 029) 활용.

상세 단계·이점은 `docs/2026-06-25_sheets-quota-incident-report.md` §6~7 참조.

---

## 5. 기술 참조맵 (이어받는 세션용 핵심 좌표)

**제출 흐름**
- 인라인 주문: `server/src/routes/submit.routes.js` `POST /order` (~622). DB 즉시 INSERT(`order_submissions`) → 즉시 응답 → `setImmediate` 배경 시트쓰기(15초 타임아웃 → 실패 시 `enqueue('order_append')`).
- 큐 처리: `server/src/services/syncQueue.service.js` `processQueue`(30초 주기)·`_executeItem` `order_append`(~196).
- **슬롯매칭 비활성**: `submit.routes.js:419` `find-slot` → 항상 `mode:'append'`. `slot_locks`(레거시, 최근기록 5월)는 현 제출경로 미사용.

**인덱스/검색(리뷰폼 이름)**
- 검색 API: `server/src/routes/index.routes.js` → `server/src/services/search.service.js`(`review_index` + `participation_links` JOIN, `is_submitted=FALSE` 필터, phone8 매칭).
- 인덱스 빌드: `server/src/services/indexBuilder.service.js`(`ON CONFLICT (sheet_id,tab_name,row_index)` upsert + 고아행 삭제) / `smartBuild.service.js`. 크론: `server/src/jobs/cron.js`(15분 dirty-check, 09/15시, 04시 전체) — **review_index는 실시간 아님**(이번 PR가 제출 시 phone8 backfill로 보완).

**진단/로그**
- 오류로그: 마이그 `026_error_logs.sql`/`028_error_debug.sql`, 서비스 `errorLog.service.js`(`logAbnormal`/`classify`), 라우트 `admin.routes.js` `/error-logs*`(~1022).
- 진단: `diag.routes.js`(`/sync-queue`, `/slot-locks`, `/viewer-data`, `/stats/overview`).

**주요 테이블**
| 테이블 | 마이그 | 역할 |
|---|---|---|
| `order_submissions` | 032 | 제출 즉시 DB 원장(클릭=1행) |
| `review_index` | 001(+008 유니크,+031 파일링크) | 리뷰폼 검색 인덱스(시트→빌드) |
| `participation_links` | 025 | (sheet,tab,row)→리뷰어 phone8/name 신원링크 |
| `sheet_row_claims` | **033(신규)** | 행 점유 락(중복·경합 차단) |
| `sync_queue` | — | 시트쓰기 실패 재시도 큐 |
| `error_logs` | 026/028 | 분류된 오류 원장 |
| `raw_sheet_mirror` | 029 | 시트 RAW 미러(정합 검증) |
| `index_master`, `tab_configs` | 001 등 | 탭 메타/카운트/마감 |

---

## 6. 운영 환경 메모

- PR #116 **활동 구독 중**(CI 실패·리뷰 코멘트 알림). Cloudflare Pages 봇 코멘트는 배포상태 자동알림 → 무조치.
- **매시 :37 자가점검 cron** 가동(세션 한정, 7일 자동만료) — PR 상태/CI/머지가능 재확인, 머지·클로즈 시 자동 해제.
- ⚠️ 이 작업 환경은 **임시 컨테이너**(세션 종료 시 소멸). 보존이 필요한 건 모두 커밋·푸시됨.

---

## 7. 이어받는 세션이 먼저 확정해야 할 결정

1. **구글 시트 직접 편집 허용 여부** — 허용하면 "시트→DB 역방향 반영" 설계가 필요(이관 범위↑). 읽기전용/표시채널로 격하하면 단방향 미러로 단순화.
2. **PR #116 처리** — 그대로 머지(자동배포)할지, 스테이징에서 동시성 실측 후 머지할지.
3. **이관 1차 스코프** — 어느 탭/캠페인부터 DB 원장으로 전환할지(전면 vs 신규 캠페인부터).
4. **dedup_key 정책** — 주문번호 무존재 캠페인이 있는지(있으면 fallback 키 설계 보강 필요).

---

### 인수인계 한 줄
**"시트 읽기 쿼터 고갈이 사고의 근원이며, 1차 수정(PR #116)으로 중복·경합·이름지연은 막았다. 다음 세션은 §4 로드맵의 DB(SQL) 이관으로 쿼터 천장 자체를 제거하는 것이 목표 — 단, §7의 시트 편집 허용 여부를 먼저 확정할 것."**
