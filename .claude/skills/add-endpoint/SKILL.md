---
name: add-endpoint
description: Add or change an API endpoint in review-web-system the right way — keep the frontend api.js _ACTION_MAP, the Express route, and the frontend caller in sync, with correct role gating and GAS-compatible responses. Use whenever you add/rename/move an endpoint or wire a new frontend action (gasGet/gasPost) to the backend.
---

# 엔드포인트 추가/변경 절차 (review-web-system)

이 저장소에서 새 API는 거의 항상 **3종 세트**가 함께 바뀝니다. 하나라도 빠지면 동작하지 않습니다.

## 3종 세트

1. **Express 라우트** — `server/src/routes/<area>.routes.js`
   - 적절한 영역 라우터에 핸들러 추가. 새 영역이면 `server/src/app.js`에서 `app.use('/api/<area>', <area>Routes)` 마운트.
2. **`_ACTION_MAP` 항목** — `frontend/api.js`
   - `'<actionName>': { method: 'GET'|'POST'|'PUT'|'DELETE', path: '/api/<area>/<...>' }`
3. **프론트엔드 호출부** — `frontend/js/*.js` 또는 HTML
   - `gasGet({ action: '<actionName>', ... })` (GET) 또는 `gasPost({ action: '<actionName>', ... })` (그 외)

세 곳의 **method / path / 필드명**이 정확히 일치해야 합니다.

## 규칙과 관례

- **동적 경로(`/:id`) 지양**: `_ACTION_MAP`은 평면 경로만 깔끔히 지원합니다. id는 **body/query로** 넘기는 평면 경로를 쓰세요(예: `order.routes.js`의 `/api/order/admin/status` + body의 id). 기존 `campaign`처럼 동적 경로를 쓰는 곳은 호출부에서 path를 조합합니다.
- **한 라우트가 여러 action을 받을 때**: `gasGet/gasPost`는 전송 시 `action` 필드를 제거합니다. 서버가 `action`으로 분기한다면 `_ACTION_MAP` 항목에 `remap: '<서버가 기대하는 action>'`을 넣어 복원하세요(예: `/api/admin/users`의 `add/edit/delete/list`).
- **GET vs 그 외**: `_ACTION_MAP`의 method가 GET이면 파라미터가 쿼리스트링으로, POST/PUT/DELETE면 JSON body로 전송됩니다(`api.js`의 `gasGet`/`gasPost` 참고). 빈 문자열/`null`/`undefined`는 쿼리에서 생략됩니다.

## 응답 형식 (GAS 호환)

- 정상: `res.json({ ok: true, ... })` 또는 `{ success: true, ... }`. 헬퍼: `server/src/utils/gasCompat.js`.
- 오류: **HTTP 200 + `{ error: '메시지' }`**. 라우트에서 `throw`하면 `error.middleware.js`가 200+error로 변환합니다. `try/catch (err) { next(err); }` 패턴을 따르세요.
- **마스킹 주의**: 프로덕션(`NODE_ENV=production`)에서는 `/api/admin/`, `/api/campaign/`, `/api/order/` **외** 경로의 에러 메시지가 `'서버 오류가 발생했습니다.'`로 가려집니다. 그 외 경로에서 사용자에게 구체적 메시지를 보여야 하면 라우트에서 직접 `res.json({ error })`로 반환하세요.

## 권한 게이팅 (보안상 필수)

`server/src/middleware/auth.middleware.js`:
- `authMiddleware` — 토큰 유효성만. **admin/master/staff 모두 통과**.
- `adminOrMasterMiddleware` — staff(AE) 차단.
- `masterOnlyMiddleware` — master만.

⚠️ staff가 호출하면 안 되는 **쓰기** 엔드포인트는 반드시 `adminOrMasterMiddleware`(또는 `masterOnlyMiddleware`)로 막으세요. `authMiddleware`만으로는 staff 토큰이 통과합니다. "AE 읽기전용"은 프론트에서만 강제되는 경우가 많습니다.

## SQL

`pool.query('... $1 ...', [val])` 파라미터 바인딩만 사용(인젝션 금지). DB 컬럼/테이블을 새로 쓰면 대응 마이그레이션을 함께 추가하세요(`.claude/skills/add-migration`).

## 마무리 체크리스트

- [ ] 라우트 추가 + (새 영역이면) `app.js` 마운트
- [ ] `_ACTION_MAP`에 항목 추가 (method/path 일치, 필요 시 `remap`)
- [ ] 프론트 호출부 추가/수정 (필드명 일치)
- [ ] 알맞은 권한 미들웨어 적용
- [ ] 응답이 `{ ok | success | error }` 형식인지
- [ ] DB 변경 시 마이그레이션 동반
- [ ] `node -c <파일>`로 문법 확인, 가능하면 로컬에서 실제 호출로 검증
