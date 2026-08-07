-- 097: 작업오더 진행 일정 신호 (탈 구글시트 W2-b)
--
-- 배경: 종전에는 시트 구매일자 칸에 사람이 8/7×5행·8/8×5행 … 을 손으로 적으며
--   주말을 건너뛰고 업체 휴무일을 비웠다. 작업표 생성(`worktablePlan.distributeDates`)이
--   그 분배를 대신하는데, **인트라넷 오더 폼에 주말 제외 여부·휴무일 신호가 없어서**
--   담당자가 미리보기에서 매번 다시 지정해야 했다(최종점검 문서의 "공백 1건").
--
-- ★ 컬럼 추가만 · 백필 0 · 기본값 = 종전 동작
--     · skip_weekends NULL  = 미전송 → 계획 계산의 기본값(주말 제외)이 그대로 적용
--     · holidays      NULL  = 휴무일 없음(담당자가 미리보기에서 지정하던 흐름 유지)
-- ★ TEXT(JSON 배열) — 082 의 FK 타입 사고 계열을 피하려 배열형·FK 를 쓰지 않는다.
--   값 검증은 애플리케이션(`_holidaysJson`)이 한다(형식 틀린 값은 조용히 버린다).
-- ★ 되돌리기: 이 두 컬럼 DROP (읽는 쪽이 전부 COALESCE/폴백이라 즉시 종전 동작).

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS skip_weekends BOOLEAN,
  ADD COLUMN IF NOT EXISTS holidays      TEXT;
