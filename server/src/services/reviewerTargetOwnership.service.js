const pool = require('../db/pool');
const { getOwnerScopeByLoginPhone8 } = require('./reviewerIdentity.service');

function phone8(value) {
  return String(value || '').replace(/\D/g, '').slice(-8);
}

async function ownsReviewerTarget({ session, sheetId, tabName, rowIndex, client = pool }) {
  if (!session?.ownerReviewerId || !sheetId || !tabName || !rowIndex) return false;
  const loginPhone8 = phone8(session.loginPhone8);
  const isSubAccount = session.loginKind === 'sub';
  if (isSubAccount && loginPhone8.length !== 8) return false;
  let phone8s = loginPhone8 ? [loginPhone8] : [];
  if (!isSubAccount) {
    try {
      const scope = await getOwnerScopeByLoginPhone8(loginPhone8);
      if (String(scope.ownerReviewerId || '') === String(session.ownerReviewerId)) {
        phone8s = scope.phone8s || phone8s;
      }
    } catch (_) { /* FK가 없는 과거 행은 로그인 번호로만 제한한다. */ }
  }

  const { rows } = await client.query(
    `SELECT 1
       FROM review_index ri
       LEFT JOIN participation_links pl
         ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
       LEFT JOIN campaign_participants cp
         ON cp.sheet_id = ri.sheet_id AND cp.tab_name = ri.tab_name AND cp.seq = ri.row_index
        AND cp.deleted_at IS NULL
      WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.row_index = $3
        AND (
          (
            $6::boolean = FALSE
            AND (
              (
                cp.seq IS NOT NULL
                AND (
                  cp.owner_reviewer_id = $4::uuid
                  OR (cp.owner_reviewer_id IS NULL AND cp.phone8 = ANY($5::text[]))
                )
              )
              OR (
                cp.seq IS NULL
                AND (
                  pl.owner_reviewer_id = $4::uuid
                  OR (
                    pl.owner_reviewer_id IS NULL
                    AND (ri.phone8 = ANY($5::text[]) OR pl.phone8 = ANY($5::text[]))
                  )
                )
              )
            )
          )
          OR (
            $6::boolean = TRUE
            AND (
              (
                cp.seq IS NOT NULL
                AND cp.phone8 = $7
                AND (
                  cp.owner_reviewer_id = $4::uuid
                  OR (cp.owner_reviewer_id IS NULL AND pl.owner_reviewer_id = $4::uuid)
                  OR (cp.owner_reviewer_id IS NULL AND pl.owner_reviewer_id IS NULL)
                )
              )
              OR (
                cp.seq IS NULL
                AND (
                  (pl.owner_reviewer_id = $4::uuid AND pl.phone8 = $7)
                  OR (pl.owner_reviewer_id IS NULL AND (pl.phone8 = $7 OR ri.phone8 = $7))
                )
              )
            )
          )
        )
      LIMIT 1`,
    [sheetId, tabName, rowIndex, session.ownerReviewerId, phone8s, isSubAccount, loginPhone8]
  );
  return rows.length === 1;
}

module.exports = { ownsReviewerTarget };
