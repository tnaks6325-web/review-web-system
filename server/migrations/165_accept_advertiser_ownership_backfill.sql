-- 165: 접수된 작업의 업체 소유 소급 지정 (2026-09-23 「고양이사료」 실사고)
--
-- 왜: 리뷰오더에서 광고주를 고르고 계약(견적서)까지 붙여 접수했는데, 접수가
--     work_orders.advertiser_id·포털 작업만 채우고 advertiser_campaigns(업체관리·작업바가 읽는
--     소유)를 만들지 않아 작업이 「미지정」으로 떨어졌다. 앞으로의 접수는 order.routes 8c)가
--     채운다(advertiserProjection.ensureTabOwnership). 여기서는 이미 접수된 건만 메운다.
--
-- ★ 규율은 ensureTabOwnership 과 같다:
--   · 작업(탭) 단위만(tab_gid 필수 — 시트 전체 소유 금지, 결정 082)
--   · 이미 누가 소유(탭 지정·시트 전체)하면 건드리지 않는다
--   · 같은 업체의 해제된 행은 되살리지 않는다(ON CONFLICT DO NOTHING)
--   · 종료 거래처·삭제된 오더·등록 없는 탭 제외
-- ★ 멱등 — 재실행해도 추가 행 0. 되돌리기 = assigned_by = '자동(작업오더·소급165)' 행 soft-delete.
INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid, assigned_by)
SELECT DISTINCT ON (w.linked_tab_sheet_id, w.linked_tab_gid)
       w.advertiser_id, w.linked_tab_sheet_id, w.linked_tab_gid, '자동(작업오더·소급165)'
  FROM work_orders w
  JOIN advertisers a ON a.id = w.advertiser_id AND COALESCE(a.status,'') <> 'ended'
 WHERE w.deleted_at IS NULL
   AND COALESCE(w.advertiser_id,'') <> ''
   AND COALESCE(w.linked_tab_sheet_id,'') <> ''
   AND COALESCE(w.linked_tab_gid,'') <> ''
   AND EXISTS (SELECT 1 FROM tab_configs tc
                WHERE tc.sheet_id = w.linked_tab_sheet_id AND tc.tab_name = w.linked_tab_name)
   AND NOT EXISTS (SELECT 1 FROM advertiser_campaigns ac
                    WHERE ac.deleted_at IS NULL AND ac.sheet_id = w.linked_tab_sheet_id
                      AND (ac.tab_gid IS NULL OR ac.tab_gid = w.linked_tab_gid))
 ORDER BY w.linked_tab_sheet_id, w.linked_tab_gid, w.updated_at DESC
ON CONFLICT (advertiser_id, sheet_id, COALESCE(tab_gid,'')) DO NOTHING;
