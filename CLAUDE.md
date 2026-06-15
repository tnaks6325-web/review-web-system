# CLAUDE.md — review-web-system

이 파일은 Claude(Claude Code)가 이 저장소에서 작업할 때 먼저 읽는 프로젝트 가이드입니다.
한국어 서비스이며, 코드 주석·UI·커밋도 한국어가 기본입니다. 식별자/경로는 정확히 표기합니다.

## 이 프로젝트가 하는 일

GAS(Google Apps Script) 기반 리뷰 관리 시스템을 **Node.js + Express + PostgreSQL**로 완전 이관한 시스템입니다.
리뷰어 모집·검색, 작업시트(구글 시트) 인덱싱/대시보드, 구매양식 제출·슬롯 매칭, 입금처리, AE→관리자 작업오더 인테이크 등을 처리합니다.

- **프론트엔드**: Vanilla JS + HTML 정적 파일 (`frontend/`), Cloudflare Pages 배포. 빌드 단계 없음.
- **백엔드**: Express API 서버 (`server/`), Railway 배포.
- **DB**: Railway PostgreSQL (17+ 테이블). `pg` Pool 사용.
- **외부 연동**: Google Sheets API / Drive API (서비스 계정), Gemini AI(이미지 추출), Sentry(선택).
- **인증**: JWT(`jsonwebtoken`) + `bcryptjs`.

배포 URL·환경변수 등 운영 정보는 `README.md`, `RAILWAY_DEPLOY_GUIDE.txt`, `.env.example` 참고.

## 저장소 구조

```
frontend/            # 정적 프론트엔드 (빌드 없음, 그대로 배포)
  api.js             # ★ 핵심: gasGet/gasPost → REST 매핑 (_ACTION_MAP)
  *.html             # index/search/staff/viewer/recruit 등 페이지
  js/                # 페이지별 앱 로직
server/
  index.js           # 엔트리: 자동 마이그레이션 + 서버 기동 + graceful shutdown
  src/
    app.js           # Express 앱 (미들웨어 + 라우터 마운트 + /health)
    routes/          # *.routes.js — /api/<영역> 별 라우터
    services/        # 비즈니스 로직 (sheets/drive/gemini/search/indexBuilder 등)
    middleware/      # auth / cors / error / rateLimit / metrics
    db/pool.js       # PostgreSQL 풀
    db/migrate.js    # 수동 마이그레이션 러너 (npm run migrate)
    utils/           # logger / sse / gasCompat / cronCalc 등
    jobs/cron.js     # 스케줄러 (인덱스 빌드 / 큐 워커 / 정리)
  migrations/        # NNN_*.sql (idempotent 필수 — 아래 참고)
  scripts/           # 일회성 마이그레이션·테스트 스크립트 (수동 실행)
integration/         # 외부(INADD) 연동 키트
experiments/         # 실험용 — 프로덕션 아님
.claude/agents/      # 검토 에이전트 팀 (제안→검토→판단, 읽기전용)
.claude/skills/      # 작업 절차 스킬 (엔드포인트 추가 / 마이그레이션 작성)
```

## 반드시 지켜야 할 컨벤션

### 1. 프론트↔백 호출은 항상 `frontend/api.js`의 `_ACTION_MAP`을 거친다
프론트는 GAS 시절의 `gasGet({action, ...})` / `gasPost({action, ...})`를 그대로 호출하고,
`api.js`가 `action` 문자열을 `_ACTION_MAP`에서 찾아 `{ method, path }`로 변환해 실제 REST 엔드포인트를 호출합니다.

**새 엔드포인트를 추가하면 거의 항상 "3종 세트"가 함께 바뀝니다:**
1. `server/src/routes/<area>.routes.js` 에 Express 라우트
2. `frontend/api.js` `_ACTION_MAP` 에 `action → { method, path }` 항목
3. 프론트엔드 호출부(`frontend/js/*.js` 또는 HTML)에서 `gasGet/gasPost({ action, ... })`

세 곳의 method/path/필드명이 반드시 일치해야 합니다. 자세한 절차는 `.claude/skills/add-endpoint` 스킬 참고.

- 동적 경로(`/:id`)는 매핑이 평면 경로만 지원하므로, **id는 body/query로 넘기는 평면 경로**를 쓰는 게 이 저장소의 관례입니다(예: `order.routes.js`).
- 한 라우트가 여러 action을 받을 때는 `_ACTION_MAP` 항목에 `remap: '<실제action>'`을 넣어 서버가 기대하는 `action` 필드를 복원합니다(예: `/api/admin/users`).

### 2. 응답은 GAS 호환 — HTTP 200 + `{ ok | success | error }`
- 정상: `{ ok: true, ... }` 또는 `{ success: true, ... }` (헬퍼: `server/src/utils/gasCompat.js`).
- 오류: **HTTP 200**에 `{ error: '메시지' }`. 프론트는 `res.error` 유무로 실패를 감지합니다. 따라서 라우트에서 throw하면 `error.middleware.js`가 받아 200+error로 변환합니다.
- **에러 메시지 마스킹 주의**: `error.middleware.js`는 `NODE_ENV=production`에서 사용자 메시지를 `'서버 오류가 발생했습니다.'`로 가립니다. **단, `/api/admin/`, `/api/campaign/`, `/api/order/` 경로는 예외(실제 메시지 노출)**. 그 외 경로에서 사용자에게 의미 있는 에러를 주려면, 마스킹된다는 점을 감안하거나 라우트에서 직접 `res.json({ error })`로 돌려주세요.

### 3. 인증·권한 (역할 4종)
JWT payload는 `{ name, role }`. 미들웨어는 `server/src/middleware/auth.middleware.js`:
- `authMiddleware` — 토큰 유효성만 검사. **role 무관(admin/master/staff 모두 통과)**.
- `adminOrMasterMiddleware` — staff(영업담당자) 차단, admin/master만.
- `masterOnlyMiddleware` — master만.

역할:
- **리뷰어(reviewer)** — JWT 없음, 전화번호 기반 조회/제출 (공개 검색·제출 화면).
- **영업담당자(staff/AE)** — `staff_users` 로그인, 읽기 위주 대시보드(`staff.html`) + 작업오더 제출.
- **관리자(admin)** / **마스터(master)** — 운영/설정. 계정관리 등 일부는 master 전용.

⚠️ **함정**: `authMiddleware`만 건 쓰기 엔드포인트는 staff 토큰으로도 호출됩니다. staff가 호출하면 안 되는 쓰기 작업은 반드시 `adminOrMasterMiddleware`(또는 `masterOnlyMiddleware`)로 막으세요. "AE는 읽기전용"은 상당 부분 프론트에서만 강제되어 있으니, 보안상 중요한 건 백엔드에서 role을 검증해야 합니다.

### 4. SQL은 항상 파라미터 바인딩
`pool.query('... WHERE x=$1', [val])` 형태만 사용. 문자열 결합으로 값 삽입 금지(인젝션).

### 5. 마이그레이션은 idempotent 필수 (러너가 2개)
- 서버 기동 시: `server/index.js`의 `runMigrations()`가 `_migrations` 테이블로 적용 이력을 추적해 **새 파일만** 적용.
- 수동 실행: `npm run migrate` (`server/src/db/migrate.js`)는 **이력 무시하고 매번 전체 .sql 재실행**.

→ 두 러너 모두에서 안전하려면 모든 마이그레이션이 **재실행해도 안전(idempotent)** 해야 합니다: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ON CONFLICT DO NOTHING` 등. 자세한 작성법은 `.claude/skills/add-migration` 스킬 참고.

### 6. 프론트엔드 관례
- 보일러플레이트/네이밍은 주변 코드를 따르세요. 사용자 입력을 DOM에 넣을 때는 HTML 이스케이프(`escHtml` 등) 필수.
- API 베이스 URL은 `api.js`가 hostname으로 자동 판별(localhost ↔ Railway). 새 환경은 `window.REVIEW_API_URL`로 오버라이드 가능.

## 개발·실행 명령

서버 디렉토리(`server/`)에서:

```bash
cd server
npm install
cp ../.env.example .env   # 값 채우기 (DATABASE_URL, JWT_SECRET 등 — 아래 참고)
npm run dev               # nodemon 개발 서버 (기본 PORT=3000)
npm start                 # 프로덕션 기동
npm run migrate           # 전체 .sql 재실행 (idempotent 전제)
npm run health            # /health 핑 (서버 떠 있어야 함)
```

- **로컬 최소 구동**: PostgreSQL 1개와 `DATABASE_URL`, `JWT_SECRET`이면 서버는 뜹니다. Google/Gemini 키가 없으면 시트·이미지 관련 기능만 비활성/실패하고 나머지는 동작합니다.
- 프론트엔드는 빌드가 없습니다. `frontend/`를 정적 서빙하거나 파일을 직접 열어 확인합니다. `localhost`에서 열면 `api.js`가 `http://localhost:3000`을 가리킵니다.
- **테스트 러너/린터 없음**. `server/scripts/test-*.js`는 자동화 테스트가 아니라 수동 점검용 노드 스크립트입니다. "테스트 실행"을 요청받으면 이 점을 알리고, 검증은 `node -c`(문법) + `/health` + 실제 호출로 합니다.

## 배포

- **백엔드**: Railway (`server/` 디렉토리, `railway.json`/`Procfile`). 기동 시 자동 마이그레이션.
- **프론트엔드**: Cloudflare Pages (`frontend/`).
- `ecosystem.config.cjs`는 PM2 구성. 환경변수 전체 목록·절차는 `.env.example`와 `RAILWAY_DEPLOY_GUIDE.txt`.

## 자주 밟는 함정 (코드 변경 시 점검)

- **PostgreSQL `jsonb_array_length`**: 대상이 배열이 아니면 "cannot get array length of a scalar" 예외. `CASE WHEN jsonb_typeof(x)='array' THEN ...` 로 가드. SQL `AND`는 단축평가 순서를 보장하지 않음.
- **에러 마스킹**: 위 컨벤션 2 — 프로덕션에서 admin/campaign/order 외 경로는 에러 메시지가 가려짐.
- **권한 게이팅**: 위 컨벤션 3 — staff 토큰이 `authMiddleware`-only 쓰기 라우트를 통과함.
- **마이그레이션 번호 충돌**: 현재 `025_` 접두사 파일이 둘(`025_fix_sub_accounts_double_encoding.sql`, `025_participation_links.sql`) 있습니다. 새 마이그레이션은 **다음 번호(026~)**를 쓰고, 알파벳 정렬 순서가 의도와 맞는지 확인하세요.
- **DB 변경 누락**: 새 컬럼/테이블을 쓰는 코드는 반드시 대응 마이그레이션을 함께 추가.
- **api.js 3종 세트 불일치**: 라우트만 추가하고 `_ACTION_MAP`/프론트 호출을 빠뜨리면 동작하지 않음.

## 진행 중인 핵심 도메인: 작업오더(work_orders)

AE(영업담당자)가 구조화된 "작업 오더"를 제출 → 관리자 인박스 → **상태머신**으로 흐릅니다.
`server/src/routes/order.routes.js` + `migrations/019~023_work_orders*.sql`.

- 상태: `submitted → reviewing → await_chatroom → published → done` (+ `rejected`, `revision`). 전이 규칙은 라우트의 `ORDER_TRANSITIONS`가 단일 소스(서버에서만 검증).
- AE가 수정 가능한 필드는 `AE_FIELDS` 화이트리스트로 제한. `status/created_by/processed_by/admin_memo`는 AE가 못 건드림.
- 두 개의 수동 산출물: **작업시트탭URL**(AE가 `createCampaignSheet`로 생성) / **카톡 팀채팅방URL**(관리자 발행 시). 이들은 모집공고(`recruit_campaigns`)의 `chat_url`/`linked_sheet_id`/`linked_tab_name`로 연계됩니다.
- 관리자 액션은 `adminOrMasterMiddleware`, AE 액션은 `authMiddleware`로 게이팅되어 있습니다.

## 검토 에이전트 팀 (.claude/agents/)

이 저장소에는 읽기 전용(advisory) 서브에이전트 3종이 있습니다. 직접 코드를 고치지 않고 제안/검토/판단만 합니다:
- `feature-proposer` — 기존 패턴에 맞는 구현안 제안 (file:line + 트레이드오프)
- `code-reviewer` — 정확성·보안·일관성 검토 (심각도별 보고)
- `proposal-judge` — 제안 + 검토를 종합해 판단·보고

추천 흐름: **제안 → 검토 → 판단 → 사용자 승인 → 메인 세션이 구현**. 상세는 `.claude/agents/README.md`.
