# Review Web System v2.0

## 프로젝트 개요
GAS(Google Apps Script) 기반 리뷰 관리 시스템을 Node.js Express + PostgreSQL로 완전 이관한 프로젝트입니다.

## 배포 현황

| 서비스 | URL | 상태 |
|---|---|---|
| **프론트엔드** | https://review-web-system.pages.dev | Cloudflare Pages |
| **API 서버** | https://sublime-magic-production-790b.up.railway.app | Railway |
| **GitHub** | https://github.com/tnaks6325-web/review-web-system | main 브랜치 |

## 기술 스택
- **Backend**: Node.js + Express + PostgreSQL (Railway)
- **Frontend**: Vanilla JS + HTML (Cloudflare Pages)
- **인증**: JWT (jsonwebtoken + bcryptjs)
- **외부 API**: Google Sheets API, Google Drive API
- **DB**: Railway PostgreSQL (14 테이블, 34+ 인덱스)

## 데이터베이스
### 테이블 (14개)
| 테이블 | 설명 | 이관 데이터 |
|---|---|---|
| campaigns | 캠페인(베이스시트) | 자동 생성 |
| tab_configs | 탭별 설정 | 407건 (세부목록 시트) |
| review_index | 검색 인덱스 | 인덱스 빌드로 생성 |
| index_master | 인덱스 메타 | 인덱스 빌드로 생성 |
| reviewers | 리뷰어 명단 | 1,054건 (인애드명단 시트) |
| admin_users | 관리자 | master 계정 (환경변수) |
| staff_users | 영업담당자 | API로 생성 |
| memos | 메모 | API로 생성 |
| short_links | 단축 URL | API로 생성 |
| blacklist | 블랙리스트 | API로 생성 |
| payment_records | 입금 이력 | API로 생성 |
| order_submissions | 주문 제출 | API로 생성 |
| build_locks | 빌드 잠금 | 초기값 자동 삽입 |
| app_settings | 앱 설정 | API로 생성 |

## API 엔드포인트
| 경로 | 설명 |
|---|---|
| `GET /health` | 서버 상태 (DB, Google, 버전) |
| `POST /api/admin/login` | 관리자 로그인 (`name`, `pw`) |
| `POST /api/admin/staff-login` | Staff 로그인 |
| `GET /api/admin/dashboard` | 대시보드 (탭, 캠페인, 상세맵) |
| `GET /api/search?query=` | 리뷰어 검색 |
| `GET /api/index/status` | 인덱스 상태 |
| `POST /api/index/build` | 인덱스 빌드 |
| `GET /api/tab/config?sheetId=` | 탭 설정 조회 |
| `POST /api/tab/config` | 탭 설정 저장 |
| `POST /api/reviewer/register` | 리뷰어 등록 |
| `GET /api/reviewer/verify` | 리뷰어 인증 |
| `GET /api/reviewer/list` | 리뷰어 목록 (인증 필요) |
| `POST /api/memo` | 메모 CRUD |
| `POST /api/short/create` | 단축 URL 생성 |
| `GET /api/short/resolve?code=` | 단축 URL 조회 |
| `POST /api/blacklist` | 블랙리스트 관리 |
| `GET /api/diag/campaign-list` | 캠페인 목록 |
| `GET /api/diag/debug-tab` | 탭 디버그 (인증 필요) |
| `GET /api/viewer/viewer-data` | 뷰어 데이터 |

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
| `index.html` | 메인 대시보드 (관리자) |
| `search.html` | 리뷰어 검색 |
| `staff.html` | 영업담당자 페이지 |
| `viewer.html` | 뷰어 (읽기 전용) |
| `recruit.html` | 리뷰어 모집 페이지 |
| `api.js` | API 통신 모듈 (gasGet/gasPost → REST API) |

## 백업 파일
- 최신 백업: https://www.genspark.ai/api/files/s/xTeQOkdX (1.4MB tar.gz)

## 배포 이력
- 2026-04-16: Railway 서버 배포 + PostgreSQL DDL (14 테이블) + 데이터 이관 (tab_configs 407건, reviewers 1,054건) + Cloudflare Pages 프론트엔드 배포 완료
