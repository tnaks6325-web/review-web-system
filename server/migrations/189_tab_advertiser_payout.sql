-- 189: 업체 직접 입금 작업 (결정 247 · 사용자 확정 2026-10-14 "모두 권장")
--
-- 업체가 참여자 페이백을 직접 보내는 작업을 표시한다. 켜면
--   ① 그 작업을 소유한 업체(대표 링크)의 작업보드에 은행·계좌번호·예금주가 보인다(리뷰 제출 끝 + 미입금 줄만)
--   ② 업체가 입금 칸에 입금일을 기록할 수 있다(우리 직원과 같은 [💰 입금수정] 달력)
--   ③ 우리 입금관리에서 빠지고, 서버도 이체 회차에 담지 않는다(이중 입금 차단)
-- 기본 FALSE = 종전 동작 그대로. 가산 칸만 추가(기존 쓰기 경로 무변경).
-- 롤백: ALTER TABLE tab_configs DROP COLUMN IF EXISTS advertiser_payout, DROP COLUMN IF EXISTS advertiser_payout_by,
--       DROP COLUMN IF EXISTS advertiser_payout_at;
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS advertiser_payout BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS advertiser_payout_by TEXT;
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS advertiser_payout_at TIMESTAMPTZ;
