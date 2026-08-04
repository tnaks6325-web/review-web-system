-- 085: 모집공고 "리뷰어 미노출"(비공개/테스트 공고) 플래그
--
-- 배경: 대량구매(타계정 다건 일괄 제출) 흐름을 실제로 테스트하려면 **참여·제출이 진짜로 되는**
--   공고가 필요한데, 지금은 그런 공고를 리뷰어에게 숨길 방법이 없었다.
--   ⓐ status 를 'active' 가 아닌 값으로 두면 리뷰어 목록(/list, status IN ('active','closed'))에서는
--      빠지지만 computeCampaignState 가 무조건 'closed' 로 판정해 **참여 자체가 막힌다**.
--   ⓑ 관리자 미리보기(preview=1)는 제출이 4중 차단이고 일괄 제출(_batchBoot)도 preview 에서 꺼지므로
--      대량구매 테스트에 쓸 수 없다.
--   → 노출과 상태를 분리한다: status 는 그대로 'active'(참여 가능), 목록 노출만 이 플래그로 끈다.
--
-- 적용 범위(딱 하나): 공개 목록 API `GET /api/campaign/list` 에서 제외.
--   그 API 하나가 리뷰어 홈 미리보기·공고 목록·인기상품 게이트 모달의 유일한 출처라
--   필터 한 줄이 리뷰어 노출 경로 전체를 덮는다.
--   ★ 관리자 목록(`/admin/list`)·상세(`/:id`)·참여(apply)·work-detail 은 무변경 —
--     그래야 관리자가 공고 링크로 들어가 실제 참여·제출까지 테스트할 수 있다.
--
-- ★ 기본값 FALSE = 기존 공고 전부 동작 불변(신규 컬럼 추가만, 백필 없음).
-- ★ 되돌리기: 이 컬럼을 DROP 하면 원복(다른 테이블·데이터 무영향).
--
-- ⚠ 한계(문서화): 목록에서만 숨긴다. 공고 URL(`campaign.html?id=...`)을 아는 사람은 들어올 수 있다.
--   "링크를 아는 사람만 접근하는 비공개 공고"이지 인증 게이트가 아니다.

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS reviewer_hidden BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN recruit_campaigns.reviewer_hidden IS
  'TRUE 면 리뷰어 공개 목록(GET /api/campaign/list)에서 제외 — 관리자 목록에는 그대로 보이고 참여·제출은 정상 동작(내부 테스트용 비공개 공고). FALSE(기본)=기존 동작.';
