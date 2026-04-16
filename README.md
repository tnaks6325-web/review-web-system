# 리뷰웹시스템 - Node.js + PostgreSQL 완전 리빌드

## 프로젝트 개요
- **이름**: review-system (리뷰웹시스템)
- **목표**: Google Apps Script(GAS) 기반 리뷰 관리 시스템을 Node.js(Express) + PostgreSQL + Cloudflare Pages로 완전 이관
- **현재 버전**: GAS v10.5 -> Node.js v1.0.0
- **스택**: Node.js/Express (Railway) + PostgreSQL + Google Sheets/Drive API + Cloudflare Pages

## 아키텍처

```
[브라우저] → HTTPS → [Cloudflare Pages: 정적 HTML]
                            ↓ API 요청
                     [Railway: Node.js/Express API 서버]
                            ↓
              [PostgreSQL] + [Google Sheets API] + [Google Drive API]
```

## 디렉토리 구조

```
review-system/
├── server/                          # Railway 배포 대상
│   ├── src/
│   │   ├── routes/                  # API 라우터 (10개 파일)
│   │   │   ├── index.routes.js      # 검색/인덱스 빌드
│   │   │   ├── tabconfig.routes.js  # 탭 설정 CRUD
│   │   │   ├── reviewer.routes.js   # 리뷰어 관리
│   │   │   ├── admin.routes.js      # 관리자 인증
│   │   │   ├── drive.routes.js      # Drive 폴더 관리
│   │   │   ├── shortlink.routes.js  # 단축URL
│   │   │   ├── memo.routes.js       # 메모 공유
│   │   │   ├── payment.routes.js    # 입금 처리
│   │   │   ├── submit.routes.js     # 리뷰 제출
│   │   │   └── diag.routes.js       # 진단/기타
│   │   ├── services/                # 비즈니스 로직
│   │   │   ├── sheets.service.js    # Google Sheets API
│   │   │   ├── drive.service.js     # Google Drive API
│   │   │   ├── indexBuilder.service.js  # 인덱스 빌드
│   │   │   ├── search.service.js    # PostgreSQL 검색
│   │   │   ├── auth.service.js      # JWT 인증
│   │   │   └── reviewer.service.js  # 리뷰어 CRUD
│   │   ├── middleware/              # 미들웨어
│   │   ├── db/                      # DB 연결/마이그레이션
│   │   ├── jobs/                    # node-cron 스케줄러
│   │   ├── utils/                   # 유틸리티
│   │   └── app.js                   # Express 앱
│   ├── index.js                     # 서버 엔트리포인트
│   ├── migrations/                  # SQL DDL
│   ├── scripts/                     # 데이터 마이그레이션 스크립트
│   ├── package.json
│   ├── Procfile
│   └── railway.json
├── frontend/                        # Cloudflare Pages 배포 대상
│   ├── index.html                   # 관리자 대시보드
│   ├── search.html                  # 리뷰어 검색
│   ├── staff.html                   # AE 담당자
│   ├── viewer.html                  # 진행현황 뷰어
│   ├── recruit.html                 # 리크루팅
│   └── _headers
├── .env.example
├── ecosystem.config.cjs
└── README.md
```

## 구현된 API 엔드포인트 (40개+)

### 검색/인덱스
| 메서드 | 경로 | 설명 | GAS action |
|--------|------|------|-----------|
| GET | `/api/search` | 이름/전화번호 검색 | searchAll |
| POST | `/api/index/build` | 인덱스 스마트 빌드 | buildIndexSmart |
| GET | `/api/index/status` | 인덱스 현황 조회 | indexStatus |

### 탭 설정
| 메서드 | 경로 | 설명 | GAS action |
|--------|------|------|-----------|
| POST | `/api/tab/config` | 탭 설정 저장(upsert) | setTabConfig |
| GET | `/api/tab/config` | 탭 설정 조회 | getTabConfig |
| POST | `/api/tab/force-done` | 강제완료 설정 | setForceDone |
| POST | `/api/tab/closed` | 마감 설정 | setClosed |
| GET | `/api/tab/options` | 탭 옵션 목록 | getTabOptions |
| GET | `/api/tab/end-date` | 종료일 조회 | getTabEndDate |
| GET | `/api/tab/stats` | 탭별 통계 | getCampaignStats |

### 리뷰어 관리
| 메서드 | 경로 | 설명 | GAS action |
|--------|------|------|-----------|
| POST | `/api/reviewer/register` | 리뷰어 등록 | registerReviewer |
| GET | `/api/reviewer/verify` | 리뷰어 인증 | verifyReviewer |
| GET | `/api/reviewer/lookup` | 전화번호 조회 | lookupPhone |
| GET | `/api/reviewer/list` | 목록 조회 | getReviewerList |
| POST | `/api/reviewer/delete` | 리뷰어 삭제 | deleteReviewer |
| POST | `/api/reviewer/profile` | 프로필 관리 | getReviewerProfile 등 |

### 관리자 인증
| 메서드 | 경로 | 설명 | GAS action |
|--------|------|------|-----------|
| POST | `/api/admin/login` | 로그인 (JWT 발급) | adminLoginV2 |
| POST | `/api/admin/change-pw` | 비밀번호 변경 | adminChangePw |
| POST | `/api/admin/users` | 계정 CRUD | addAdminUser 등 |
| GET | `/api/admin/dashboard` | 대시보드 데이터 | dashboard |

### Drive / 메모 / 단축URL / 입금
| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/drive/*` | Drive 폴더 동기화/생성 (10개) |
| GET/POST/DELETE | `/api/memo` | 메모 CRUD |
| POST | `/api/short/create` | 단축URL 생성 |
| GET | `/api/short/resolve` | 단축URL 해석 |
| GET | `/api/payment/targets` | 입금 대상 조회 |
| POST | `/api/payment/mark-done` | 입금 완료 처리 |
| POST | `/api/submit/review` | 리뷰 제출 (Sheets 직접 쓰기) |
| POST | `/api/blacklist` | 블랙리스트 관리 |

## PostgreSQL 테이블 (9개)
1. `campaigns` - 캠페인 목록
2. `tab_configs` - 탭 설정 (세부목록 대체)
3. `review_index` - 검색 인덱스 (GIN index 포함)
4. `index_master` - 인덱스 빌드 메타 (체크섬)
5. `reviewers` - 리뷰어 회원 (인애드명단 대체)
6. `admin_users` - 관리자 계정 (bcrypt)
7. `memos` - 메모
8. `short_links` - 단축URL
9. `blacklist` - 블랙리스트

## 핵심 제약 조건 (GAS 호환)
- API 응답 형식: GAS `corsOutput()` 호환 JSON 유지 (`error`, `success`, `results`, `ok`)
- 캠페인 시트 구조: 기존 Google Sheets 구조 그대로 유지
- tab_key 형식: `sheetId||tabName` (|| 구분자 유지)
- SUBMITTED_VALUES: `["TRUE","true","1","제출","O","o","완료","Y","y"]`
- SHORT_CODE: 6자리 (`abcdefghjkmnpqrstuvwxyz23456789`)

## 개발/배포 환경

### 로컬 개발
```bash
cd server && npm install
# .env 파일 설정 후
npm run dev
```

### Railway 배포
- `railway.json`, `Procfile` 포함
- 환경변수: `DATABASE_URL`, `JWT_SECRET`, `BASE_SHEET_ID`, `ALLOWED_ORIGINS` 설정

### Cloudflare Pages 배포
- `frontend/` 디렉토리를 Cloudflare Pages로 배포
- `_headers` 파일로 보안 헤더 설정

## 이관 상태
- [x] Phase 1: 프론트엔드 CDN 이관 준비 (frontend/ 디렉토리)
- [x] Phase 2: Node.js 서버 + DB 스키마 구축 완료
- [ ] Phase 3: 데이터 마이그레이션 + API 전환 (GAS 폴백 유지)
- [ ] Phase 4: GAS 완전 제거 + 최적화

## 예상 성능 향상
- 이름 검색: 800ms → 5ms (PostgreSQL GIN 인덱스)
- 탭 설정 저장: 1~3s → 20ms (PostgreSQL upsert)
- 콜드스타트: 3~8초 → 0ms (Railway 항상 켜짐)
- 월 비용: $0 → $5 (Railway Starter)
