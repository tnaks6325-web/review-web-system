-- 088: 작업오더 ← 인트라넷 계약(sales) 연결
--
-- 배경: 리뷰웹시스템[3버전] 작업보드의 "계약 매칭"은 원래 **작업이 들어온 뒤** 사람이 계약을 찾아
--   붙이는 과정이었다. 인트라넷 리뷰오더 등록에서 **계약건 선택을 필수**로 바꾸면 그 계약이
--   작업오더를 타고 그대로 넘어오므로, 접수(accept) 시점에 정산 계약이 자동으로 연결된다
--   → 리뷰웹에서 계약 매칭을 따로 할 필요가 없어진다(그 화면은 과거 작업건 백필용으로만 남는다).
--
-- ★ 인트라넷 D1 무접촉: sales_id/quote_id 는 인트라넷 조회 키일 뿐 FK 가 아니다(054 와 같은 규율).
-- ★ 컬럼 추가만 · 백필 0 · CHECK 없음 — 이 컬럼이 비어 있는 과거 오더는 종전 동작 그대로
--   (계약 매칭 화면에서 사람이 붙인다).
-- ★ TEXT 로 선언 — 082 의 42804(FK 타입 불일치로 파일 전체 롤백) 계열 회피.

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS sales_id        TEXT DEFAULT '';   -- 인트라넷 sales.id (계약)
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS contract_number TEXT DEFAULT '';   -- 표시 캐시(C-번호)
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS quote_id        TEXT DEFAULT '';   -- 인트라넷 quotes.id (견적서)

CREATE INDEX IF NOT EXISTS idx_work_orders_sales_id ON work_orders(sales_id) WHERE sales_id <> '';
