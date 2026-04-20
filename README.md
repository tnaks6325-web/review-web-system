# Review Web System v2.1 (Phase 1-5 최적화 적용)

## 프로젝트 개요
GAS(Google Apps Script) 기반 리뷰 관리 시스템을 Node.js Express + PostgreSQL로 완전 이관한 프로젝트입니다.
v2.1에서 인덱스 빌드 최적화, Sync Queue, DB 우선 제출, DB 전용 중복검사, 모니터링 UI를 추가했습니다.

## 배포 현황

| 서비스 | URL | 상태 |
|---|---|---|
| **프론트엔드** | https://review-web-system.pages.dev | Cloudflare Pages |
| **API 서버** | https://sublime-magic-production-790b.up.railway.app | Railway (v2.1.0-phase1) |
| **GitHub** | https://github.com/tnaks6325-web/review-web-system | main 브랜치 |

## 기술 스택
- **Backend**: Node.js + Express + PostgreSQL (Railway)
- **Frontend**: Vanilla JS + HTML (Cloudflare Pages)
- **인증**: JWT (jsonwebtoken + bcryptjs)
- **외부 API**: Google Sheets API, Google Drive API
- **DB**: Railway PostgreSQL (17 테이블, 40+ 인덱스)

## v2.1 Phase 1-5 최적화 요약

### Phase 1: 인덱스 빌드 속도 최적화
- **Drive API 변경감지**: `getSheetModifiedTime()`으로 수정시각 확인 → 변경 없는 시트 전체 스킵
- **batchGet**: 같은 시트의 모든 탭을 1회 API 호출로 읽기 (106회 → 8회)
- **병렬 처리**: `Promise.allSettled`로 8개 시트 동시 처리
- **기대 효과**: 5-7분 → 1-2분 (변경 없으면 수 초)

### Phase 2: Sync Queue 인프라
- **syncQueue.service.js**: enqueue, processQueue, getQueueStats, retryItem, purgeCompleted
- **30초 워커**: cron으로 매 30초마다 pending 큐 처리 (최대 10건/회)
- **자동 정리**: 매일 새벽 3시 완료된 항목 삭제 (24시간 경과)
- **API**: `/api/diag/sync-queue`, `/api/diag/sync-queue/retry`, `/api/diag/sync-queue/purge`

### Phase 3: 제출 안정화 (DB 우선 + Sheets 동시)
- **리뷰 제출**: DB 즉시 업데이트 → Sheets 쓰기 → 실패 시 sync_queue 등록
- **구매양식 제출**: DB 즉시 저장 → Sheets 행 추가 → 실패 시 sync_queue 등록
- **헤더 캐시**: 5분 TTL로 동일 탭 헤더 재사용 (Sheets API 호출 절감)
- **응답 상세화**: `{ ok, dbUpdated, sheetsWritten, queued }`

### Phase 4: 중복검사 DB 전용 전환
- **Sheets readSheet 호출 완전 제거** (check-duplicate 엔드포인트)
- **3단계 DB 검사**: order_submissions → review_index(phone8) → recipient+address
- **기대 효과**: 5-15초 → 3ms 즉시 응답
- **복합 인덱스 추가**: `idx_order_recipient_phone`, `idx_order_recipient_address`, `idx_review_sheet_tab_phone`

### Phase 5: 관리자 모니터링 대시보드
- **Sync Queue 패널**: pending/processing/done/failed 상태 카드
- **실패 항목 재시도**: 개별 + 전체 일괄 재시도 버튼
- **빌드 히스토리 테이블**: 최근 10건 (시각, 소요시간, 갱신/스킵/에러, 트리거)
- **대시보드 탭 진입 시 자동 로드**

## 데이터베이스
### 테이블 (17개)
| 테이블 | 설명 | 비고 |
|---|---|---|
| campaigns | 캠페인(베이스시트) | 자동 생성 |
| tab_configs | 탭별 설정 | 407건 |
| review_index | 검색 인덱스 | ~16,477건 |
| index_master | 인덱스 메타 (체크섬 + sheet_modified_at) | 인덱스 빌드 |
| reviewers | 리뷰어 명단 | 1,054건 |
| admin_users | 관리자 | master 계정 (환경변수) |
| staff_users | 영업담당자 | API로 생성 |
| memos | 메모 | API로 생성 |
| short_links | 단축 URL | API로 생성 |
| blacklist | 블랙리스트 | API로 생성 |
| payment_records | 입금 이력 | API로 생성 |
| order_submissions | 주문 제출 (중복검사 기반) | API로 생성 |
| build_locks | 빌드 잠금 | 초기값 자동 삽입 |
| app_settings | 앱 설정 | API로 생성 |
| **sync_queue** | **Sheets 쓰기 실패 재시도 큐** (Phase 2) | 자동 처리 |
| **build_history** | **인덱스 빌드 이력** (Phase 5) | 자동 기록 |

### 마이그레이션 파일
| 파일 | 내용 |
|---|---|
| `001_create_tables.sql` | 기본 14 테이블 + 인덱스 |
| `002_phase1_optimization.sql` | sheet_modified_at 컬럼, sync_queue, build_history 테이블 |
| `003_phase3_4_indexes.sql` | 중복검사 최적화 복합 인덱스 |

## API 엔드포인트
| 경로 | 설명 |
|---|---|
| `GET /health` | 서버 상태 (DB, Google, 버전 v2.1.0-phase1) |
| `POST /api/admin/login` | 관리자 로그인 |
| `GET /api/search?query=` | 리뷰어 검색 |
| `GET /api/index/status` | 인덱스 상태 |
| `POST /api/index/build` | 인덱스 빌드 (비동기) |
| `POST /api/submit/review` | 리뷰 제출 (DB+Sheets 동시) |
| `POST /api/submit/order` | 구매양식 제출 (DB+Sheets 동시) |
| `POST /api/submit/check-duplicate` | 중복검사 (DB 전용) |
| `GET /api/diag/sync-queue` | Sync Queue 현황 |
| `POST /api/diag/sync-queue/retry` | 큐 항목 재시도 |
| `POST /api/diag/sync-queue/purge` | 완료 항목 정리 |
| `GET /api/diag/build-history` | 빌드 히스토리 |

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
DRIVE_ROOT_FOLDER_ID  → (드라이브 폴더 ID)
ALLOWED_ORIGINS       → https://review-web-system.pages.dev
INDEX_CRON_SCHEDULE   → 0 9-19 * * 1-6
```

## 프론트엔드 페이지
| 파일 | 설명 |
|---|---|
| `index.html` | 메인 대시보드 (관리자) + 시스템 모니터링 패널 |
| `search.html` | 리뷰어 검색 |
| `staff.html` | 영업담당자 페이지 |
| `viewer.html` | 뷰어 (읽기 전용) |
| `recruit.html` | 리뷰어 모집 페이지 |
| `api.js` | API 통신 모듈 (gasGet/gasPost → REST API + Phase 2-5 액션 매핑) |

## 서버 구조
```
server/
├── index.js                     # 엔트리 (자동 마이그레이션 + graceful shutdown)
├── src/
│   ├── app.js                   # Express 앱 (미들웨어 + 라우터)
│   ├── routes/
│   │   ├── index.routes.js      # 검색 + 인덱스 빌드/상태
│   │   ├── submit.routes.js     # 리뷰/구매양식 제출 (Phase 3 적용)
│   │   ├── diag.routes.js       # 진단 + sync-queue + build-history
│   │   ├── admin.routes.js      # 관리자 인증
│   │   └── ...
│   ├── services/
│   │   ├── indexBuilder.service.js  # 인덱스 빌드 (Phase 1 최적화)
│   │   ├── sheets.service.js        # Google Sheets/Drive API
│   │   ├── syncQueue.service.js     # Sync Queue (Phase 2)
│   │   └── ...
│   ├── jobs/
│   │   └── cron.js              # 스케줄러 (인덱스 + 큐 워커 + 정리)
│   └── db/
│       ├── pool.js              # PostgreSQL 풀
│       └── migrate.js           # 마이그레이션 러너
├── migrations/
│   ├── 001_create_tables.sql
│   ├── 002_phase1_optimization.sql
│   └── 003_phase3_4_indexes.sql
└── package.json
```

## 배포 이력
- 2026-04-20: Phase 1-5 최적화 배포 (v2.1.0-phase1)
  - 인덱스 빌드 최적화 (batchGet + 병렬 + Drive 변경감지)
  - Sync Queue 인프라 + 30초 워커
  - DB 우선 제출 + Sheets 실패 자동 재시도
  - 중복검사 DB 전용 전환 (Sheets 읽기 제거)
  - 관리자 모니터링 대시보드 (큐 + 빌드 히스토리)
- 2026-04-16: Railway 서버 배포 + PostgreSQL DDL (14 테이블) + 데이터 이관 + Cloudflare Pages 프론트엔드 배포
