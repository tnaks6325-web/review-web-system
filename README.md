# Review Web System v2.16.1 (Phase 5: 슬롯 매칭 + 탭 데이터 교정)

## 프로젝트 개요
GAS(Google Apps Script) 기반 리뷰 관리 시스템을 Node.js Express + PostgreSQL로 완전 이관한 프로젝트입니다.
v2.16에서 구매양식 제출 시 자동 슬롯 매칭 시스템(인애드명 기반 행 배정)을 추가했습니다.

## 배포 현황

| 서비스 | URL | 상태 |
|---|---|---|
| **프론트엔드** | https://review-web-system.pages.dev | Cloudflare Pages |
| **API 서버** | https://sublime-magic-production-790b.up.railway.app | Railway (v2.16.1) |
| **GitHub** | https://github.com/tnaks6325-web/review-web-system | main 브랜치 |

## 기술 스택
- **Backend**: Node.js + Express + PostgreSQL (Railway)
- **Frontend**: Vanilla JS + HTML (Cloudflare Pages)
- **인증**: JWT (jsonwebtoken + bcryptjs)
- **외부 API**: Google Sheets API, Google Drive API
- **DB**: Railway PostgreSQL (17+ 테이블, 40+ 인덱스)

## 최근 변경사항

### ★ 탭 데이터 교정 시스템 (v2.16.1)

`tab_configs` 테이블의 `campaign_name`과 `tab_gid` 필드가 잘못 저장된 문제를 진단하고 일괄 교정하는 관리자 API를 추가했습니다.

**문제 원인:**
- `시트DB` → `syncTabListToDB` 경로에서 `campaign_name`에 스프레드시트 파일 제목 대신 특정 탭명이 저장됨
- `tab_gid`가 null로 저장되어 시트 링크에 `#gid=` 파라미터가 누락 → 잘못된 URL 생성

**수정 내용:**
1. **`POST /api/tab/fix-campaign-tab-swap`** 엔드포인트 추가
   - Google Sheets API로 실제 메타데이터 조회
   - `tab_name`/`campaign_name` 스왑 감지 및 교정 (type: `swap`)
   - 누락된 `tab_gid` 보충 (type: `gid_fill`)
   - `campaign_name`이 실제 탭명인 경우 스프레드시트 제목으로 교정 (type: `campaign_fix`, `gid_fill_and_campaign_fix`)
   - `campaigns` 테이블 폴백: `_spreadsheetTitle` 누락 시 DB에서 올바른 캠페인명 조회
   - `dryRun=true` (기본값) 미리보기 / `dryRun=false` 실제 교정
2. **LEFT JOIN → DISTINCT 쿼리 수정**: `index_master` JOIN 시 중복 행 방지
3. **교정 대상 테이블**: `tab_configs`, `index_master`, `review_index` 동시 업데이트

**교정 결과 (2026-04-30):**
- 대상: 1개 시트 (어니스트캄_업무시트), 294개 탭
- 교정 완료: 264건 (`campaign_name` + `tab_gid` 동시 교정)
- 이미 정상: 30건 (스킵)
- 오류: 0건
- 소요 시간: 2.4초

| 필드 | Before | After |
|---|---|---|
| `campaign_name` | "5/4(쿠팡)메디슨벨_마시는샐러드 골드박스 100건" (탭명) | "어니스트캄_업무시트" (시트 파일 제목) |
| `tab_gid` | NULL | 실제 GID (예: 1551859921) |
| 시트 링크 | `…/edit` (탭 지정 없음) | `…/edit#gid=1551859921` (정확한 탭) |

---

### ★ Phase 5: 슬롯 매칭 시스템 (v2.16.0)

구매양식 제출 시 시트의 "인애드명" 컬럼을 기준으로 자동으로 적합한 행을 배정하는 시스템입니다.

**API 엔드포인트:**

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/submit/find-slot` | POST | 슬롯 매칭 실행 (3순위 규칙 적용) |
| `/api/submit/order` | POST | 구매양식 제출 (슬롯 매칭 결과 반영) |
| `/api/submit/slot-status` | GET | slot_locks 테이블 상태 진단 |
| `/api/diag/slot-locks` | GET | 슬롯 잠금 상세 진단 (인증 필요) |

**슬롯 매칭 3순위 규칙:**

| 순위 | 조건 | 동작 |
|---|---|---|
| 1순위 | 로그인 이름 == 인애드명 정확 일치 | 해당 행 중 위에서부터 빈 행 배정 |
| 2순위 | 일치 없음 → 비실명(닉네임) 인애드명 | 비실명 행 중 위에서부터 빈 행 (선착순) |
| 3순위 | 위 모두 없음 → 완전 빈 행 | 인애드명도 비어있는 행 중 첫 번째 (선착순) |
| 폴백 | 슬롯 없음 | append 모드 (기존 방식) |

**핵심 구현:**
- **실명 판별**: 2~4글자 한글 + 알려진 성씨(200+) 매칭으로 실명/닉네임 구분
- **slot_locks 테이블**: 제출된 행을 DB에 기록하여 이중 배정 방지
- **기존값 보호**: 인애드명, 날짜, 번호 컬럼은 덮어쓰지 않고 보존
- **캐시 무효화**: 제출 완료 후 탭 데이터 캐시를 즉시 무효화 → 다건 제출 시 최신 상태 반영
- **다건 주문 지원**: 첫 주문은 사전 매칭, 2번째+ 주문은 매건 재매칭 호출

**DB 테이블 (slot_locks):**
```sql
CREATE TABLE slot_locks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  row_number      INTEGER NOT NULL,       -- 시트 행 번호 (1-based)
  inad_name       TEXT,                   -- 시트의 인애드명 값
  locked_by_phone8 TEXT NOT NULL,         -- 잠근 리뷰어 phone8
  locked_by_name  TEXT,                   -- 잠근 리뷰어 이름
  profile_name    TEXT,                   -- 사용된 프로필 이름
  is_submitted    BOOLEAN DEFAULT FALSE,  -- 제출 완료 여부
  locked_at       TIMESTAMPTZ DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  UNIQUE(sheet_id, tab_name, row_number)
);
```

**프론트엔드 연동 (search-app.js):**
- `gasPost({ action: "findSlot", ... })` → `POST /api/submit/find-slot`
- 응답의 `rowNumber`, `inadName`을 `submitOrderForm` payload에 포함
- 다건 주문 시 루프 내에서 매건 `findSlot` 재호출

**CORS 수정:**
- Cloudflare Pages 서브도메인 regex에 하이픈(-) 허용 추가
- `[a-z0-9]+` → `[a-z0-9-]+` (브랜치 배포 URL 지원)

---

### ★ Phase 15: 대시보드 투입/취합 집계 (v2.15.0)

**대시보드 `GET /api/admin/dashboard` 응답 강화:**

| 새 필드 | 설명 | 계산 방식 |
|---|---|---|
| `tuip` | 투입중 건수 | `is_submitted=false` & `filledCount < 4` |
| `chuihap` | 취합중 건수 | `is_submitted=false` & `filledCount >= 4` |
| `roundList` | 차수별 상세 집계 배열 | `review_index.round` 값 기준 그룹핑 |

**작업 컬럼 그룹 (WORK_COL_GROUPS) — 10그룹:**

| 그룹 | 매칭 키워드 |
|---|---|
| 수취인 | 수취인, 주문자 |
| 연락처 | 연락처, 전화번호, 핸드폰, 휴대폰 |
| 주소 | 주소 |
| 은행 | 은행 |
| 계좌번호 | 계좌번호, 계좌 |
| 예금주 | 예금주 |
| 결제금액 | 결제금액, 결제, 금액 |
| 주문번호 | 주문번호 |
| 주문자제출 | 주문자제출 |
| ID | 쿠팡id, 네이버아이디, id, 네이버&쿠팡id |

**판정 기준:**
- `filledCount` = row_json에서 위 10그룹 중 값이 채워진 그룹 수
- `filledCount < 4` → **투입중** (참가자 입력 초기 단계)
- `filledCount >= 4` → **취합중** (참가자 정보 수집 진행중)
- `is_submitted = true` → 투입/취합에서 제외 (이미 제출 완료)

**프론트엔드 대시보드 상태 표시:**

| 조건 | UI 표시 |
|---|---|
| `isClosed = true` | ⬛ 마감 |
| `pending === 0 && total > 0` | ✓ 완료 |
| `tuip > 0 \|\| chuihap > 0` | 투입중 N/T + 취합중 N/T |
| `total === 0` | (빈 상태) |

**roundList 응답 예시:**
```json
{
  "roundList": [
    { "round": "1차", "total": 24, "submitted": 0, "pending": 24, "tuip": 0, "chuihap": 24 },
    { "round": "2차", "total": 10, "submitted": 0, "pending": 10, "tuip": 0, "chuihap": 10 }
  ]
}
```

### ★ 계정관리 버그 수정
- **문제**: `gasPost({ action: "addAdminUser" })` 호출 시 서버에 `action` 필드가 전달되지 않음
- **원인**: `api.js`에서 action 필드를 제거한 후 서버가 기대하는 action 필드가 누락
- **해결**: `_ACTION_MAP`에 `remap` 속성 추가 — 멀티-액션 라우트(`/api/admin/users`, `/api/admin/staff-users`)에 올바른 action 값 복원
- **영향**: 관리자/영업담당자 추가/삭제/수정/목록조회 모두 정상 작동

### ★ _rowState 필터 인자 수정
- **문제**: `_rowState(false, isClosedTab, isDone, tuip, chuihap)` 5개 인자 전달 → 4개 파라미터 정의와 불일치
- **원인**: 이전 `forceDone` 파라미터 제거 시 호출부 업데이트 누락
- **해결**: 호출부에서 첫 번째 `false` 인자 제거
- **영향**: `data-state` 필터(투입중/취합중/완료/마감) 값이 정확하게 설정됨

## v2.1 Phase 1-5 최적화 요약

### ★ v11.6: 스마트 빌드 (Smart Build)
- **Drive API 변경감지**: 57개 시트의 수정시각을 Drive API로 일괄 조회 (분당 12,000회 한도)
- **Sheets API batchGet**: 변경된 시트만 탭 데이터를 1회 API로 읽기 (시트당 1호출)
- **체크섬 비교**: 탭별 MD5 체크섬으로 실제 변경된 탭만 DB 갱신
- **5분 자동 주기**: 서버 시작 30초 후 첫 실행, 이후 5분마다 자동 반복
- **독립 모듈**: 기존 indexBuilder 코드와 완전히 분리된 별도 서비스
- **API 엔드포인트**:
  - `GET /api/admin/smart-build/status` — 상태 조회
  - `POST /api/admin/smart-build/run` — 수동 1회 실행
  - `POST /api/admin/smart-build/start` — 스케줄러 시작
  - `POST /api/admin/smart-build/stop` — 스케줄러 정지
- **프론트엔드 UI**: 시스템 모니터링 패널에 스마트빌드 상태 표시, 수동 실행/스케줄러 토글 버튼

### Phase 1: 인덱스 빌드 속도 최적화
- **Drive API 변경감지**: `getSheetModifiedTime()`으로 수정시각 확인 → 변경 없는 시트 전체 스킵
- **batchGet**: 같은 시트의 모든 탭을 1회 API 호출로 읽기 (106회 → 8회)
- **병렬 처리**: `Promise.allSettled`로 8개 시트 동시 처리
- **기대 효과**: 5-7분 → 1-2분 (변경 없으면 수 초)

### Phase 2: Sync Queue 인프라
- **syncQueue.service.js**: enqueue, processQueue, getQueueStats, retryItem, purgeCompleted
- **30초 워커**: cron으로 매 30초마다 pending 큐 처리 (최대 10건/회)
- **자동 정리**: 매일 새벽 3시 완료된 항목 삭제 (24시간 경과)

### Phase 3: 제출 안정화 (DB 우선 + Sheets 동시)
- **리뷰 제출**: DB 즉시 업데이트 → Sheets 쓰기 → 실패 시 sync_queue 등록
- **구매양식 제출**: DB 즉시 저장 → Sheets 행 추가 → 실패 시 sync_queue 등록
- **헤더 캐시**: 5분 TTL로 동일 탭 헤더 재사용

### Phase 4: 중복검사 DB 전용 전환
- **Sheets readSheet 호출 완전 제거** (check-duplicate 엔드포인트)
- **3단계 DB 검사**: order_submissions → review_index(phone8) → recipient+address
- **기대 효과**: 5-15초 → 3ms 즉시 응답

### Phase 5: 관리자 모니터링 대시보드
- **Sync Queue 패널**: pending/processing/done/failed 상태 카드
- **실패 항목 재시도**: 개별 + 전체 일괄 재시도 버튼
- **빌드 히스토리 테이블**: 최근 10건 (시각, 소요시간, 갱신/스킵/에러, 트리거)

## 데이터베이스
### 테이블 (17+개)
| 테이블 | 설명 | 비고 |
|---|---|---|
| campaigns | 캠페인(베이스시트) | 자동 생성 |
| tab_configs | 탭별 설정 | ~400건 |
| review_index | 검색 인덱스 | ~15,400건 |
| index_master | 인덱스 메타 (체크섬 + sheet_modified_at) | 156탭 활성 |
| reviewers | 리뷰어 명단 | ~1,054건 |
| admin_users | 관리자 | 2명 + master 계정 (환경변수) |
| staff_users | 영업담당자 | 8명 |
| memos | 메모 | API로 생성 |
| short_links | 단축 URL | API로 생성 |
| blacklist | 블랙리스트 | API로 생성 |
| payment_records | 입금 이력 | API로 생성 |
| order_submissions | 주문 제출 (중복검사 기반) | API로 생성 |
| build_locks | 빌드 잠금 | 초기값 자동 삽입 |
| app_settings | 앱 설정 | API로 생성 |
| sync_queue | Sheets 쓰기 실패 재시도 큐 (Phase 2) | 자동 처리 |
| build_history | 인덱스 빌드 이력 (Phase 5) | 자동 기록 |
| index_keywords | 인덱스 키워드 관리 (Phase 14) | 관리자 설정 |
| unrecognized_tabs | 인식 실패 탭 진단 (Phase 14) | 자동 감지 |

## API 엔드포인트
| 경로 | 메서드 | 설명 |
|---|---|---|
| `/health` | GET | 서버 상태 (DB, Google, 버전 v2.15.0) |
| `/api/admin/login` | POST | 관리자 로그인 |
| `/api/admin/staff-login` | POST | 영업담당자 로그인 |
| `/api/admin/users` | POST | 관리자 계정 CRUD (action: add/edit/delete/list) |
| `/api/admin/staff-users` | POST | 영업담당자 계정 CRUD (action: add/edit/delete/list) |
| `/api/admin/dashboard` | GET | **대시보드 (tuip/chuihap/roundList 포함)** |
| `/api/admin/release-lock` | POST | 빌드 잠금 해제 |
| `/api/admin/keywords` | GET/POST/PUT/DELETE | 인덱스 키워드 관리 |
| `/api/admin/unrecognized` | GET | 인식 실패 탭 목록 |
| `/api/admin/smart-build/*` | GET/POST | 스마트 빌드 관리 |
| `/api/admin/db-rebuild` | POST | DB 전체 재구축 |
| `/api/search?query=` | GET | 리뷰어 검색 |
| `/api/index/status` | GET | 인덱스 상태 |
| `/api/index/build` | POST | 인덱스 빌드 (비동기) |
| `/api/tab/config` | GET/POST | 탭 설정 조회/저장 |
| `/api/tab/dashboard` | GET | 탭 대시보드 |
| `/api/submit/review` | POST | 리뷰 제출 (DB+Sheets 동시) |
| `/api/submit/order` | POST | 구매양식 제출 |
| `/api/submit/check-duplicate` | POST | 중복검사 (DB 전용) |
| `/api/reviewer/*` | GET/POST | 리뷰어 관리 |
| `/api/drive/*` | GET/POST | Drive 폴더 관리 |
| `/api/short/*` | GET/POST | 단축URL |
| `/api/memo` | GET/POST | 메모 |
| `/api/payment/*` | GET/POST | 입금처리 |
| `/api/archive/*` | GET/POST | 아카이브 |
| `/api/diag/*` | GET/POST | 진단/모니터링 |
| `/api/tab/fix-campaign-tab-swap` | POST | campaign_name/tab_gid 일괄 교정 (인증 필요, dryRun 지원) |
| `/api/tab/sync-tab-names` | POST | 탭명 동기화 + GID 보충 (인증 필요) |
| `/api/tab/clean-closed` | POST | 마감 탭 아카이브 처리 (인증 필요) |

## 환경변수 (Railway)
```
DATABASE_URL          → ${{Postgres.DATABASE_URL}}
NODE_ENV              → production
JWT_SECRET            → (32바이트 hex)
JWT_EXPIRES_IN        → 8h
MASTER_ADMIN_NAME     → master
MASTER_ADMIN_PW       → (비밀번호)
GOOGLE_SERVICE_ACCOUNT_EMAIL → (서비스 계정 이메일)
GOOGLE_PRIVATE_KEY    → (RSA 프라이빗 키)
BASE_SHEET_ID         → (베이스 시트 ID)
MASTER_SHEET_ID       → (마스터 시트 ID)
DRIVE_ROOT_FOLDER_ID  → (드라이브 폴더 ID)
ALLOWED_ORIGINS       → https://review-web-system.pages.dev
INDEX_CRON_SCHEDULE   → 0 9-19 * * 1-6
SENTRY_DSN            → (선택: Sentry 에러 트래킹)
```

## 프론트엔드 페이지
| 파일 | 설명 |
|---|---|
| `index.html` | 메인 대시보드 (관리자) + 시스템 모니터링 패널 |
| `search.html` | 리뷰어 검색 |
| `staff.html` | 영업담당자 페이지 |
| `viewer.html` | 뷰어 (읽기 전용) |
| `recruit.html` | 리뷰어 모집 페이지 |
| `api.js` | API 통신 모듈 (gasGet/gasPost → REST API 매핑, remap 지원) |

## 서버 구조
```
server/
├── index.js                     # 엔트리 (자동 마이그레이션 + graceful shutdown)
├── src/
│   ├── app.js                   # Express 앱 (v2.15.0, 미들웨어 + 라우터)
│   ├── routes/
│   │   ├── index.routes.js      # 검색 + 인덱스 빌드/상태
│   │   ├── tabconfig.routes.js  # 탭 설정/대시보드
│   │   ├── admin.routes.js      # 관리자 인증 + 대시보드(Phase 15) + 키워드 + 스마트빌드
│   │   ├── submit.routes.js     # 리뷰/구매양식 제출 (Phase 3 적용)
│   │   ├── reviewer.routes.js   # 리뷰어 관리
│   │   ├── drive.routes.js      # Google Drive 폴더 관리
│   │   ├── shortlink.routes.js  # 단축URL
│   │   ├── memo.routes.js       # 메모
│   │   ├── payment.routes.js    # 입금처리
│   │   ├── archive.routes.js    # 아카이브
│   │   └── diag.routes.js       # 진단 + sync-queue + build-history
│   ├── services/
│   │   ├── smartBuild.service.js   # 스마트 빌드 (Drive API 변경감지)
│   │   ├── indexBuilder.service.js # 인덱스 빌드 (Phase 1 최적화)
│   │   ├── indexScan.service.js    # 인덱스 스캔 (탭목록 관리)
│   │   ├── sheets.service.js       # Google Sheets/Drive API
│   │   ├── drive.service.js        # Google Drive API
│   │   ├── syncQueue.service.js    # Sync Queue (Phase 2)
│   │   ├── auth.service.js         # 인증 서비스 (관리자/영업담당자 CRUD)
│   │   ├── gemini.service.js       # Gemini AI 서비스
│   │   └── reviewer.service.js     # 리뷰어 서비스
│   ├── middleware/
│   │   ├── auth.middleware.js      # JWT 인증 + 마스터 전용
│   │   ├── cors.middleware.js      # CORS 설정
│   │   ├── error.middleware.js     # 에러 핸들링
│   │   ├── rateLimit.middleware.js # Rate Limit
│   │   └── metrics.middleware.js   # 요청 메트릭
│   ├── jobs/
│   │   └── cron.js              # 스케줄러 (인덱스 + 큐 워커 + 정리)
│   ├── utils/
│   │   ├── logger.js            # 로깅
│   │   ├── sse.js               # Server-Sent Events
│   │   ├── cronCalc.js          # CRON 계산
│   │   └── ...
│   └── db/
│       ├── pool.js              # PostgreSQL 풀
│       └── migrate.js           # 마이그레이션 러너
├── migrations/
│   ├── 001_create_tables.sql
│   ├── 002_phase1_optimization.sql
│   ├── 003_phase3_4_indexes.sql
│   ├── 004_phase7_search_optimization.sql
│   ├── 005_archive_tables.sql
│   ├── 006_index_keywords_and_unrecognized.sql
│   ├── 007_drop_force_done.sql
│   ├── 008_incremental_upsert.sql
│   └── 009_add_tab_gid_to_tab_configs.sql
└── package.json
```

## 배포 이력
- **2026-04-30**: 탭 데이터 교정 시스템 배포 (v2.16.1)
  - `POST /api/tab/fix-campaign-tab-swap` 엔드포인트 추가
  - campaign_name 오류 교정 (탭명→시트파일제목), tab_gid null 보충
  - campaigns 테이블 폴백 로직, DISTINCT 쿼리 최적화
  - 프로덕션 264건 일괄 교정 완료 (0 오류)
- **2026-04-29**: Phase 5 슬롯 매칭 시스템 배포 (v2.16.0)
  - find-slot 3순위 매칭 + slot_locks 테이블
  - 구매양식 제출 슬롯 반영 + 캐시 무효화
  - 다건 주문 시 매건 재매칭 호출
  - CORS 하이픈 허용 수정
- **2026-04-27**: Phase 15 대시보드 투입/취합 집계 배포 (v2.15.0-dashboard-tuip-chuihap)
  - WORK_COL_GROUPS 10그룹 정의 + filledCount 계산
  - 대시보드 API에 tuip/chuihap/roundList 필드 추가
  - 계정관리 API action 누락 버그 수정 (remap)
  - _rowState 필터 인자 불일치 수정
  - 프론트엔드 대시보드 상태 표시 (투입중/취합중/완료/마감)
  - 대시보드 폴링 완료 알림 기능
- 2026-04-20: Phase 1-5 최적화 배포 (v2.1.0-phase1)
  - 인덱스 빌드 최적화 (batchGet + 병렬 + Drive 변경감지)
  - Sync Queue 인프라 + 30초 워커
  - DB 우선 제출 + Sheets 실패 자동 재시도
  - 중복검사 DB 전용 전환 (Sheets 읽기 제거)
  - 관리자 모니터링 대시보드 (큐 + 빌드 히스토리)
- 2026-04-16: Railway 서버 배포 + PostgreSQL DDL (14 테이블) + 데이터 이관 + Cloudflare Pages 프론트엔드 배포

## 사용자 가이드

### 관리자 로그인
1. `index.html` 접속 → 관리자 카드 클릭
2. 마스터 계정 또는 등록된 관리자 계정으로 로그인
3. 대시보드에서 캠페인별 탭 현황, 투입/취합 상태 확인

### 계정 관리 (마스터 전용)
1. 대시보드 좌측 메뉴에서 "계정 관리" 클릭
2. **관리자 탭**: 추가/삭제/비활성화/비밀번호 변경
3. **영업담당자 탭**: 추가/삭제/비활성화/비밀번호 변경

### 대시보드 기능
- **투입중/취합중 표시**: 각 탭의 참가자 입력 진행 상태
- **차수별 집계**: roundList가 있는 탭은 1차/2차 등으로 세분화
- **완료건 숨김**: 기본 ON — 완료된 탭 자동 숨김
- **완료 알림 폴링**: 5분 주기로 새로 완료된 탭 감지 → 브라우저 알림
- **필터**: 투입중/취합중/완료/마감 상태별 필터링
- **검색**: 캠페인명/탭명 실시간 검색
