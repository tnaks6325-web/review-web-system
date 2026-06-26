-- 033: 업체 보고용 공개 링크 (탭 단위)
-- 직원이 자기 드라이브에 복제하지 않고도, 탭의 [리뷰] 이미지를 추측불가 공개 링크로
-- 업체에 보고할 수 있게 한다. 이미지는 서버 OAuth 프록시(/api/drive/image/:id)로 표시되므로
-- Drive 폴더를 공개 공유하지 않아도 되고, 원본은 tnaks 소유 그대로 유지된다(복제 0).
CREATE TABLE IF NOT EXISTS review_report_links (
  code         TEXT PRIMARY KEY,
  sheet_id     TEXT NOT NULL,
  tab_name     TEXT NOT NULL,
  display_name TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 탭당 1개 코드만 유지 → 재생성해도 동일 링크 재사용(업체에 보낸 링크가 안 깨짐)
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_report_tab ON review_report_links (sheet_id, tab_name);
