-- 036: 주문 원장 소프트취소/편집 컬럼 + 탭별 진실원천(source of truth) 플래그
-- Idempotent, additive. 기존 데이터 보존(023 work_orders 소프트삭제 패턴 차용).
-- PR-A(경화) 선배포용 — 이 컬럼/플래그가 들어와도 기존 자가치유가 취소건을 부활시키지 않게 한다.

ALTER TABLE order_submissions
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,                              -- null=활성, 값=소프트취소
  ADD COLUMN IF NOT EXISTS canceled_by   TEXT,                                     -- 취소한 관리자
  ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'order_submit',     -- 'order_submit' | 'manual'(수동추가)
  ADD COLUMN IF NOT EXISTS last_edit_seq INTEGER NOT NULL DEFAULT 0,               -- 편집 단조순번(out-of-order 거부)
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ;

-- 활성(미취소) + 미반영(written 아님) 주문만 추리는 부분 인덱스 (reconcile/원장 그리드 가속)
CREATE INDEX IF NOT EXISTS idx_os_alive_stuck
  ON order_submissions (sheet_id, tab_name)
  WHERE deleted_at IS NULL AND mirror_status <> 'written';

-- 탭별 진실원천 플래그 (roadmap P0): 'sheet'=레거시 기본, 'db'=DB 주체 옵트인.
-- 점진·되돌리기 가능 전환의 게이트(탭 단위로 켜고, 문제 시 그 탭만 'sheet'로 복귀).
ALTER TABLE tab_configs
  ADD COLUMN IF NOT EXISTS source_of_truth TEXT NOT NULL DEFAULT 'sheet';
