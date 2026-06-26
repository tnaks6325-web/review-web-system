-- 034: 제공정보 메모 (구매양식 제출 화면 "제공정보" 카드에 표시할 탭별 안내문)
-- 진행방식 안내·특이사항 등을 하나의 자유 텍스트로 관리. 공란이면 화면에 영역 미노출.
ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS provider_memo TEXT DEFAULT '';

-- 회사 공통 사업자등록번호 (사업자현영 진행방식일 때 지출증빙용 현금영수증 안내에 사용)
-- app_settings 키-값 저장소에 1개만 보관 (관리자 설정 탭에서 편집)
INSERT INTO app_settings (key, value)
VALUES ('company_business_no', '')
ON CONFLICT (key) DO NOTHING;
