# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 따르는 지침입니다.

## 프로젝트 개요
GAS(Google Apps Script) 기반 리뷰 관리 시스템을 **Node.js Express + PostgreSQL**로 이관한 프로젝트입니다.
- **백엔드**: Node.js + Express + PostgreSQL → Railway 배포
- **프론트엔드**: Vanilla JS + HTML → Cloudflare Pages 배포 (https://review-web-system.pages.dev)
- **인증**: JWT (`/api/admin/login` 발급, `Authorization: Bearer` 헤더)

## 디렉터리 구조
- `frontend/` — 정적 페이지(`admin.html` 관리자 대시보드, `portal.html` 업무포털, `search.html` 리뷰제출, `staff.html` AE담당자 등)와 `js/`, `css/`. `docs/prd-userflow.html` = 시스템 소개서(PRD·유저플로우·와이어프레임, 관리자 헤더 "시스템 소개서" 버튼에서 새창 열람)
- `frontend/api.js` — GAS 호환 API 래퍼(`gasGet`/`gasPost`), 토큰은 `sessionStorage.admin_token`
- `server/src/routes/` — Express 라우트(`*.routes.js`), `server/src/middleware/auth.middleware.js`에 역할별 미들웨어(master/admin/staff)
- `server/migrations/` — DB 마이그레이션
- `.github/workflows/` — DB/Drive 백업·복구 리허설 (앱 빌드/배포 워크플로 아님)

### 리뷰 이미지 ↔ 인덱스 연결 (데이터 모델)
- 리뷰 캡처는 `AI_REVIEW_FOLDER → {시트제목} → {탭명} → [리뷰]` 폴더에 저장(`drive.service.js`의 `ensureReviewFolderPath`). 업로드 시 폴더ID를 못 잡으면 루트로 새므로 `uploadFileBase64`가 빈 `parentFolderId`를 차단한다.
- `review_index.review_file_*`(031, A-1): 제출 행당 대표 리뷰 이미지 1장(파일ID/URL/이름/개수/시각). `review-upload`가 업로드 즉시 기록.
- `review_submissions`(032, A-2): 리뷰 이미지 파일 단위 원장(탭/행/리뷰어/파일ID/제출시각/출처). `file_id` 유니크 업서트로 재실행 안전.
- 과거에 루트로 샌 캡처는 관리자 "리뷰 캡처 정리"(`POST /api/drive/relocate-orphan-reviews`)로 `[리뷰]` 폴더 이동 + 파일명 이름↔행 결정적 링크 백필(모호하면 링크 안 함).

### 리뷰어 홈 "리뷰 내역" 제출대기/제출완료 탭
- `index.html` 내정보/현황의 리뷰 내역은 `GET /api/search?includeSubmitted=1`로 대기+완료를 한 번에 받아 `isSubmitted`로 좌우 서브탭(기본 [제출대기]) 분리. 완료 카드는 클릭/이동 없음(초록 배지) + `review_index.review_file_at` 기반 제출일 표시 + **입금 데이터가 채워진 행은 "입금완료" 남색 배지 병기**(`isPaid` = `is_submitted2='PAID'` 또는 row_json 입금 키워드 컬럼 값 존재 — 대시보드 집계와 동일 판정, row 비우기 전 서버에서 계산). 다중 캡처 슬롯 부분 제출은 대기 탭에서 "n/m 제출" 배지. bfcache 복귀(pageshow persisted) 시 재조회.
- **보안 가드**(`/api/search`는 무인증): 제출완료 행은 **phone8/participation_links 정확 일치 매칭에만 포함**(이름 단독·이름+전화근접 약한 키엔 미개방 — 이름만으로 타인 제출이력 스크래핑 차단), 완료 행의 `row`(행 전체 JSON)는 비워 반환(데이터 최소화). includeSubmitted 시 LIMIT 400 + `is_submitted ASC` 정렬(대기 건 절단 보호, 절단 시 완료 탭 하단 고지). 회귀가드 `tests/searchSubmittedGuard.test.js`.
- 한계: 완료 탭은 활성 `review_index`의 뷰 — 차수/탭 아카이브 시 해당 완료 내역은 화면에서 사라진다(archive 테이블 미조회). 과거 오염 `participation_links`가 완료 탭에 재부상할 수 있으므로 필요 시 `POST /api/diag/participation-cleanup`(dryRun 먼저) 권장.

### 리뷰어 직접참여 캠페인 (participation_mode) — M1 백엔드 (PRD: `frontend/docs/prd-reviewer-participation.html` v1.2)
- **모델**: `recruit_campaigns.participation_mode=true` 공고만 신규 경로. **레거시(false)는 현행(카톡 신청·current_slots·시트 행추가) 완전 유지**(분기). migration 045: 시간창(`window_start/end` TIME·KST, `close_buffer_min` 10, `hold_ttl_min` 15)·`daily_limit`·`recruit_total`(0=무제한)·`thumbnail_url`·`landing_url`·`work_detail`(JSONB 스냅샷, 신청 후 공개) + `campaign_applications` 홀드 라이프사이클(`applied→submitted/expired/cancelled`, `phone8` 서버파생, `expires_at`, `hold_token`, `order_submission_id`/`late_order_id`는 **UUID**) + 구 UNIQUE DROP·레거시 보호 부분유니크(`uq_campaign_apps_legacy` confirmed 전용)·`uq_campaign_apps_active_hold`(applied/submitted).
- **상태엔진**(`campaignState.service.js`, 무저장 계산): legacy/preopen/open/cutoff/daily_done/soft_full + **closed만 영속**(제출확정 도달 시 status 저장 — 비단조 플립 방지). `dailyQuota = min(daily_limit, recruit_total−전일까지 누적확정)` **KST 일시작 고정**(이중차감 금지). 유효홀드 = `applied AND expires_at>now()` **시각 기준**(스윕은 정리용 — 크론 죽어도 카운터 무오염). 회귀가드 `tests/campaignState.test.js`.
- **홀드 파이프라인**(`campaignHold.service.js`, 레드-블루-심판 산출): 잠금 계층 고정 = **recruit_campaigns 행 FOR UPDATE → 신청 행**(apply·주문확정·수동확정 공통 — write-skew·교착 동시 제거). apply는 잠금 후 재집계→게이트(등록 리뷰어 검증, **당일 재신청 0회**(상태 무관 이력), 활성홀드 상한 2, 당일 신청총량, holdToken 발급). 제출확정은 `POST /api/submit/order`의 `campaignHold` 문맥 → `createOrderLedgerEntry` **단일 tx + SAVEPOINT 격리**(홀드확정 실패해도 **주문 손실 0**) → 소유권 3중검증(applied·grace 30s·phone8·연결탭 gid우선) 통과 시만 submitted. 만료 후 도착 = `late_order_id` 표기 → **관제 수동확정(`POST /api/campaign/admin/:id/confirm`)이 유일 구제**(유예 정책 없음). 스윕 cron 매분(`withJobLock('campaign_hold_sweep')`, SKIP LOCKED). 주문취소(diag order-cancel)는 확정 홀드를 cancelled로 반환(closed 자동 재오픈 금지). 회귀가드 `tests/campaignHoldGuards.test.js`.
- **보안/부하**: `GET /api/campaign/list·/:id` 공개 화이트리스트(참여형은 chat_url·notes·총원계열 미반환; admin JWT는 전체), `/:id/applications` count만, campaign admin 라우트 adminOrMaster. 작업내용은 `GET /:id/work-detail?phone8&holdToken`(이중 열쇠, sanitize-html 정화) 게이트 뒤에만. `app.set('trust proxy',1)` + 전역 리미터 skip은 `baseUrl+path` 판정(마운트 스트리핑 함정 — 구 `/api/index/` skip은 dead code였음) + list 5초 캐시 + apply/detail 리미터 phone8 키. 참여형 활성화 게이트: gid·시간창·daily_limit 없이 active 불가(status·COALESCE 편집 양 라우트).
- M2(카드/상세/인라인 iframe)·M3(발행 폼 스냅샷·관제 위젯) 미착수 — work_detail 채우는 경로는 M3까지 없음.

### 컬럼감지 SoT (컬럼 판정 DB화 1단계) — 매핑 우선 · 키워드는 부트스트랩/폴백
- 리뷰 인덱스의 컬럼 감지(`columnResolver.parseTabRows`, 두 빌더 공용)는 **DB매핑(`tab_column_mappings`) 우선 → 키워드 폴백**. DB 오버라이드 6필드 = recipient/review_submit/product/phone/round/payment. **name은 PII 가드로 영구 키워드 전용**(테스트 케이스 9). 매핑은 재앵커(저장 헤더==현재 헤더)·범위가드 통과 시만 신뢰.
- **자동기록(detection snapshot)**: `COLUMN_MAPPING_AUTO_RECORD=1`이면 빌더가 매핑 없는 탭에서 "방금 키워드가 고른 컬럼"을 `recordDetectedMappings`로 기록(원자 `WHERE NOT EXISTS`+`ON CONFLICT DO NOTHING` = **수동 매핑 절대 미덮어씀**, `updated_by='auto:detect'`, **checksum 무효화 없음** — 기록≡키워드 결과라 재파싱 불필요). 전 탭 백필 = 플래그 켜고 `smart-build/run {force:true}` 1회(또는 04:00 전체 리빌드 대기). ★ `autoGuessField`(매핑 UI 추측) 기반 백필 금지 — resolver와 시맨틱 불일치(예: '입금자명').
- **관측(migration 044)**: 빌더가 `index_master.detect_source`(필드별 col/header/src)·`detect_drift`(매핑 거부 사유)·`detected_at` 기록 + 드리프트 `logger.warn`(무로그 폴백 해소). `GET /api/mapping/coverage`·`/drift`(admin/master), 관리자 설정탭 "컬럼매핑 현황" 카드, 캠페인탭관리 인원/제출 셀 ⚠배지. 교정은 raw-mirror.html 컬럼 매핑 에디터(`?sheetId=&gid=`로 탭 preselect+에디터 자동 오픈).
- **무변경 보장**: 기록된 매핑 ≡ 키워드 결과(회귀가드 `tests/columnResolver.test.js` 케이스 12 = 기록→재파싱 deepEqual, `tests/columnMappingRecord.test.js`). 2단계(집계 소스 DB 원장 전환, `tab_configs.source_of_truth` 활용)는 1단계 게이트 통과 후 별도 작업.

### 구매양식 "제공정보" 추가안내 (제공정보 메모 · 회사 사업자번호)
- `tab_configs.provider_memo`(034): 탭별 자유 텍스트 "제공정보 메모"(진행방식 안내·특이사항 통합). 관리자 대시보드 탭설정 팝오버에서 편집. 구매양식 제출화면(`search.html`)의 "📦 제공정보" 카드에 표시되며 **공란이면 영역 미노출**.
- `app_settings.company_business_no`: 회사 공통 사업자번호 1개(관리자 "설정" 탭에서 편집, `POST /api/tab/company-business-no` = admin/master). 진행방식(`income_type`)이 **현영 포함(사업자현영)** 인 탭에서만 "지출증빙 현금영수증 발행 필수" 안내와 함께 노출.
- 폼은 진입 시 `GET /api/tab/provider-info?sheetId&tabName`(무인증, DB만 조회)로 `providerMemo/incomeType/companyBusinessNo`를 받아 렌더(`_loadProviderInfo`). 메모 URL은 `_linkifyMemo`로 링크화하되 href 속성 breakout XSS 방지(따옴표 제외 매칭).

### 폴더 소유권 & 자동 생성 (예방)
- 폴더/파일은 **OAuth(`DRIVE_OAUTH_REFRESH_TOKEN` = tnaks6325) 우선 → 실패 시 SA 폴백**으로 생성된다(`createFolder`/`uploadFileBase64`). `_normalizeOwner`가 생성 직후 소유자를 `DRIVE_OWNER_EMAIL`로 보정한다(SA→tnaks 이전은 구글이 막아 무시될 수 있음 — 그래서 OAuth 우선이 핵심).
- 폴더는 ① 첫 업로드 시 on-demand(`review-upload`), ② 배치(`POST /api/drive/sync-review`·`sync-capture`), ③ **스마트빌드 주기마다 자동**(`reviewFolders.service.js`의 `ensureReviewFoldersForActiveTabs`, `smartBuild` 말미 best-effort)로 생성된다. ③ 덕분에 **신규 활성 탭은 제출 0건이어도 tnaks 소유 `[리뷰]`/`[구매캡처]` 폴더가 미리 생성·연결**된다(비파괴·idempotent, `리뷰폼` 탭 제외, 1주기 최대 30탭).
- 관리자 점검: "리뷰폴더 현황 점검"(`POST /api/drive/folder-audit`)이 연결/정상/빈/미연결 + **폴더 소유자 집계**(tnaks/박세희/박은비/SA)를 보여주고, 미연결 탭은 현황 화면의 버튼으로 일괄 생성·연결한다. 파일 단위 소유자·용량은 "소유권"(`ownership-audit`/`transfer-ownership`)에서 확인·이관한다.

### 시트/Drive API throttle — lane 분리 (쿼터 근본해결)
- `utils/sheetsThrottle.js`는 **2-lane**: ① **sheets lane 45/분**(`throttledCall` — spreadsheets.* 전용, `SHEETS_ORDER_RESERVE`(8)·저우선 서브캡·`getThrottleStatus()` 시맨틱 불변), ② **drive lane 120/분**(`driveThrottledCall` — `getSheetModifiedTime`(drive.files.get)/`shareSheetWithServiceAccount`(drive.permissions) 전용, 평평한 cap). **Drive API는 별도 쿼터인데 과거 시트 lane을 오점유**(smartBuild가 5분마다 시트 ~57개 modifiedTime 폴링 = 모니터 "리뷰인덱스빌드 33/분"의 정체)하던 것을 이관. env: `DRIVE_REQUESTS_PER_MINUTE`.
- **팬텀 슬롯 제거**: `concurrentMap`(무기록 동시성 map, allSettled 계약) — fn 내부가 스스로 `*ThrottledCall` 하는 호출처(rawMirror/indexBuilder/indexScan)는 map 레벨 슬롯 기록 없이 실 API콜만 계량. `throttledMap`은 레거시(내부 throttle 없는 fn 전용)로 유지.
- `getThrottleStatus()`는 **시트 lane 전용 계약**(busy-gate 소비처들이 "시트 여유"로 해석) — drive 필드 추가 금지. 모니터(`getThrottleMonitor`/`throttle-monitor.html`)는 시트 lane 기존 필드 불변 + `drive:{…}` 하위객체(구백엔드 응답이면 프론트가 Drive 카드 자동 숨김).
- 부속 방어(레드-블루-심판): RAW미러 cron은 **부팅유예 2분**(`RAW_MIRROR_BOOT_GRACE_SEC`) + **`withJobLock('raw_mirror_all')` 인스턴스 직렬화**(rolling 배포 이중미러 차단) + bulk 사이클 중 시트 lane>`RAW_MIRROR_YIELD_THRESHOLD`(30)면 시트 단위 연기(`sheetsDeferred`, 단일미러/`_triggerSheetMirrorOnce`는 미적용=자가치유 보존). smartBuild·rawMirror의 Drive 변경감지 **연속실패 ≥`*_DRIVE_FAIL_SKIP_AFTER`(2)면 "변경 간주" 대신 그 시트 1사이클 skip**(drive 장애→풀리드 폭풍 전이 차단). 'RAW미러'도 저우선 라벨 기본 포함(주문 예약 8슬롯 보호). 회귀가드 `tests/throttleLanes.test.js`·`tests/driveLaneCallsites.test.js`.
- **정기 인덱스빌드 시트 lane 추가 감축**(smartBuild): ① **modifiedTime 캐시 영속화**(`app_settings.smart_build_modified_cache`, 사이클 말미 스냅샷·첫 실행 복원) — 재배포마다 "전 시트 변경 간주" 콜드스타트 스윕(~30콜/분 수 분) 제거. `resetSmartBuildCache`는 영속 키 삭제+1회성 복원스킵 플래그로 강제 전체갱신 의도 보존. ② **시트 lane 중간 양보** — 변경시트 처리 중 사용량>`SMARTBUILD_YIELD_THRESHOLD`(25)면 남은 시트 연기+캐시 무효화(다음 주기 재감지=유실 없음). 관리자 강제실행/DB재구축은 `runSmartBuild({noYield:true})`로 완주. ③ **실패 시트 캐시 무효화**(미반영 데이터가 "반영됨"으로 영속되는 것 방지, 연속 `SHEET_ERR_RETRY_CYCLES`(3) 초과 시 재시도 중단 — 백스톱 04시 전체빌드). ④ 주기 env `SMART_BUILD_INTERVAL_SEC`(기본 300). 제출 헤드룸을 env만으로 더 늘리려면 `SHEETS_ORDER_RESERVE` 상향(8→15 등). 회귀가드 `tests/smartBuildQuota.test.js`.

### 구매양식 제출 = DB-first 원장 + 시트 비동기 미러 (order-ledger)
- 구매양식 제출(`POST /api/submit/order`)은 **DB(`order_submissions`)에 먼저 확정**(`orderLedger.service.js`의 `createOrderLedgerEntry`) → RAW 미러(`raw_sheet_tabs.detected_headers`/`raw_sheet_rows`) 기반으로 행을 **원자적 배정**(`claimRow`, `sheet_row_claims` 행/dedup 2중 유니크 = 멱등·중복행 불가) → `enqueue('order_append')` → 큐 워커가 throttle(`sheetsThrottle`, 45/분)로 시트에 기록. 시트 통읽기 없음 = 쿼터 안전.
- 주문 상태는 `order_submissions.mirror_status`: `pending`→`queued`→`written`, 또는 행 배정 실패 시 `pending_no_row`, 쓰기 실패 시 `failed`.
- **데이터 손실 방어(레드/블루/심판 P0)**: ① **dedupKey osid 폴백**(`computeDedupKey`) — 주문번호 6자리 미만(쿠팡 비번호/분할주문)이면 `osid:<id>`로 별개 주문을 별개 행에 배정(같은 행 공유로 한 건 소실 차단). reconcile은 `row.dedup_key` 재사용으로 멱등 유지. ② **다중컬럼 가드**(`buildMirrorGuardRanges` — 연락처+주소+수취인) + 쓰기 직전 **그리드 캐시 무효화**(`invalidateSheetMeta`) — 한 칸만 보던 수동입력행 덮어쓰기 + 그리드밖 stale `[]`오판 차단. 차단 시 claim 해제 → 다음 reconcile이 더 아래 행 재배정. ③ **동명탭 보류** — gid 없이 동명 탭 다수면 오배정 대신 보류(`pending_no_row`, 미러로 gid 채워질 때까지 자가치유). ④ **42P01(claims 테이블 부재) 배정 금지** — 부팅 윈도우에 무검증 배정 대신 보류.
- **멀티인스턴스/동시성 방어(#1·#2)**: ⑤ **큐 클레임 원자화(#2)** — `processQueue`/`drainTabQueue`가 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`로 batch를 한 번에 `processing` 점유(`syncQueue.service.js`). 멀티워커/멀티인스턴스(또는 rolling 배포 중 old+new 공존)에서 같은 큐항목 이중처리(중복행)·정체 차단. 클레임은 `attempts`를 올리지 않고 실행 직전에 +1(원본 시맨틱), `processed_at=NOW()`로 stuck-detector(매시 `retryAllFailed`) 오리셋 방지. Quota 에러로 배치 중단 시 남은 점유분은 `pending` 복원. ⑥ **reconcile 직렬화(#1)** — `utils/jobLock.js`의 `withJobLock('order_reconcile', …)`(`pg_try_advisory_lock`, 전용 커넥션, busy면 즉시 양보)로 cron reconcile·인라인 `_triggerSheetMirrorOnce`·`order-reconcile`/`order-flush-tab` reconcile을 하나의 락으로 직렬화 → 동시 행배정 경합(churn/stall) 제거. `dryRun`은 락 불필요. unlock 실패 시 커넥션 폐기로 락 강제 해제(락 누수 방지).
- **막힌 주문 자동복구(reconcile)**: `reconcileStuckOrders()`가 `pending_no_row`/`failed`/정체 `queued` 주문을 찾아 행 재배정 후 재큐잉. cron `*/2`(RAW 미러 `*/5` **뒤**에 둠 — 메타 채워진 뒤 복구, throttle busy면 양보) + 관리자 강제 `POST /api/diag/order-reconcile`(admin/master). **메타 없는 탭은 skip**(다음 RAW 미러까지 자가치유). **복구분은 시트 하단에 append + 비고란 `system` 표기**(`_markSystemMemo`, 배경색 없음)로 기록해 직원 수동입력분·중복과 구분(기존 메모 보존·멱등). 평상시 실시간 주문은 제자리(in-place).
- **가드차단 자동 재배정(기본 ON) + 시트 변경 감지** (7/2 사고 재발방지, 레드-블루-심판 설계): 다중컬럼 가드가 쓰기를 차단하면(배정행이 타인 데이터 = 시트 수동 재배치 등) `_guardBlockDecision`이 defer/release/giveup 결정 — ① 제출 `ORDER_BLOCK_GRACE_SEC`(90s) 미경과 실시간건은 **defer**(일시 write 경합 오판 방지), ② 경과·복구분은 **release**(큐 done 먼저→claim 해제·`sheet_row` NULL·failed→reconcile이 하단 빈 행 재배정(비고 `system` 표기) = **남의 데이터 절대 안 덮고 빈 행 폴백**), ③ `reassign_count`(migration 043) ≥ `ORDER_MAX_REASSIGN`(5)이면 **giveup**→`mirror_status='stuck_manual'`(수동입력 대상, reconcile·스케줄러 제외 = 무한 append 종결). 끄려면 `ORDER_GUARD_REASSIGN=0`. `stuck_manual`은 현황 위젯 🚨배너+`needManual`+수동CSV(`order-stuck-export`)로 능동 노출. **차단 발생 = 시트 변경 신호** → `triggerSheetMirrorOnce`(60s/시트 debounce)로 그 시트 자동 재미러+리컨실 = 관리자가 시트를 손으로 편집해도 새로고침 클릭 불필요(백스톱: RAW 미러 cron `*/5`). throttle은 `SHEETS_ORDER_RESERVE`(8)로 리뷰인덱스빌드(저우선 서브캡 45-8=37)가 주문쓰기 슬롯을 못 굶김.
- 관리자 가시성: `GET /api/diag/order-mirror-status`(카운트+막힌탭+`hasRawMeta`+`tabGid`/`displayName`/`noRow`) + 대시보드 "구매주문 시트반영 현황" 위젯(원클릭 복구). 보조 진단: `GET /api/diag/order-written-sample?sheetId&tabName`(시트 반영 완료건을 `sheetRow`+주문자와 함께 — 복구행(비고 `system`) 육안 대조용). `GET /api/diag/order-stuck-export?sheetId&tabName`(admin/master, PII): 시트 미반영(written 아님) 주문의 전체 필드를 추출 — 자동복구가 수렴 못 하는 탭(예: 비연속 행 구조·가드 반복차단)에서 직원 수동 입력용 목록 확보.
- **탭 리네임 복구**: 시트 탭 이름이 바뀌면(예 `…100건`→`…81건`) gid 없이 저장된 옛 주문이 현재 탭과 매칭 안 돼 영구 적체됨. `POST /api/diag/order-relink {sheetId, fromTabName, toTabGid, toTabName?, dryRun?}`(admin/master)가 막힌 주문의 `tab_gid`/`tab_name`을 현재 탭으로 backfill + `sheet_row` 초기화 → 이후 reconcile이 현재 탭 하단 빈 행(비고 `system`)으로 복구. `loadRawTabContext`는 메타가 비어도 저장된 RAW 행에서 헤더 재탐지(자가치유)하므로 gid/이름만 맞으면 RAW 재미러 없이 복구된다(`detected_headers` NULL = 단순 stale 스냅샷).
- RAW 전체 미러(`POST /api/raw/mirror {force}`)는 `campaigns`∪`tab_configs`에 등록된 시트만 순회(`rawMirror.service.js`). 미등록 시트의 막힌 주문은 reconcile 자가치유로 처리(전체 미러 불필요).
- **단일 시트 미러(`POST /api/raw/mirror {sheetId, force?}`)**: `sheetId`를 주면 등록 전체를 순회하지 않고 **그 시트만** 재읽기(`mirrorOneSheet`) → 특정 캠페인 RAW만 빠르게 갱신(시간 절약). inline 동기 실행이라 `{tabsMirrored,tabsSkipped,rowsWritten,errors}` 결과를 즉시 반환(전체 미러는 비동기+폴링). 한 캠페인만 stale일 때(예: throttle busy로 cron이 오래 못 미러한 탭) 이걸로 그 시트만 새로고침 후 reconcile/flush가 실제 행 끝에 정상 append.
- **탭별 구매양식(DB) CSV 다운로드**: 관리자 **RAW 미러 데이터 뷰어(`raw-mirror.html`)** 에서 탭 선택 시 **"구매양식 CSV"** 버튼 노출 → 그 탭에 **실제 제출된 구매양식(서버 DB `order_submissions`)** 을 CSV로 받는다(시트 미러가 아니라 원장 원본 — 시트 붙여넣기 일괄적용용). 인증 헤더 fetch→blob. 백엔드는 `GET /api/diag/order-stuck-export?sheetId&tabName&includeWritten=true&format=csv`(admin/master, PII; 상태·시트행·주문필드·제출시각 컬럼, UTF-8 BOM). 시트 미러 자체(raw_sheet_rows)를 받으려면 별도 `GET /api/raw/rows.csv?sheetId&gid`.
- `order-relink`의 `toSheetId`: sheet_id 자체가 손상된 주문(단축URL 혼입 등)을 올바른 시트로 이전할 때 사용(시트+탭 동시 정정).
- **백로그 가속 드레인(선택적)**: 큐워커는 평상시 항목당 2초 안전대기(`processQueue`의 `interItemDelayMs` 기본 2000 — 쿼터 보수)로 ~20/분. `POST /api/diag/queue-drain {maxMillis?, batchSize?}`(admin/master)는 그 대기를 **0(지수백오프 포함 전부 제거)**으로 두고 `sheetsThrottle`(45/분)만 가드로 삼아 더 빨리 빼낸다. throttle로 한 배치가 길어질 수 있어 **백그라운드 실행 후 즉시 응답**(HTTP 타임아웃 방지) + `_queueDrainRunning` 중복방지; 진행은 `GET /api/diag/queue-drain`(running/last/remaining)·현황 위젯으로 관찰. 관리자 대시보드 "구매주문 시트반영 현황" 위젯의 **"빠른 반영(가속)"** 버튼으로 온디맨드 실행. **상시 켜는 게 아니라 백로그 있을 때만**(라이브 이벤트 중엔 자제 — 평상시 cron은 그대로 보수적).
- **그리드밖 행 가드읽기 처리**: 복구 append가 현재 시트 그리드보다 아래 행(예 행 268, 그리드 167행)을 가드 읽기하면 `_readSheetByGridData`가 빈 결과를 반환한다(이전엔 `endRowIndex<startRowIndex` 로 "endRowIndex cannot be before startRowIndex" 에러 → 복구 무한실패). 그 행은 데이터 없음=가드 통과가 맞고, 쓰기측 `_batchWriteByGrid`가 `appendDimension`으로 그리드를 확장하므로 정상 기록된다.
- 리뷰어 참여조회(`GET /api/reviewer/my-status?phone8=`)는 **`review_index`(시트빌드) + `order_submissions`(DB) 병합**(phone8=연락처 끝8자리, sheet_row로 중복제거). 시트 반영 전 주문도 `stage:'processing'`로 노출 → DB-first라 리뷰어가 제출 즉시 자기 참여 확인 가능.
- **신원링크(시트행↔phone8) 기록은 "쓰기 성공 후"에만**(리뷰어 교차노출 버그 방어): 리뷰어 대시보드 "리뷰 내역"은 `searchAll`(`/api/search`, `searchByName(name,phone8)`)로 조회한다. 매칭 통과키 = `review_index.phone8`(P0) **또는 (`review_index.phone8`이 공란일 때에 한해) `participation_links.phone8`(P5 확정신원)**. ★ **시트 현재값(연락처=`review_index.phone8`)이 그 행의 소유자를 말하면 그것이 최종 진실이며, 재배정된 행의 stale 확정신원(pl)은 그 행을 열지 못한다**(교차노출 차단·fail-closed). `pl.phone8`은 로그인 phone8, `ri.phone8`은 연락처 컬럼 값이라 서로 다를 수 있는데, 과거엔 게이트 없이 `ri.phone8 OR pl.phone8` 단독 통과라 **한 행에 stale pl(옛 주인)과 현재 ri(새 주인)이 공존하면 그 행이 두 사람 모두에게 노출**됐다(예: 박은비의 옛 주문이 로스터 행에 written→pl=박은비, 이후 그 행을 양미경이 정상 사용→ri=양미경 인데 박은비 리뷰내역에 양미경 행이 뜸). **수정**: `search.service.js`(3분기+`searchByNameFallback`)와 `reviewEdit.routes.js`의 `_verifyRowOwnership`(무인증 리뷰이미지 열람/교체요청 게이트) **모두** pl 통과 조건을 `ri.phone8 IS NULL AND pl.phone8=ANY(...)`로 통일(시트 현재값 우선). 회귀가드 `tests/searchSubmittedGuard.test.js`(케이스 5=fallback 게이트, 6=stale pl 미개방/현재주인 개방 구조 고정). **트레이드오프**: 로그인번호≠주문연락처인 정당 케이스에서 그 연락처가 **미등록 타계정**이고 오직 pl로만 보이던 행은 이제 안 뜰 수 있음 → 타계정 등록으로 흡수(`my-status`는 원래 `ri.phone8`만 써 무영향). 상류(주문 행배정이 타 참여자 로스터 행을 first_available로 가져가는 `buildCandidateRows`/`isUnfilledOrderRow`)는 별도 후속 PR(라이브 쓰기 핫패스). 과거엔 구매양식 제출(`submit/order`)이 가드/시트쓰기 **전에** 낙관적 claim 행(`ledger.sheetRow`, RAW 미러 스냅샷의 "빈 행" 추정 — 미러 stale·로스터 선기입 시 *남의 행*)에 `recordParticipationLink`/`recordReviewIdentity`로 phone8을 선기입해 교차노출을 유발했다. **이제 제출 시점 선기입을 제거**하고, 신원기록은 **큐 워커(`syncQueue` `order_append`)가 다중컬럼 가드 통과 + 실제 시트쓰기 성공 후, 실제로 쓴 행에만** 수행한다(신뢰 가능한 링크만 남음). 과거 오염 정리: `POST /api/diag/participation-cleanup {sheetId?,tabName?,dryRun?}`(admin/master, 기본 dryRun=카운트만) — written 주문이 없는 `participation_links` 행(=가짜 신원링크) 삭제. `review_index.phone8` 오염은 강제 전체 재빌드(`POST /api/index/build {forceFullRebuild:true}`)로 시트 값 재유도.
- 운영 순서 규칙: **RAW 미러 → reconcile**(메타가 있어야 행 배정 가능). 메타 자동 공급은 3중: ① 탭 등록 시 `mirrorOneSheet`(#134), ② RAW 미러 cron `*/5`, ③ **미러 안 된 탭에 주문이 오면 `_triggerSheetMirrorOnce`가 그 시트만 백그라운드 1회 자동미러(탭당 60초 debounce) + 즉시 리컨실** — per-제출 라이브 시트읽기를 없애 버스트에도 시트 쿼터 안전(관리자 수동미러 불필요, 근실시간 자동동기화).

### 상시 배치 스케줄러 — 다탭 인터리브(공평) 드레인
- `orderBatchScheduler.js`의 `_cycle`은 기본 "탭 순차 드레인"(한 탭 끝까지 → 다음 탭)이지만, `ORDER_BATCH_INTERLEAVE=1`이면 `_cycleInterleave`로 **탭당 1청크(≤50행)씩 키기반 라운드로빈**(공평) — 다탭 동시버스트에서 뒤 탭이 앞 탭 뒤에 줄서 굶지 않게. reconcile은 사이클당 탭별 1회(`_reconcileOnce`, `order_reconcile` 락, `useLiveMaxRow`). `getDiag()`/`GET /api/diag/order-batch-state`로 사이클 이력(mode·busy·perTab·rounds) 관찰. **주의(레드-블루-심판으로 수정된 버그)**: throttle busy(>40)일 때의 폴백을 "첫 1탭 전체 드레인"으로 두면 그 탭이 throttle 제약으로 여러 사이클을 잡아먹어 나머지 탭을 수분 굶긴다 → 반드시 **busy도 "1청크/탭 한 라운드 후 양보"(busy-fair)**. 회귀가드 `tests/interleaveScheduler.test.js`.

### RAW 미러 비활성 시트 완화 (A)
- RAW미러의 유일 소비처는 주문 행배정(claimRow/loadRawTabContext/reconcile)이고 `smartBuild`(리뷰 인덱스)는 시트를 직접 읽어 RAW미러에 의존하지 않음. `RAW_MIRROR_INACTIVE_RELAX=1`(기본 OFF)이면 `INACTIVE_EVERY`(6) 사이클 중 5번은 "최근 `INACTIVE_DAYS`(30)일 내 주문 있는 활성 시트"만 미러, 비활성은 연기(6번째는 전체). 비활성 시트에 주문 오면 `_triggerSheetMirrorOnce`가 즉시 자동미러(자가치유). 요약에 `deferredInactive`.

### 시트→DB 역동기화 (옵션·수동·기본 OFF) — `SHEET_REVERSE_SYNC`
- 주문은 **DB-first**(order_submissions 원본 → 시트는 출력). 시트에서 주문 행을 손으로 고쳐도 DB는 자동 반영 안 함. 이를 보정하는 **옵션·수동** 안전망(레드→블루→심판 설계; 자동 무인 동기·자동취소는 **기각**).
- `migration 039`: `order_submissions.last_sheet_write_sig`(정방향 written 시 기록한 매핑칸 서명=R1 루프차단 provenance) + `reverse_sync_proposals`(제안 감사원장).
- `POST /api/diag/reverse-sync-detect`(읽기전용, gid 필수·throttle busy면 양보·`order_reconcile` 락·라이브 단일사각형읽기): 시트≠DB인 written·미취소·**기본 sig-not-null** 주문만 비교 → identity(연락처+수취인+주소) 통과 시 필드별 `edit` 제안, 전공란/그리드밖은 `cancel_suspect` 플래그만(자동취소 금지). `selected_opt_key`·옵션칸 제외(G4). open 제안 교체(DELETE→INSERT)로 멱등.
- `GET /api/diag/reverse-sync-list` 검토 → `POST /api/diag/reverse-sync-apply {proposalId}`(`ORDER_LEDGER_WRITE_ENABLED=true` 추가게이트): per-order 락 + `deleted_at`·`detected_edit_seq` 불변 재검증(G6) 후 화이트리스트 필드 직접 UPDATE + `enqueue('order_update')` 위임 → `order_update`가 `cur===wantNew` no-op(시트 안 건드림)으로 **핑퐁 0**. `reverse-sync-dismiss`로 기각. **권고: detect만 먼저 켜 제안량 관측 후 apply 활성**(효용 낮으면 기존 `order-edit`/`order-cancel` 관리자 정정으로 일원화가 더 안전).

### Track B — 구글시트 완전대체 백그라운드 평행 트랙 (그림자 → 전환) — 기본 OFF
구글시트(업체별 작업내역·작업세부 열람/편집, 접근자 AE·리뷰웹관리자·광고주)를 **단일 통합 UI + DB**로 무중단 대체하는 평행 트랙. 현 시스템(Track A)은 **그대로 두고**(변경 0), 라이브를 읽어 B 모델을 만들며 **추가만·읽기만·격리** 3원칙으로 라이브에 일절 무영향. 준비되면 작업별로 전환·폐기. 서비스 `trackB.service.js`, 라우트 `/api/trackb`(`trackB.routes.js`), 프론트 `frontend/workdesk.html`(2뷰: 작업대/소유지정), 마이그레이션 047·048. **라이브 코드가 Track B 참조 0**(되돌리기 = 마운트 제거 + 047/048 드롭).
- **부품1 격리저장소(047)**: `campaign_participants`에 정렬무관 `identity_key`·`order_submission_id`·`active`/`absent_since`(seen-set)·`first_seen_at`·`price` 추가. `advertiser_campaigns`(업체↔시트/탭 소유 1:N, `advertiser_id`=TEXT `advertisers.id` 참조; `tab_gid` NULL=시트전체). 세밀 분해조립(한 시트 여러 업체)은 후속.
- **부품2 그림자투영**(`projectTab`/`projectActive`, `TRACK_B_PROJECTION=1` 게이트): 검증된 `importTabFromIndex`(review_index→DB, 시트 재읽기 0) 재사용 + `_enrichTab`(내용키·order 링크) + `_reconcileSeen`(이번 임포트에 안 보인 import행 → `active=FALSE`, 하드삭제 아님). cron `TRACK_B_PROJECTION_SCHEDULE`(기본 `*/10`).
- **부품3 parity**(`parityReport`/`classifyParity` 순수함수, master): **phone8 짝짓기**(행번호 금지) → 일치 / 의도된차이(BD-3 dedup·BD-6 manual·BD-8 편집) / **진짜 불일치**. 게이트 = real 0. 준비도 `_readinessFor`(d4 작업발주 정형필드 충실도·d5 업체 소유 지정·d6 공용 주문원장 귀속)는 **data-parity(d1~d3) pass와 분리한 별도 신호**. 회귀가드 `tests/trackB.test.js`.
- **부품4 소유 UI**(adminOrMaster): `GET /advertisers`(소유수 포함)·`/tabs`(활성탭, participants/tabs가 master전용이라 재노출)·`/ownership` GET/POST/DELETE. workdesk.html 소유지정 뷰에서 업체 선택→시트/탭 지정·해제.
- **부품5 편집 가능 작업대(레드-블루-심판)** — `migration 048 participant_edits`: **오버레이-only + read-time 합성**. 편집을 `campaign_participants` 물리컬럼에 **절대 안 쓰고** 별도 원장에 저장 → `workdeskTab`이 읽을 때 합성. **정렬/재투영이 물리행을 덮어써도 편집 무손실·무오염**(교차노출 근본 차단). 편집은 **B 전용 리허설**(구글시트·주문·검색 무접촉).
  - **앵커 우선순위**: `order_submission_id`(불변 UUID) > `manual`(물리행 id, 재투영 면역) > `identity_key`(중복 아니면) > **거부**(`no_stable_anchor`/`ambiguous_identity`, fail-closed). seq(물리행) 앵커 금지 = 정렬 면역. `_deriveAnchor`가 편집/합성/revert 공유.
  - **안전장치**: bool은 `value_bool` 전용 컬럼(캐스팅 예외 차단, `to_jsonb(NULL::bool)=SQL NULL`이라 COALESCE 합성이 FALSE 보존)·부분유니크 `uq_participant_edits_active`(활성 1행 backstop, 23505→409)·단일 tx+대상행 FOR UPDATE·append-only `reverted_at`(감사 이력)·중복 identity read/write 양쪽 게이트·미부착(orphan) 편집 노출(조용한 증발 방지).
  - **동시성**: 편집 뮤테이션 `/workdesk/edit·/revert·/hide·/add`는 **adminOrMaster 라우트레벨**(staff·광고주 하드차단), `/workdesk` read는 master/admin/advertiser만(staff PII 봉합, 광고주는 소유 스코프+마스킹). 투영 cron·수동 bulk(`/project`, participants `/sync`)를 `withJobLock('trackb_project')`로 상호배제(멀티인스턴스 이중투영·seen-set 플래핑 차단, 락키 기존 6개와 비충돌). remove=import행 hidden 오버레이/manual행 soft-delete, add=manual 물리행(retry-on-23505로 seq 원자화). 회귀가드 `tests/participantEdits.test.js`.
- **활성화/전환 순서**: 머지→Railway 배포(마이그레이션 자동, 플래그 OFF=무영향) → master가 탭별 "그림자 투영"(또는 `TRACK_B_PROJECTION=1`)으로 B 채움 → parity real 0 + 준비도 충족 관측(권고 2주) → 작업별 `source_of_truth` 플립(cutover)로 그 탭만 Track B 원본화 → 안정 후 시트 폐기. 소유 매핑은 소유지정 UI로 하나씩 입력.

## 배포 (자동)
- `main` 브랜치에 머지되면 **Cloudflare Pages(프론트)와 Railway(백엔드)가 GitHub 연동으로 자동 배포**합니다.
- 별도의 빌드/배포 GitHub Action은 없습니다. `main` 머지 = 배포.

## 요구사항 확인 (질문 우선)
- **사용자의 입력 메시지에서 의미가 모호하거나 불확실한 부분이 있으면, 추측해서 진행하지 말고 반드시 먼저 질문해서 답을 받은 뒤 구현한다.**
- 한 번에 명확히 하기 위해 필요한 질문은 모아서 묻되, 답이 없으면 해당 부분의 구현을 시작하지 않는다.
- 질문이 필요한 예시: 변경 대상/범위가 애매할 때, 용어·기능명이 여러 의미로 해석될 때, 데이터 모델/엔드포인트 설계 선택지가 갈릴 때, UI 동작·문구가 특정되지 않았을 때.
- 단, 합리적인 기본값이 명백하거나 코드베이스에서 직접 확인 가능한 사실은 질문하지 말고 그 기준으로 진행한 뒤 결과에 명시한다.
- 큰 작업일수록 **목적·대상(독자/사용자)·성공기준(KPI)·제약**을 먼저 파악한 뒤 착수한다(질문은 모아서 묻는다).
- 이 규칙은 "사용자에게 다시 묻지 않고 자동 진행"하는 아래 워크플로보다 **우선**한다(불확실하면 먼저 질문 → 확정된 뒤 자동 워크플로 진행).

## 큰 작업의 진행 방식 (품질 강화)
범위가 크거나 복잡한 작업(여러 파일·엔드포인트·UI 흐름이 얽히거나 영향 범위가 넓은 변경)에 적용한다.
작고 명확한 변경에는 적용하지 않는다(위 자동 워크플로를 그대로 따른다).

### 과업 분해 & 종속성
- 큰 요청은 독립적으로 처리 가능한 작은 과업으로 쪼갠 뒤, **숨은 종속성과 올바른 순서**를 먼저 정리한다.
  - 예: `마이그레이션 → 라우트 → 프론트 연동 → 권한 검증` 순서, "스키마 확정 전 프론트 UI 확정 불가" 같은 제약.
- 분해 결과(과업 목록 + 순서)는 착수 전에 짧게 공유한다.

### 단계적 진행 (한 번에 다 쓰지 않기)
- 긴 문서·대규모 변경은 단번에 작성하지 말고 단계로 나눈다:
  ① **요구 정리**(목적·대상·핵심질문) → ② **조사/영향분석**(데이터·리스크·기존 코드 확인) → ③ **설계 개요**(섹션·모듈·엔드포인트 배치) → ④ **구현/최종본**.
- 각 단계에서 맥락을 충분히 확보한 뒤 다음 단계로 넘어간다.

### 다각도 비판 검토
- 구현·제안을 완료하기 전에 최소 세 관점에서 스스로 비판적으로 점검한다(필요 시 `code-reviewer`/`proposal-judge` 서브에이전트 활용):
  - **운영/보안 관점**: 역할 권한(master/admin/staff) 누락, 인증·토큰·데이터 노출, 되돌리기 어려운 작업의 위험.
  - **실사용자 관점**: 관리자·AE담당자·리뷰어의 실제 흐름에서 어색하거나 상황에 안 맞는 부분.
  - **운영 리스크 관점**: 자동배포 영향, 마이그레이션 리스크, 논리적 허점·엣지케이스.
- 검토에서 발견한 문제는 머지 전에 반영하거나, 반영이 어려우면 사용자에게 보고한다.

### 레드팀·블루팀·심판 (적대적 설계 프로세스)
라이브 핫패스 변경·최적화처럼 **오류 리스크가 큰 작업**은 다음 3역 적대적 프로세스로 설계·검증한다(서브에이전트 정의: `.claude/agents/red-team.md`·`blue-team.md`·`judge.md`).
- **레드팀**: 예상되는 오류 상황을 적대적으로 분석·제시(동시성·엣지케이스·쿼터·권한·데이터정합성·폴백소실). 읽기 전용.
- **블루팀**: 레드팀의 각 오류를 막는 방어 코드구조를 설계(레드 항목 1:1 대응 + 구체 코드). 읽기 전용 산출(텍스트 코드).
- **심판**: 레드↔블루를 대조 검증(빠진 방어·과잉 방어·새 위험 식별) 후 **오류 없는 최종 코드구조**를 구체 코드로 산출. 적용·테스트·배포는 메인루프가 한다.
- 실행: 워크플로 `Workflow({ name: 'red-blue-judge', args: { task: '...' } })`(`.claude/workflows/red-blue-judge.js`, 레드→블루→심판 순차) 또는 `Agent`로 역할별 개별 호출. 심판의 최종 코드를 메인루프가 적용→`node --check`/단위테스트→PR→머지.

### 맥락 유지 (CLAUDE.md 최신화)
- 디렉터리 구조·규칙·용어·워크플로가 바뀌면 그 변경의 일부로 이 `CLAUDE.md`를 함께 갱신해, 다음 작업에서도 맥락이 그대로 유지되도록 한다.

## 작업 워크플로 (기본 동작)
요청받은 변경을 완료하면 **사용자에게 다시 묻지 않고 아래를 자동으로 진행**합니다.
(작업 지정 브랜치가 있으면 그 브랜치에서, 없으면 `claude/<설명>` 브랜치를 만들어 작업)

> **표준 권한 부여 (standing authorization)**
> 이 저장소에서는 **PR 생성과 `main` 머지(=자동배포)를 사용자에게 매번 다시 묻지 않고 자동으로 수행**하도록 사전 승인합니다.
> "PR은 명시적으로 요청할 때만 생성한다"는 일반 기본동작보다 이 지침이 우선합니다.
> 단, 아래 **주의** 항목(파괴적/되돌리기 어려운 변경, 설계상 모호한 대규모 변경)에 해당하면 자동 머지 전에 먼저 확인합니다.

1. **커밋 & 푸시**: 명확한 메시지로 작업 브랜치에 커밋하고 `git push -u origin <branch>`.
2. **PR 생성**: 작업 브랜치 → `main` 으로 PR을 만든다.
3. **머지**: 생성한 PR을 `main` 에 머지한다 (→ 자동배포 트리거). **사용자 추가 확인 없이 자동 머지.**
4. **채팅 보고**: 머지/배포 후 **채팅방에 추가·수정된 내용을 간략히 보고**한다.
   - 형식: 변경 요약(불릿 2~5줄) + PR 번호/링크 + "배포 자동 진행 중" 한 줄.
   - 길게 늘어놓지 말고 핵심만. 파일 단위 변경은 필요한 것만 언급.

### 보고 예시
> ✅ 머지 완료 (PR #NN) — 자동배포 진행 중
> - 관리자 대시보드에 "업무포털" 버튼 추가 (AE담당자 왼쪽)
> - 클릭 시 자동 로그인되도록 토큰 핸드오프 구현

### 주의
- 파괴적이거나 되돌리기 어려운 변경(데이터 삭제, 시크릿 변경, 마이그레이션 파괴 등)은 자동 머지 전에 먼저 확인한다.
- 변경 범위가 크거나 설계상 모호한 부분이 있으면 머지 전에 사용자에게 확인한다.
- 커밋/푸시는 항상 작업 지정 브랜치 기준. `main` 에 직접 푸시하지 않는다(PR 경유).
