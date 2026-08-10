-- 099: 작업유형(체험단 종류) 축 — 리뷰체험단 / 블로그체험단
--
-- 배경(실사고 2026-08): (주)바를참스킨 「0804)비타민,글루타치온_블로그 50건」이 무시트 이관에서
--   **구매일자가 빈 행 전부 무음 누락**됐다. 원인 = 준비 행 판정이 "구매일자가 날짜로 읽히는 행"
--   하나뿐인데, 블로그체험단은 구조적으로 구매일자를 미리 정할 수 없다(모집되면 그때 구매).
--   즉 데이터 오류가 아니라 **시스템이 블로그 진행 방식을 모르는 것**이 문제였다.
--
-- ★★ 리뷰타입(포토·텍스트·구매확정·별점·혼합)과 **다른 축**이다(사용자 확정 2026-08-10).
--   리뷰타입은 리뷰체험단 안에서만 쓰는 하위 값이고, 블로그 작업에는 리뷰타입이 없다.
--
-- ★ 087(리뷰타입) 규율 그대로:
--     · 컬럼 추가만 · **백필 0** · **DB CHECK 없음**
--       (판정을 코드와 DB 에 이중화하면 어휘가 늘 때마다 저장이 실패한다 — 판정 단일 출처는
--        `server/src/utils/workKind.js`)
--     · TEXT (082 의 42804 FK 타입 사고 계열 회피 — FK·enum 도입 안 함)
-- ★★ **빈 값 = 리뷰체험단** — 기존 행 전부가 그대로 현행 동작이다(opt-in).
--   그래서 DEFAULT '' 로 두고 백필하지 않는다("한 번도 정하지 않음"과 "리뷰로 정함"을 구분할
--   수 있어야 blank-only 전파(COALESCE(NULLIF(...)))가 성립한다).
--
-- 전파 경로: work_orders(인트라넷 오더) → tab_configs(접수 시 blank-only) → recruit_campaigns(발행 프리필)
-- 되돌리기: 세 컬럼 DROP (읽는 쪽이 전부 빈 값 = review 폴백이라 즉시 종전 동작).

ALTER TABLE work_orders      ADD COLUMN IF NOT EXISTS work_kind TEXT DEFAULT '';
ALTER TABLE tab_configs      ADD COLUMN IF NOT EXISTS work_kind TEXT DEFAULT '';
ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS work_kind TEXT DEFAULT '';

COMMENT ON COLUMN work_orders.work_kind      IS '체험단 종류: ''''(=리뷰,기본) | review | blog — 판정 단일 출처 utils/workKind.js';
COMMENT ON COLUMN tab_configs.work_kind      IS '체험단 종류(접수 시 작업오더에서 blank-only 전파)';
COMMENT ON COLUMN recruit_campaigns.work_kind IS '체험단 종류(발행 프리필). 블로그면 리뷰타입 미사용';
