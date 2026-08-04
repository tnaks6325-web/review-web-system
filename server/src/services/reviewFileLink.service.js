/**
 * 리뷰 이미지 파일 ↔ 인덱스 행 결정적 링크 백필 — 단일 출처.
 *
 * 소비처 2곳이 같은 규칙을 쓴다(사본 금지 — 갈리면 "정리는 연결되는데 폴더 백필은 안 되는" 드리프트):
 *   ① POST /api/drive/relocate-orphan-reviews (흩어진 캡처 이동 + 링크)
 *   ② POST /api/drive/review-folder-backfill (탭 [리뷰] 폴더 스캔 → 링크)  ← 업체 뷰어 미리보기 재료
 *
 * 규칙(원조 relocate 블록 그대로):
 *   - 파일명에서 이름 추출(extractName 주입) → reviewer_name/recipient_name 정확 일치 행 매칭
 *   - A-1(대표): review_file_id 가 비어 있는 매칭 행이 정확히 1개일 때만 review_index 링크(모호하면 안 건드림)
 *   - A-2(원장): 모든 파일을 review_submissions 에 file_id 업서트(source='backfill') — row_index 는
 *     확정 매칭일 때만, 기존 값이 있으면 COALESCE 로 보존(재실행 안전·비파괴)
 *   - isDryRun 이면 어떤 write 도 하지 않고 판정 리포트만 만든다
 *
 * ★ 의존성 주입(db·extractName·logger)으로 순수하게 유지 — 회귀가드가 스텁으로 실제 실행한다.
 */

async function linkReviewFilesToRows({ db, sheetId, tabName, files, indexRows, isDryRun, extractName, logger }) {
  const warn = (m) => { try { if (logger && logger.warn) logger.warn(m); } catch (_) {} };
  // 이름 → 인덱스 행(들) 매핑 (reviewer_name/recipient_name 모두 키)
  const rowsByName = new Map();
  const addRow = (nm, r) => {
    const k = (nm || '').trim(); if (!k) return;
    if (!rowsByName.has(k)) rowsByName.set(k, []);
    const arr = rowsByName.get(k); if (!arr.includes(r)) arr.push(r);
  };
  for (const r of (indexRows || [])) { addRow(r.reviewer_name, r); addRow(r.recipient_name, r); }

  const result = { linked: 0, ambiguous: 0, unmatched: 0, already: 0, recorded: 0, samples: { ambiguous: [], unmatched: [] } };
  for (const f of (files || [])) {
    const nm = (extractName(f.name) || '').trim();
    const matchRows = rowsByName.get(nm) || [];
    const fileUrl = `https://drive.google.com/file/d/${f.id}/view`;
    let assocRow = null; // A-2 연결 인덱스 행 (확정 가능할 때만)

    if (matchRows.length === 0) {
      result.unmatched++;
      if (result.samples.unmatched.length < 30) result.samples.unmatched.push(f.name);
    } else {
      const unlinked = matchRows.filter(r => !r.review_file_id);
      if (unlinked.length === 1) {
        // A-1: 결정적 매칭 1건 → review_index 링크
        assocRow = unlinked[0];
        if (!isDryRun) {
          try {
            await db.query(
              `UPDATE review_index
                  SET review_file_id = $1, review_file_url = $2, review_file_name = $3,
                      review_file_count = GREATEST(COALESCE(review_file_count, 0), 1),
                      review_file_at = COALESCE($4::timestamptz, NOW())
                WHERE id = $5`,
              [f.id, fileUrl, f.name, f.createdTime || null, assocRow.id]
            );
          } catch (e) {
            warn(`[reviewFileLink] 링크 저장 실패 (${f.name}): ${e.message}`);
          }
        }
        assocRow.review_file_id = f.id; // 메모리 표시 → 같은 이름 추가 파일은 already
        result.linked++;
      } else if (unlinked.length === 0) {
        result.already++;
        if (matchRows.length === 1) assocRow = matchRows[0]; // 원장 연결은 가능
      } else {
        result.ambiguous++;
        if (result.samples.ambiguous.length < 30) result.samples.ambiguous.push(f.name);
      }
    }

    // A-2: 제출 원장 적재 (전 후보 파일, file_id 업서트)
    if (!isDryRun) {
      try {
        await db.query(
          `INSERT INTO review_submissions
             (sheet_id, tab_name, tab_gid, row_index, reviewer_name, review_index_id,
              file_id, file_url, file_name, source, uploaded_at)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,'backfill',$9::timestamptz)
           ON CONFLICT (file_id) DO UPDATE
             SET file_url = EXCLUDED.file_url, file_name = EXCLUDED.file_name,
                 row_index = COALESCE(EXCLUDED.row_index, review_submissions.row_index),
                 review_index_id = COALESCE(EXCLUDED.review_index_id, review_submissions.review_index_id),
                 reviewer_name = EXCLUDED.reviewer_name`,
          [sheetId, tabName, assocRow ? assocRow.row_index : null, nm || null,
           assocRow ? assocRow.id : null, f.id, fileUrl, f.name, f.createdTime || null]
        );
        result.recorded++;
      } catch (e) {
        warn(`[reviewFileLink] 제출원장 기록 실패 (${f.name}): ${e.message}`);
      }
    }
  }
  return result;
}

module.exports = { linkReviewFilesToRows };
