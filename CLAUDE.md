# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 따르는 지침입니다.

## 프로젝트 개요
GAS(Google Apps Script) 기반 리뷰 관리 시스템을 **Node.js Express + PostgreSQL**로 이관한 프로젝트입니다.
- **백엔드**: Node.js + Express + PostgreSQL → Railway 배포
- **프론트엔드**: Vanilla JS + HTML → Cloudflare Pages 배포 (https://review-web-system.pages.dev)
- **인증**: JWT (`/api/admin/login` 발급, `Authorization: Bearer` 헤더)

## 디렉터리 구조
- `frontend/` — 정적 페이지(`admin.html` 관리자 대시보드, `portal.html` 업무포털, `search.html` 리뷰제출, `staff.html` AE담당자 등)와 `js/`, `css/`
- `frontend/api.js` — GAS 호환 API 래퍼(`gasGet`/`gasPost`), 토큰은 `sessionStorage.admin_token`
- `server/src/routes/` — Express 라우트(`*.routes.js`), `server/src/middleware/auth.middleware.js`에 역할별 미들웨어(master/admin/staff)
- `server/migrations/` — DB 마이그레이션
- `.github/workflows/` — DB/Drive 백업·복구 리허설 (앱 빌드/배포 워크플로 아님)

### 리뷰 이미지 ↔ 인덱스 연결 (데이터 모델)
- 리뷰 캡처는 `AI_REVIEW_FOLDER → {시트제목} → {탭명} → [리뷰]` 폴더에 저장(`drive.service.js`의 `ensureReviewFolderPath`). 업로드 시 폴더ID를 못 잡으면 루트로 새므로 `uploadFileBase64`가 빈 `parentFolderId`를 차단한다.
- `review_index.review_file_*`(031, A-1): 제출 행당 대표 리뷰 이미지 1장(파일ID/URL/이름/개수/시각). `review-upload`가 업로드 즉시 기록.
- `review_submissions`(032, A-2): 리뷰 이미지 파일 단위 원장(탭/행/리뷰어/파일ID/제출시각/출처). `file_id` 유니크 업서트로 재실행 안전.
- 과거에 루트로 샌 캡처는 관리자 "리뷰 캡처 정리"(`POST /api/drive/relocate-orphan-reviews`)로 `[리뷰]` 폴더 이동 + 파일명 이름↔행 결정적 링크 백필(모호하면 링크 안 함).

### 구매양식 "제공정보" 추가안내 (제공정보 메모 · 회사 사업자번호)
- `tab_configs.provider_memo`(034): 탭별 자유 텍스트 "제공정보 메모"(진행방식 안내·특이사항 통합). 관리자 대시보드 탭설정 팝오버에서 편집. 구매양식 제출화면(`search.html`)의 "📦 제공정보" 카드에 표시되며 **공란이면 영역 미노출**.
- `app_settings.company_business_no`: 회사 공통 사업자번호 1개(관리자 "설정" 탭에서 편집, `POST /api/tab/company-business-no` = admin/master). 진행방식(`income_type`)이 **현영 포함(사업자현영)** 인 탭에서만 "지출증빙 현금영수증 발행 필수" 안내와 함께 노출.
- 폼은 진입 시 `GET /api/tab/provider-info?sheetId&tabName`(무인증, DB만 조회)로 `providerMemo/incomeType/companyBusinessNo`를 받아 렌더(`_loadProviderInfo`). 메모 URL은 `_linkifyMemo`로 링크화하되 href 속성 breakout XSS 방지(따옴표 제외 매칭).

### 폴더 소유권 & 자동 생성 (예방)
- 폴더/파일은 **OAuth(`DRIVE_OAUTH_REFRESH_TOKEN` = tnaks6325) 우선 → 실패 시 SA 폴백**으로 생성된다(`createFolder`/`uploadFileBase64`). `_normalizeOwner`가 생성 직후 소유자를 `DRIVE_OWNER_EMAIL`로 보정한다(SA→tnaks 이전은 구글이 막아 무시될 수 있음 — 그래서 OAuth 우선이 핵심).
- 폴더는 ① 첫 업로드 시 on-demand(`review-upload`), ② 배치(`POST /api/drive/sync-review`·`sync-capture`), ③ **스마트빌드 주기마다 자동**(`reviewFolders.service.js`의 `ensureReviewFoldersForActiveTabs`, `smartBuild` 말미 best-effort)로 생성된다. ③ 덕분에 **신규 활성 탭은 제출 0건이어도 tnaks 소유 `[리뷰]`/`[구매캡처]` 폴더가 미리 생성·연결**된다(비파괴·idempotent, `리뷰폼` 탭 제외, 1주기 최대 30탭).
- 관리자 점검: "리뷰폴더 현황 점검"(`POST /api/drive/folder-audit`)이 연결/정상/빈/미연결 + **폴더 소유자 집계**(tnaks/박세희/박은비/SA)를 보여주고, 미연결 탭은 현황 화면의 버튼으로 일괄 생성·연결한다. 파일 단위 소유자·용량은 "소유권"(`ownership-audit`/`transfer-ownership`)에서 확인·이관한다.

### 구매양식 제출 = DB-first 원장 + 시트 비동기 미러 (order-ledger)
- 구매양식 제출(`POST /api/submit/order`)은 **DB(`order_submissions`)에 먼저 확정**(`orderLedger.service.js`의 `createOrderLedgerEntry`) → RAW 미러(`raw_sheet_tabs.detected_headers`/`raw_sheet_rows`) 기반으로 행을 **원자적 배정**(`claimRow`, `sheet_row_claims` 행/dedup 2중 유니크 = 멱등·중복행 불가) → `enqueue('order_append')` → 큐 워커가 throttle(`sheetsThrottle`, 45/분)로 시트에 기록. 시트 통읽기 없음 = 쿼터 안전.
- 주문 상태는 `order_submissions.mirror_status`: `pending`→`queued`→`written`, 또는 행 배정 실패 시 `pending_no_row`, 쓰기 실패 시 `failed`.
- **데이터 손실 방어(레드/블루/심판 P0)**: ① **dedupKey osid 폴백**(`computeDedupKey`) — 주문번호 6자리 미만(쿠팡 비번호/분할주문)이면 `osid:<id>`로 별개 주문을 별개 행에 배정(같은 행 공유로 한 건 소실 차단). reconcile은 `row.dedup_key` 재사용으로 멱등 유지. ② **다중컬럼 가드**(`buildMirrorGuardRanges` — 연락처+주소+수취인) + 쓰기 직전 **그리드 캐시 무효화**(`invalidateSheetMeta`) — 한 칸만 보던 수동입력행 덮어쓰기 + 그리드밖 stale `[]`오판 차단. 차단 시 claim 해제 → 다음 reconcile이 더 아래 행 재배정. ③ **동명탭 보류** — gid 없이 동명 탭 다수면 오배정 대신 보류(`pending_no_row`, 미러로 gid 채워질 때까지 자가치유). ④ **42P01(claims 테이블 부재) 배정 금지** — 부팅 윈도우에 무검증 배정 대신 보류.
- **멀티인스턴스/동시성 방어(#1·#2)**: ⑤ **큐 클레임 원자화(#2)** — `processQueue`/`drainTabQueue`가 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`로 batch를 한 번에 `processing` 점유(`syncQueue.service.js`). 멀티워커/멀티인스턴스(또는 rolling 배포 중 old+new 공존)에서 같은 큐항목 이중처리(중복행)·정체 차단. 클레임은 `attempts`를 올리지 않고 실행 직전에 +1(원본 시맨틱), `processed_at=NOW()`로 stuck-detector(매시 `retryAllFailed`) 오리셋 방지. Quota 에러로 배치 중단 시 남은 점유분은 `pending` 복원. ⑥ **reconcile 직렬화(#1)** — `utils/jobLock.js`의 `withJobLock('order_reconcile', …)`(`pg_try_advisory_lock`, 전용 커넥션, busy면 즉시 양보)로 cron reconcile·인라인 `_triggerSheetMirrorOnce`·`order-reconcile`/`order-flush-tab` reconcile을 하나의 락으로 직렬화 → 동시 행배정 경합(churn/stall) 제거. `dryRun`은 락 불필요. unlock 실패 시 커넥션 폐기로 락 강제 해제(락 누수 방지).
- **막힌 주문 자동복구(reconcile)**: `reconcileStuckOrders()`가 `pending_no_row`/`failed`/정체 `queued` 주문을 찾아 행 재배정 후 재큐잉. cron `*/2`(RAW 미러 `*/5` **뒤**에 둠 — 메타 채워진 뒤 복구, throttle busy면 양보) + 관리자 강제 `POST /api/diag/order-reconcile`(admin/master). **메타 없는 탭은 skip**(다음 RAW 미러까지 자가치유). **복구분은 시트 하단에 append + 노란 배경**(`setRowBackground`)으로 기록해 직원 수동입력분·중복과 구분. 평상시 실시간 주문은 제자리(in-place)·기본색.
- 관리자 가시성: `GET /api/diag/order-mirror-status`(카운트+막힌탭+`hasRawMeta`+`tabGid`/`displayName`/`noRow`) + 대시보드 "구매주문 시트반영 현황" 위젯(원클릭 복구). 보조 진단: `GET /api/diag/order-written-sample?sheetId&tabName`(시트 반영 완료건을 `sheetRow`+주문자와 함께 — 노란 복구행 육안 대조용).
- **탭 리네임 복구**: 시트 탭 이름이 바뀌면(예 `…100건`→`…81건`) gid 없이 저장된 옛 주문이 현재 탭과 매칭 안 돼 영구 적체됨. `POST /api/diag/order-relink {sheetId, fromTabName, toTabGid, toTabName?, dryRun?}`(admin/master)가 막힌 주문의 `tab_gid`/`tab_name`을 현재 탭으로 backfill + `sheet_row` 초기화 → 이후 reconcile이 현재 탭 하단 노란행으로 복구. `loadRawTabContext`는 메타가 비어도 저장된 RAW 행에서 헤더 재탐지(자가치유)하므로 gid/이름만 맞으면 RAW 재미러 없이 복구된다(`detected_headers` NULL = 단순 stale 스냅샷).
- RAW 전체 미러(`POST /api/raw/mirror {force}`)는 `campaigns`∪`tab_configs`에 등록된 시트만 순회(`rawMirror.service.js`). 미등록 시트의 막힌 주문은 reconcile 자가치유로 처리(전체 미러 불필요).
- `order-relink`의 `toSheetId`: sheet_id 자체가 손상된 주문(단축URL 혼입 등)을 올바른 시트로 이전할 때 사용(시트+탭 동시 정정).
- **백로그 가속 드레인(선택적)**: 큐워커는 평상시 항목당 2초 안전대기(`processQueue`의 `interItemDelayMs` 기본 2000 — 쿼터 보수)로 ~20/분. `POST /api/diag/queue-drain {maxMillis?, batchSize?}`(admin/master)는 그 대기를 **0(지수백오프 포함 전부 제거)**으로 두고 `sheetsThrottle`(45/분)만 가드로 삼아 더 빨리 빼낸다. throttle로 한 배치가 길어질 수 있어 **백그라운드 실행 후 즉시 응답**(HTTP 타임아웃 방지) + `_queueDrainRunning` 중복방지; 진행은 `GET /api/diag/queue-drain`(running/last/remaining)·현황 위젯으로 관찰. 관리자 대시보드 "구매주문 시트반영 현황" 위젯의 **"빠른 반영(가속)"** 버튼으로 온디맨드 실행. **상시 켜는 게 아니라 백로그 있을 때만**(라이브 이벤트 중엔 자제 — 평상시 cron은 그대로 보수적).
- **그리드밖 행 가드읽기 처리**: 복구 append가 현재 시트 그리드보다 아래 행(예 행 268, 그리드 167행)을 가드 읽기하면 `_readSheetByGridData`가 빈 결과를 반환한다(이전엔 `endRowIndex<startRowIndex` 로 "endRowIndex cannot be before startRowIndex" 에러 → 복구 무한실패). 그 행은 데이터 없음=가드 통과가 맞고, 쓰기측 `_batchWriteByGrid`가 `appendDimension`으로 그리드를 확장하므로 정상 기록된다.
- 리뷰어 참여조회(`GET /api/reviewer/my-status?phone8=`)는 **`review_index`(시트빌드) + `order_submissions`(DB) 병합**(phone8=연락처 끝8자리, sheet_row로 중복제거). 시트 반영 전 주문도 `stage:'processing'`로 노출 → DB-first라 리뷰어가 제출 즉시 자기 참여 확인 가능.
- 운영 순서 규칙: **RAW 미러 → reconcile**(메타가 있어야 행 배정 가능). 메타 자동 공급은 3중: ① 탭 등록 시 `mirrorOneSheet`(#134), ② RAW 미러 cron `*/5`, ③ **미러 안 된 탭에 주문이 오면 `_triggerSheetMirrorOnce`가 그 시트만 백그라운드 1회 자동미러(탭당 60초 debounce) + 즉시 리컨실** — per-제출 라이브 시트읽기를 없애 버스트에도 시트 쿼터 안전(관리자 수동미러 불필요, 근실시간 자동동기화).

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
