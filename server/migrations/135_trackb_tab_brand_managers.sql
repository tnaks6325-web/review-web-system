-- 135: 작업(탭)별 브랜드 담당자 — 대행사가 브랜드사에게 보여줄 자기 쪽 담당자를 직접 적는다.
--   사용자 확정 2026-08-24:
--     · 저장 단위 = **작업(탭) 하나**(브랜드 1벌이 아니라 작업마다 다르게 적을 수 있다)
--     · 최대 2명 · 라벨 없는 자유입력
--     · 브랜드사 화면에서는 내부 담당(AE·관리자)을 **대체**하고, 값이 없으면 담당 행 자체를 숨긴다
--     · 대행사·내부 화면에서는 내부 담당과 **함께** 보여 "무엇이 나가는지" 를 확인시킨다
--   ★ 쓰기 표면은 이 표 하나 — 운영 테이블(작업표·주문·정산)·시트 무접촉.
--   ★ advertiser_id 는 advertisers.id(TEXT)와 **같은 타입**(082 의 42804 규율).
CREATE TABLE IF NOT EXISTS trackb_tab_brand_managers (
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  sheet_id      TEXT NOT NULL,
  tab_name      TEXT NOT NULL,
  -- 이름 문자열 배열(최대 2). 빈 배열은 저장하지 않고 행을 지운다("미입력" = 행 없음).
  managers      JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT,
  PRIMARY KEY (advertiser_id, sheet_id, tab_name)
);
