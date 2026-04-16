# 리뷰웹시스템 (Review Web System)

GAS(Google Apps Script) 기반 리뷰 관리 시스템을 Node.js/Express + PostgreSQL로 마이그레이션한 프로젝트.

## URLs
- **프론트엔드 (Cloudflare Pages)**: https://review-web-system.pages.dev
- **API 서버 (Sandbox)**: https://3000-i38yiadr8uqfj3spfxinm-5185f4aa.sandbox.novita.ai
- **API 헬스체크**: /health

## 기술 스택
| 구성 | 기술 |
|------|------|
| 백엔드 | Node.js 18+ / Express 4 |
| 데이터베이스 | PostgreSQL (14개 테이블, 34개 인덱스) |
| 프론트엔드 | 정적 HTML/JS (Cloudflare Pages) |
| 인증 | JWT (jsonwebtoken / bcryptjs) |
| 외부 API | Google Sheets API, Google Drive API |
| 스케줄러 | node-cron (인덱스 자동 빌드) |
| 배포 | Railway (서버) + Cloudflare Pages (프론트) |

## 완료된 기능 (Phase B+C+D)

### API 엔드포인트 (40+)
| 카테고리 | 엔드포인트 | 설명 |
|----------|-----------|------|
| 헬스 | GET /health | 서버 상태 (DB, Google, 메모리) |
| 검색 | GET /api/search | 리뷰어 검색 (이름/전화번호) |
| 인덱스 | GET /api/index/status | 인덱스 상태 조회 |
| 인덱스 | POST /api/index/build | 인덱스 빌드 (증분/전체) |
| 탭 설정 | GET/POST /api/tab/config | 탭 설정 CRUD |
| 탭 설정 | POST /api/tab/force-done | 강제완료 처리 |
| 탭 설정 | POST /api/tab/closed | 마감 처리 |
| 탭 설정 | GET /api/tab/options | 탭 옵션 목록 |
| 리뷰어 | POST /api/reviewer/register | 리뷰어 등록 |
| 리뷰어 | GET /api/reviewer/verify | 전화번호 인증 |
| 리뷰어 | GET /api/reviewer/list | 리뷰어 목록 |
| 리뷰어 | POST /api/reviewer/profile | 프로필 관리 |
| 관리자 | POST /api/admin/login | 관리자 로그인 (JWT) |
| 관리자 | POST /api/admin/users | 관리자 CRUD |
| 관리자 | POST /api/admin/staff-login | 영업담당자 로그인 |
| 관리자 | POST /api/admin/staff-users | 영업담당자 CRUD |
| 관리자 | GET /api/admin/dashboard | 대시보드 데이터 |
| 관리자 | POST /api/admin/release-lock | 빌드 잠금 해제 |
| Drive | POST /api/drive/sync-* | 폴더 동기화 |
| 단축URL | POST /api/short/create | 단축URL 생성 |
| 단축URL | GET /api/short/resolve | 단축URL 해석 |
| 메모 | GET/POST/DELETE /api/memo | 메모 CRUD |
| 입금 | GET /api/payment/targets | 입금 대상 조회 |
| 입금 | POST /api/payment/mark-done | 입금 처리 |
| 제출 | POST /api/submit/review | 리뷰 제출 |
| 제출 | POST /api/submit/order | 구매양식 제출 |
| 블랙리스트 | POST /api/blacklist | 블랙리스트 관리 |
| 진단 | GET /api/diag/* | 디버그 엔드포인트 |

### 데이터베이스 (14개 테이블)
| 테이블 | 설명 | GAS 대응 |
|--------|------|----------|
| campaigns | 캠페인 목록 | 베이스시트 |
| tab_configs | 탭별 설정 | 세부목록 탭 |
| review_index | 검색 인덱스 | 검색인덱스 탭 |
| index_master | 인덱스 메타 | 인덱스마스터 탭 |
| reviewers | 리뷰어 회원 | 인애드명단 |
| admin_users | 관리자 계정 | PropertiesService |
| staff_users | 영업담당자 | PropertiesService |
| memos | 메모 | 시트별 메모 |
| short_links | 단축 URL | PropertiesService |
| blacklist | 블랙리스트 | 시트/PropertiesService |
| payment_records | 입금 이력 | - |
| order_submissions | 주문 이력 | - |
| build_locks | 빌드 잠금 | LockService |
| app_settings | 앱 설정 | PropertiesService |

### 프론트엔드 파일
| 파일 | 설명 |
|------|------|
| index.html | 관리자 대시보드 (811KB) |
| search.html | 리뷰어 검색 (570KB) |
| staff.html | 영업담당자 (71KB) |
| viewer.html | 뷰어 (32KB) |
| recruit.html | 리크루팅 (16KB) |
| api.js | GAS→Node.js API 통신 모듈 (14KB) |

## 프로젝트 구조
```
webapp/
├── frontend/              # Cloudflare Pages 정적 파일
│   ├── api.js             # gasGet/gasPost → fetch 매핑 (40+ 액션)
│   ├── index.html         # 관리자 대시보드
│   ├── search.html        # 검색 페이지
│   ├── staff.html         # 영업담당자 페이지
│   ├── viewer.html        # 뷰어
│   ├── recruit.html       # 리크루팅
│   └── _headers           # Cloudflare 보안 헤더
├── server/                # Railway Node.js API 서버
│   ├── index.js           # 엔트리 (graceful shutdown)
│   ├── src/
│   │   ├── app.js         # Express 앱 (미들웨어, 라우터, 헬스체크)
│   │   ├── routes/        # 10개 라우트 파일
│   │   ├── services/      # 6개 서비스 (auth, search, indexBuilder, reviewer, sheets, drive)
│   │   ├── middleware/     # 4개 미들웨어 (auth, cors, error, rateLimit)
│   │   ├── utils/         # 유틸 (gasCompat, checksum, logger)
│   │   ├── db/            # pool.js, migrate.js
│   │   └── jobs/          # cron.js (인덱스 스케줄러)
│   ├── migrations/        # DDL SQL
│   ├── scripts/           # 마이그레이션/테스트 스크립트
│   ├── Procfile           # Railway 배포
│   ├── railway.json       # Railway 설정
│   └── package.json       # v2.0.0
├── .env                   # 환경변수 (gitignore)
├── .env.example           # 환경변수 템플릿
├── ecosystem.config.cjs   # PM2 설정
└── README.md
```

## Railway 배포 가이드

### 1. Railway 프로젝트 생성
```bash
# Railway 대시보드에서 새 프로젝트 생성 → GitHub 연결 (root directory: server)
# 또는 Railway CLI 사용
```

### 2. PostgreSQL 플러그인 추가
```
Railway 대시보드 → Add Service → PostgreSQL
→ DATABASE_URL 자동 주입
```

### 3. 환경변수 설정 (필수)
```
JWT_SECRET=<강력한 랜덤 32자 이상>
MASTER_ADMIN_NAME=master
MASTER_ADMIN_PW=<마스터 비밀번호>
GOOGLE_SERVICE_ACCOUNT_EMAIL=<서비스 계정 이메일>
GOOGLE_PRIVATE_KEY=<서비스 계정 프라이빗 키>
BASE_SHEET_ID=1YW2KgPo-fvwBUS1nuzWTutqE_n2RVAnHPXXYVn4o2i4
DRIVE_ROOT_FOLDER_ID=1afBtCDYs-A-LenIKhsiKJWvkuFmUYV8d
ALLOWED_ORIGINS=https://review-web-system.pages.dev
NODE_ENV=production
```

### 4. 배포 후 마이그레이션
```bash
railway run -- npm run migrate          # DDL
railway run -- npm run migrate:detail   # 세부목록 → tab_configs
railway run -- npm run migrate:reviewers # 인애드명단 → reviewers
```

### 5. api.js URL 업데이트
```javascript
// frontend/api.js 의 return 값을 Railway URL로 변경
return 'https://<your-app>.up.railway.app';
```
→ Cloudflare Pages 재배포:
```bash
npx wrangler pages deploy frontend --project-name review-web-system
```

## 통합 테스트 결과
```
✅ 34개 통과 / ❌ 0개 실패 / 총 34개
  헬스체크, 관리자 인증, CRUD (admin/staff/reviewer),
  탭 설정, 검색, 인덱스, 메모, 단축URL, 입금처리,
  블랙리스트, 대시보드, 빌드잠금, 진단
```

## 미구현/추가 예정
- [ ] Railway 프로덕션 배포 (Railway 계정 및 PostgreSQL 플러그인 필요)
- [ ] Google Service Account 실제 연동 (이메일 + 프라이빗 키 설정 필요)
- [ ] 데이터 마이그레이션 실행 (Google Sheets → PostgreSQL)
- [ ] 이미지 분석 AI API 연동 (extractOrderImage)
- [ ] 이미지 Drive 업로드 구현 (uploadOrderImage)
- [ ] 프론트엔드 기능별 세부 테스트

## 최종 업데이트
- **날짜**: 2026-04-16
- **버전**: 2.0.0
- **상태**: 개발 서버 운영 중 (Sandbox + Cloudflare Pages)
