# ★★ jsonb 배열 인덱싱 — `cells->>$n::int` 캐스트 필수 (063이 무음으로 꺼져 있던 원인)
- **실측 사고**: `SELECT cells->>$3`(파라미터=텍스트)는 PostgreSQL이 `jsonb ->> text`(**객체 키 조회**)로 해석한다. `raw_sheet_rows.cells`는 **JSONB 배열**이라 객체 키 조회는 **에러가 아니라 전 행 NULL**을 돌려준다 → 날짜 컬럼이 통째로 빈 값 → `summarizeDates`가 null → **시트 일정 자동 인식(063)이 배포 이래 한 번도 작동하지 않았다.** 모든 캠페인이 조용히 발행폼 `daily_limit`/`recruit_total` 경로로만 돌아갔다.
- **수정**: `cells->>$3::int`(`::`가 `->>`보다 강하게 결합 → `jsonb ->> integer` = 배열 원소). 로컬 PG16으로 재현·검증.
- ★ **스텁 DB 테스트로는 절대 못 잡는다**(스텁은 SQL을 해석하지 않음). 회귀가드 `tests/jsonbCellsIndex.test.js` = 정적(주석 제외 후 모든 `cells->>$n`에 `::int`) + `PGTEST_URL` 있으면 **진짜 PG로 NULL 재현/수정 확인**.
- **되살아나는 배포라 킬스위치** `CAMPAIGN_SHEET_SCHEDULE`(`deriveSchedules`가 빈 맵 반환 = 전부 미적용). ⚠ **2026-08-07 사용자 확정으로 기본값이 뒤집혔다 — 아래 "모집 정원 기준 = 시스템표" 참조**(이 절의 서술은 스위치를 `1`로 켰을 때의 동작이다).
