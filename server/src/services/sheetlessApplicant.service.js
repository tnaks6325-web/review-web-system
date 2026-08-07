/**
 * sheetlessApplicant.service.js — 이관된 작업의 레거시 공고 참여 행 추가 (W5 전제)
 *
 * ★★ 왜 필요한가: 레거시(참여형 아님) 공고의 참여 확정은 주문 원장·큐를 **거치지 않고**
 *    `campaign.routes` 가 `appendSheet` 로 **시트에 직접** 쓴다. 이관된 작업에서는 그 시트를
 *    아무도 읽지 않으므로, 그대로 두면 **참여자가 명단에서 통째로 사라진다**
 *    (시트에는 남지만 시스템 표·검색 명단 어디에도 안 들어온다).
 *
 * ★ 열 판정은 `utils/applicantColumns` 단일 출처(시트 경로와 같은 별칭·같은 매칭).
 * ★ 작업표 INSERT 는 `participants.createSlotsFromSheetRows` 한 곳(쓰기 소유자 규율).
 * ★ 시트 기반 탭이면 `{handled:false}` — 호출부는 자기 기존 경로(appendSheet)를 그대로 탄다.
 */
const { logger } = require('../utils/logger');
const { resolveApplicantColumns } = require('../utils/applicantColumns');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

/**
 * @returns {{handled:boolean, reason?:string, seq?:number}}
 *   handled=false → 이 탭은 무시트가 아니거나 판정 불가 → 호출부가 종전 경로로.
 * ★★ 무시트인데 실패하면 **throw** 한다 — 조용히 false 를 돌려주면 호출부가 시트에 쓰고,
 *    그 줄은 아무도 읽지 않는 곳에 남는다(= 참여자 실종). 실패는 드러나야 한다.
 */
async function addApplicantRow({ sheetId, tabName, applicant, by = 'campaign-apply' } = {}) {
  if (!sheetId || !tabName || !applicant || !applicant.name) return { handled: false, reason: 'bad_request' };
  const db = _db();

  let sheetless = false;
  try {
    sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName);
  } catch (_) { sheetless = false; }          // 판정 실패 = 종전 경로(fail-open) — 시트 기반이 절대 다수다
  if (!sheetless) return { handled: false, reason: 'not_sheetless' };

  const { rows: tc } = await db.query(
    `SELECT tab_gid, campaign_name FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) throw new Error('이관된 작업인데 탭 등록 정보가 없습니다.');
  const tabGid = String(tc[0].tab_gid || '');

  // 열 이름 = 장부가 쓰는 것과 같은 것(detected_headers 우선 — 시트 A1 행이 아니라 진짜 헤더).
  const { rows: rt } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_gid=$2 LIMIT 1`, [sheetId, tabGid]);
  const raw = rt.length ? (rt[0].detected_headers || rt[0].headers) : null;
  const headers = (Array.isArray(raw) ? raw : []).map(h => String(h == null ? '' : h)).filter(h => h.trim());
  if (!headers.length) throw new Error('이관된 작업의 열 구성을 알 수 없습니다.');

  const col = resolveApplicantColumns(headers);
  if (col.name < 0) throw new Error('이관된 작업에서 이름 열을 찾을 수 없습니다.');

  // 다음 자리 = 표의 마지막 seq + 1. ★ 삭제된 줄도 세어 seq 를 재사용하지 않는다
  //   (재사용하면 주문 배정·투영의 (sheet,tab,seq) 키가 옛 줄과 충돌한다).
  const { rows: mx } = await db.query(
    `SELECT COALESCE(MAX(seq), 1) AS m FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
    [sheetId, tabName]);
  const seq = Number(mx[0].m) + 1;

  const rowJson = {};
  if (col.num >= 0 && headers[col.num]) rowJson[headers[col.num]] = String(seq - 1);
  rowJson[headers[col.name]] = String(applicant.name || '');
  if (col.phone >= 0 && applicant.phone) rowJson[headers[col.phone]] = String(applicant.phone);
  if (col.inad >= 0 && applicant.inad) rowJson[headers[col.inad]] = String(applicant.inad);

  await require('./participants.service').createSlotsFromSheetRows({
    sheetId, tabName, tabGid, campaignName: tc[0].campaign_name || null,
    rows: [{ seq, rowJson }], by,
  });

  // 장부 재생성 — 이걸 빼면 표에는 있는데 **검색·행배정에는 없는** 줄이 된다.
  await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by });

  logger.info(`[campaign/sheetless] 참여 행 추가: ${tabName} - ${applicant.name} (자리 ${seq})`);
  return { handled: true, seq };
}

module.exports = { addApplicantRow, __setPoolForTest };
