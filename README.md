# 리뷰웹시스템 — Node.js + PostgreSQL 이관 프로젝트

> GAS v10.5 → Node.js/Express on Railway + PostgreSQL + Cloudflare Pages

## 프로젝트 상태

| Phase | 상태 | 설명 |
|-------|------|------|
| **Phase 1** | ✅ 완료 | 서버 골격, DDL, 미들웨어, 유틸, 설정 |
| **Phase 2 (B)** | ✅ 완료 | 40+ 엔드포인트 비즈니스 로직 완전 구현 |
| Phase 3 (C) | ⏳ 예정 | 프론트엔드 gasGet/gasPost → fetch 교체 |
| Phase 4 (D) | ⏳ 예정 | 데이터 마이그레이션 (Sheets → PostgreSQL) |
| Phase 5 (E) | ⏳ 예정 | Cloudflare Pages 배포, Railway 배포 |

---

## 아키텍처

```
Browser → HTTPS → Cloudflare Pages (정적 HTML)
                        ↓
               Railway Node.js/Express API
                        ↓
              PostgreSQL + Google Sheets/Drive APIs
```

## API 엔드포인트 (40+)

### 검색/인덱스 (Section 5)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| GET | `/api/search?query=&phone8=` | ✗ | searchAll |
| GET | `/api/search/debug?query=` | ✗ | searchAllDebug |
| POST | `/api/index/build` | ✓ | buildIndexSmart |
| GET | `/api/index/status` | ✓ | indexStatus |

### 탭 설정 (Section 6)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/tab/config` | ✓ | setTabConfig |
| GET | `/api/tab/config` | ✓ | getTabConfig |
| POST | `/api/tab/force-done` | ✓ | setForceDone |
| POST | `/api/tab/closed` | ✓ | setClosed |
| GET | `/api/tab/options` | ✗ | getTabOptions |
| GET | `/api/tab/end-date` | ✗ | getTabEndDate |
| GET | `/api/tab/stats` | ✓ | getCampaignStats |

### 리뷰어 관리 (Section 7)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/reviewer/register` | ✗ | registerReviewer |
| GET | `/api/reviewer/verify` | ✗ | verifyReviewer |
| GET | `/api/reviewer/lookup` | ✗ | lookupPhone |
| GET | `/api/reviewer/list` | ✓ | getReviewerList |
| POST | `/api/reviewer/delete` | ✓ | deleteReviewer |
| POST | `/api/reviewer/profile` | ✗ | getReviewerProfile/saveSubAccounts/saveIncomeInfo |
| GET | `/api/reviewer/inaed-list` | ✓ | getInaedList (관리자) |

### 관리자 인증 (Section 8)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/admin/login` | ✗ | adminLoginV2 |
| POST | `/api/admin/staff-login` | ✗ | staffLogin |
| POST | `/api/admin/change-pw` | ✓ | adminChangePw |
| POST | `/api/admin/change-master-pw` | ✓(M) | changeMasterPw |
| POST | `/api/admin/users` | ✓(M) | add/edit/delete/listAdminUser |
| POST | `/api/admin/staff-users` | ✓(M) | add/edit/delete/listStaffUser |
| GET | `/api/admin/dashboard` | ✓ | dashboard |
| POST | `/api/admin/release-lock` | ✓ | releaseBuildLock |

### Drive 폴더 (Section 9)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/drive/sync-capture` | ✓ | syncCaptureFolders |
| POST | `/api/drive/sync-review` | ✓ | syncReviewFolders |
| POST | `/api/drive/sync-all` | ✓ | syncAllFolders |
| POST | `/api/drive/batch-create` | ✓ | batchCreateFolders |
| POST | `/api/drive/reset-folder-urls` | ✓ | resetTabFolderUrls |
| POST | `/api/drive/migrate-names` | ✓ | migrateFolderNames |
| POST | `/api/drive/organize-capture` | ✓ | organizeCaptureFolders |
| POST | `/api/drive/save-capture` | ✓ | saveCaptureFolder |
| POST | `/api/drive/update-urls` | ✓ | updateFolderUrls |
| GET | `/api/drive/diag` | ✓ | diagCaptureFolders |

### 단축URL / 메모 (Section 10)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/short/create` | ✗ | createShort |
| GET | `/api/short/resolve?code=` | ✗ | resolveShort |
| GET | `/api/memo` | ✗ | getMemo |
| POST | `/api/memo` | ✗ | saveMemo |
| DELETE | `/api/memo` | ✓ | deleteMemo |

### 입금처리 (Section 11)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| GET | `/api/payment/targets` | ✓ | getPaymentTargets |
| POST | `/api/payment/mark-done` | ✓ | markPaymentDone |
| GET | `/api/payment/history` | ✓ | (신규) |

### 제출/주문 (Section 12)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| POST | `/api/submit/review` | ✗ | submitReview |
| POST | `/api/submit/order` | ✗ | submitOrderForm |
| POST | `/api/submit/check-duplicate` | ✗ | checkDuplicateOrder |
| POST | `/api/submit/check-files` | ✗ | checkReviewFiles |

### 진단/기타 (Section 12)
| Method | Path | Auth | GAS 원본 |
|--------|------|------|----------|
| GET | `/api/diag/debug-tab` | ✓ | debugTabConfig |
| GET | `/api/diag/debug-sheet` | ✓ | debugSheet |
| GET | `/api/diag/debug-base` | ✓ | debugBaseSheet |
| GET | `/api/diag/campaign-list` | ✗ | campaignList |
| GET | `/api/diag/campaign-stats` | ✗ | getCampaignStats |
| GET | `/api/diag/inaed-list` | ✗ | getInaedList |
| POST | `/api/diag/add-campaign` | ✓ | addCampaign |
| POST | `/api/blacklist` | ✓ | blacklist |
| GET | `/api/viewer/viewer-data` | ✗ | getViewerData |
| POST | `/api/image/image-extract` | ✗ | extractOrderImage |
| POST | `/api/image/image-upload` | ✗ | uploadOrderImage |
| GET | `/health` | ✗ | (신규) |

---

## PostgreSQL 스키마 (14 테이블)

| 테이블 | 용도 | GAS 대체 |
|--------|------|----------|
| campaigns | 캠페인(베이스시트) 목록 | 작업목록 탭 |
| tab_configs | 탭별 세부 설정 | 세부목록 탭 |
| review_index | 검색 인덱스 | 검색인덱스 탭 |
| index_master | 빌드 메타/체크섬 | 인덱스마스터 탭 |
| reviewers | 리뷰어 회원 | 인애드명단 시트 |
| admin_users | 관리자 계정 | PropertiesService |
| staff_users | 영업담당자 계정 | PropertiesService |
| memos | 메모 | PropertiesService |
| short_links | 단축 URL | PropertiesService |
| blacklist | 블랙리스트 | PropertiesService |
| payment_records | 입금처리 이력 | (신규) |
| order_submissions | 주문 제출 이력 | (신규) |
| build_locks | 빌드 잠금 | LockService |
| app_settings | 앱 설정 | PropertiesService |

---

## 핵심 상수 (GAS 동일)

```
BASE_SHEET_ID = "1YW2KgPo-fvwBUS1nuzWTutqE_n2RVAnHPXXYVn4o2i4"
ADMIN_PW_DEFAULT = "931118"
SUBMITTED_VALUES = ["TRUE","true","1","제출","O","o","완료","Y","y"]
SHORT_CODE_LEN = 6
tab_key 형식: "sheetId||tabName" (구분자 유지)
```

---

## 파일 구조

```
webapp/
├── server/
│   ├── src/
│   │   ├── routes/        # 10개 라우터 파일
│   │   ├── services/      # 6개 서비스 (auth, sheets, drive, search, indexBuilder, reviewer)
│   │   ├── middleware/     # 4개 (auth, cors, error, rateLimit)
│   │   ├── db/            # pool.js, migrate.js
│   │   ├── jobs/          # cron.js
│   │   ├── utils/         # gasCompat.js, checksum.js, logger.js
│   │   └── app.js
│   ├── scripts/           # migrate-detail.js, migrate-reviewers.js
│   ├── migrations/        # 001_create_tables.sql (14 테이블)
│   ├── index.js, package.json, Procfile, railway.json
├── frontend/              # index.html, search.html, staff.html, viewer.html, recruit.html
├── .env.example
└── README.md
```

---

## 다음 단계

### Phase C: 프론트엔드 교체
- `gasGet(params)` → fetch GET to `/api/{endpoint}`
- `gasPost(body)` → fetch POST to `/api/{endpoint}`
- `_actionToEndpoint` 매핑 테이블 구현
- JWT 토큰 → `sessionStorage.admin_token` 저장/헤더 주입

### Phase D: 데이터 마이그레이션
1. PostgreSQL DDL 실행 (`node src/db/migrate.js`)
2. 세부목록 → tab_configs (`node scripts/migrate-detail.js`)
3. 인애드명단 → reviewers (`node scripts/migrate-reviewers.js`)
4. 인덱스 전체 재빌드 (`POST /api/index/build { forceFullRebuild: true }`)

### Phase E: 배포
- Frontend → Cloudflare Pages
- Backend → Railway (Node.js + PostgreSQL)
- Google Service Account 설정

---

**최종 수정: 2026-04-16 | 버전: v2.0.0 (Phase B 완료)**
