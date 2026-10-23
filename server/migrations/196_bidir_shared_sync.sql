-- 196: 리뷰오더↔모집공고 양방향 동기화 기반 (결정 275 · 양방향 2단계)
-- ★ 가산 전용 — 칸·표를 더하기만 한다. 기존 행 값 변경(백필) 0 · 트리거·함수 0 · DROP 0.
-- ★ 이 칸·표를 읽는 코드는 아직 없다(2단계 = 관찰 전용). 그래서 REQUIRED_SCHEMA 에도 등록하지 않는다 —
--   이 파일이 실패해도 기동은 계속된다(읽는 코드가 들어가는 단계에서 등록한다).
-- ★ 기본값이 있는 NOT NULL 칸 추가는 PG11+ 에서 표를 다시 쓰지 않는다(메타데이터만) — 잠금이 짧다.
-- 롤백: 코드를 되돌린 뒤 아래 표·칸을 DROP(데이터가 없는 것이 정상).

-- 작업오더 = 공유 상태 정본 1벌. 버전은 HLC(GREATEST(이전+1, 현재 µs)) — DB 복원으로 역행하지 않게.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 0;
-- 오더별 스위치: off(연결 안 됨·기본) | observe(관찰만) | on(양방향) | diverged(값이 달라 직원 선택 대기) | parked(보류)
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS bidir_state TEXT NOT NULL DEFAULT 'off';
-- 인트라넷이 마지막으로 받았다고 알려온 버전(수정 티켓이 없을 때의 기준점)
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS intranet_acked_version BIGINT NOT NULL DEFAULT 0;
-- 공유 칸 중 작업오더에 아직 자리가 없던 두 칸
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS required_delivery_memo TEXT NOT NULL DEFAULT '';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE;

-- 옵션별 유입가이드 문서(글-사진 순서 블록, 결정 275 D4). HTML 칸(inflow_guide_html)은 그대로 계속 쓴다.
ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS inflow_guide_doc JSONB;

-- 버전마다 공유 상태 스냅숏 — 3방향 병합의 base. op_id = 같은 저장 재전송 판별(멱등).
CREATE TABLE IF NOT EXISTS work_order_shared_snapshots (
  work_order_id TEXT NOT NULL,
  sync_version  BIGINT NOT NULL,
  origin        TEXT NOT NULL,
  op_id         TEXT NOT NULL DEFAULT '',
  state         JSONB NOT NULL,
  actor         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_order_id, sync_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wo_shared_snap_op ON work_order_shared_snapshots (op_id) WHERE op_id <> '';

-- 리뷰웹 → 인트라넷 전송 대기열(같은 트랜잭션에서 넣는다 — 저장은 됐는데 전송 예약이 빠지는 일 방지)
CREATE TABLE IF NOT EXISTS shared_sync_outbox (
  id            BIGSERIAL PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  sync_version  BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | delivered | superseded | parked | dead
  attempts      INT NOT NULL DEFAULT 0,
  next_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, sync_version)
);
CREATE INDEX IF NOT EXISTS idx_shared_outbox_due ON shared_sync_outbox (next_at) WHERE status IN ('pending', 'sending');

-- 오더의 상품·옵션 줄 ↔ 공고 옵션 줄 짝(이름이 바뀌어도 짝이 유지되게)
CREATE TABLE IF NOT EXISTS work_order_option_links (
  work_order_id TEXT NOT NULL,
  wo_key        TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  opt_key       TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_order_id, wo_key),
  UNIQUE (campaign_id, opt_key)
);

-- 옵션 결제금액 이력 — 잘못구매 판정은 "구매 시점 금액"으로(결정 275 D3). campaign_options.id 는 INTEGER.
CREATE TABLE IF NOT EXISTS campaign_option_price_history (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL,
  option_id    INTEGER NOT NULL,
  pay_amount   INTEGER NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_opt_price_hist ON campaign_option_price_history (option_id, effective_at DESC);
