-- ═══════════════════════════════════════════════════════════
-- 067: 작업오더로 만든 공고의 "연결 탭" 백필
--
-- 배경: 작업시트탭URL은 AE 제출 필수라 오더에는 항상 값이 있는데, 발행 폼에서 탭을 못 고르면
--   (접수 전 발행·드롭다운 미로딩 등) 공고가 linked_sheet_id/linked_tab_name 없이 저장된다.
--   그 공고는 "⚠ 시트 탭 미연결 · 게시할 수 없습니다"로 막혀 운영이 진행되지 않는다.
--
-- 이 마이그레이션은 **이미 만들어진 공고**를 오더의 접수 확정값으로 채운다.
--   (이후 신규 저장은 campaign.routes 의 _linkedTabFromWorkOrder 가 서버에서 보정한다)
--
-- ★ 안전 조건(완화 금지):
--   ① 공고의 연결 탭이 **완전히 비어 있을 때만** 채운다 — 관리자가 고른 탭을 절대 덮지 않는다.
--   ② 출처는 접수 때 확정된 work_orders.linked_tab_*(gid까지 확정된 값)만 사용.
--      URL 파싱 추정은 여기서 하지 않는다(마이그레이션에서 추측 금지 — 런타임 보정이 담당).
--   ③ 소프트삭제된 오더는 제외.
-- 멱등: 이미 채워진 행은 WHERE 조건에서 빠지므로 재실행해도 변화 없음.
-- ═══════════════════════════════════════════════════════════
--   ④ 공고 하나에 오더가 여럿 걸릴 수 있어(2차 오더 등) **결정적으로 1건만** 고른다:
--      정방향 링크(source_work_order_id) 우선, 다음 역방향 링크(linked_campaign_id), 같으면 먼저 만든 오더.
UPDATE recruit_campaigns c
   SET linked_sheet_id = pick.sheet_id,
       linked_tab_name = pick.tab_name,
       linked_tab_gid  = COALESCE(NULLIF(c.linked_tab_gid, ''), pick.tab_gid)
  FROM (
    SELECT DISTINCT ON (cc.id)
           cc.id AS campaign_id,
           w.linked_tab_sheet_id AS sheet_id,
           w.linked_tab_name     AS tab_name,
           w.linked_tab_gid      AS tab_gid
      FROM recruit_campaigns cc
      JOIN work_orders w
        ON (NULLIF(cc.source_work_order_id, '') = w.id OR NULLIF(w.linked_campaign_id, '') = cc.id)
     WHERE w.deleted_at IS NULL
       AND COALESCE(cc.linked_sheet_id, '') = ''
       AND COALESCE(cc.linked_tab_name, '') = ''
       AND COALESCE(w.linked_tab_sheet_id, '') <> ''
       AND COALESCE(w.linked_tab_name, '') <> ''
     ORDER BY cc.id,
              (NULLIF(cc.source_work_order_id, '') = w.id) DESC,   -- 정방향 링크 우선
              w.created_at ASC
  ) AS pick
 WHERE c.id = pick.campaign_id;
