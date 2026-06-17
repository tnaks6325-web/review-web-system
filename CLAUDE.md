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

## 배포 (자동)
- `main` 브랜치에 머지되면 **Cloudflare Pages(프론트)와 Railway(백엔드)가 GitHub 연동으로 자동 배포**합니다.
- 별도의 빌드/배포 GitHub Action은 없습니다. `main` 머지 = 배포.

## 작업 워크플로 (기본 동작)
요청받은 변경을 완료하면 **사용자에게 다시 묻지 않고 아래를 자동으로 진행**합니다.
(작업 지정 브랜치가 있으면 그 브랜치에서, 없으면 `claude/<설명>` 브랜치를 만들어 작업)

1. **커밋 & 푸시**: 명확한 메시지로 작업 브랜치에 커밋하고 `git push -u origin <branch>`.
2. **PR 생성**: 작업 브랜치 → `main` 으로 PR을 만든다.
3. **머지**: 생성한 PR을 `main` 에 머지한다 (→ 자동배포 트리거).
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
