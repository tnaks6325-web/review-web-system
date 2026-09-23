/**
 * blogRegister.service.js — 블로거 사전등록 (블로그체험단 M5-2)
 *
 * ★★ 왜 필요한가: 블로그체험단은 **모집공고 밖(카톡·직접 섭외)** 으로 데려오는 블로거가 있다.
 *    그 사람은 공고 참여(홀드)를 하지 않으므로 M5-1 의 apply 경로로는 명단에 들어올 수 없고,
 *    담당자가 표를 눈으로 채워도 **연락처가 없으면 리뷰어가 자기 참여 내역을 못 찾는다**.
 *    → 이름·연락처·블로그 주소를 받아 **작업표 줄**을 만들고 장부를 다시 만든다.
 *
 * ★ 사용자 확정(2026-08-10): 창구 = **작업보드 [＋ 블로거 추가]**(관제 패널 아님) ·
 *   구매양식은 **블로거가 직접** 제출(여기서는 명단과 블로그 주소까지만).
 *
 * ★★ 판정·쓰기 사본 0
 *   - 무시트 판정 `utils/sheetlessScope` · 종류 판정 `utils/workKind`(공고 > 탭)
 *   - 주소 형식 `utils/blogPostUrl.isPostUrl`(리뷰어 입력과 **같은 규칙**)
 *   - 이름/연락처 열 `utils/applicantColumns` · **블로그 열 `orderLedger.blogUrlWriteColumns`**
 *     (매퍼 파생 — 헤더 문자열 사본을 두면 "사전등록이 넣은 칸 ≠ 제출이 쓰는 칸"으로 갈린다)
 *   - 줄 INSERT `participants.createSlotsFromSheetRows`(campaign_participants 쓰기 소유자)
 *   - 장부 `sheetlessLedger.rebuildLedgers`
 *
 * ★★ fail-closed — 넣을 칸이 없거나 종류가 블로그가 아니면 **거부하고 사유를 말한다**.
 *    숫자만 채우고 "등록했다"고 말하는 쪽이 훨씬 나쁘다(sheet-import 연락처 규율과 같다).
 */
const { logger } = require('../utils/logger');
const { resolveApplicantColumns } = require('../utils/applicantColumns');
const { isPostUrl, BLOG_URL_HINT } = require('../utils/blogPostUrl');
const { isBlogKind, resolveWorkKind } = require('../utils/workKind');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

class BlogRegisterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const _e = (code, msg) => { throw new BlogRegisterError(code, msg); };

/** 연락처 뒤 8자리(검색·소유권 키와 같은 파생) */
function phone8Of(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

/**
 * 블로거 한 명을 그 작업의 표에 등록한다.
 * @returns {{ok:true, seq:number, dryRun:boolean, columns:{name:string,phone:string,blog:string}}}
 */
async function registerBlogger({ sheetId, tabName, name, phone, blogUrl, dryRun = false, by = 'admin' } = {}) {
  const db = _db();
  const nm = String(name == null ? '' : name).trim();
  const ph = String(phone == null ? '' : phone).trim();
  const url = String(blogUrl == null ? '' : blogUrl).trim();

  if (!sheetId || !tabName) _e('bad_request', '작업(시트·탭)이 지정되지 않았습니다.');
  if (!nm) _e('name_required', '블로거 이름을 입력해주세요.');
  // ★ 연락처 필수 — 없으면 그 사람이 자기 참여 내역·리뷰 제출 화면을 영영 못 찾는다(검색 키가 phone8).
  if (phone8Of(ph).length !== 8) _e('phone_required', '연락처를 정확히 입력해주세요(숫자 8자리 이상).');
  if (!isPostUrl(url)) _e('blog_url_required', `블로그 주소를 확인해주세요 (${BLOG_URL_HINT})`);

  // ── 이 작업이 대상인가 ──────────────────────────────────────────────
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); } catch (_) { sheetless = false; }
  // ★ 시트 기반 탭은 거부한다(조용히 다른 길로 가지 않는다) — 여기서 시트 append 경로를 새로 열면
  //   쓰기 표면이 늘고, 그 줄이 어느 쪽 진실원본인지 갈린다. 이관(탈시트 전환) 뒤에 등록한다.
  if (!sheetless) _e('not_sheetless', '아직 구글시트를 쓰는 작업이라 여기서 줄을 만들 수 없습니다. [탈시트 전환] 후 등록해주세요.');

  const { rows: tc } = await db.query(
    `SELECT tab_gid, campaign_name, work_kind FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
    [sheetId, tabName]);
  if (!tc.length) _e('tab_not_registered', '등록되지 않은 작업입니다(접수 후 이용해주세요).');
  const tabGid = String(tc[0].tab_gid || '');

  // 종류 판정은 공고 > 탭(단일 출처) — 탭에만 값이 없어도 공고가 블로그면 등록할 수 있어야 한다.
  let campKind = null;
  try { campKind = await require('./workKindContext.service').workKindForTab({ sheetId, tabName }); } catch (_) { campKind = null; }
  const kind = campKind || resolveWorkKind({ tabKind: tc[0].work_kind });
  if (!isBlogKind(kind)) {
    _e('not_blog', '이 작업은 블로그체험단으로 지정되어 있지 않습니다. 공고(또는 탭 설정)에서 체험단 종류를 블로그로 지정해주세요.');
  }

  // ── 넣을 칸이 있는가(fail-closed) ───────────────────────────────────
  const { rows: rt } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_gid=$2 LIMIT 1`, [sheetId, tabGid]);
  const rawH = rt.length ? (rt[0].detected_headers || rt[0].headers) : null;
  const headers = (Array.isArray(rawH) ? rawH : []).map(h => String(h == null ? '' : h)).filter(h => h.trim());
  if (!headers.length) _e('no_headers', '이 작업의 열 구성을 알 수 없습니다.');

  const col = resolveApplicantColumns(headers);
  if (col.name < 0) _e('no_name_column', '이름(수취인) 열이 없어 사람을 넣을 수 없습니다. 작업표 열 구성을 확인해주세요.');
  if (col.phone < 0) _e('no_phone_column', '연락처 열이 없습니다. 연락처가 없으면 블로거가 자기 참여 내역을 찾을 수 없습니다.');
  // ★ 블로그 칸은 **매퍼가 쓰는 칸**으로 찾는다(사본 금지) — 없으면 주소를 넣을 데가 없다.
  const blogCols = require('./orderLedger.service').blogUrlWriteColumns(headers);
  if (!blogCols.length) _e('no_blog_column', '블로그 주소를 넣을 열이 없습니다. 작업표에 `블로그주소` 열을 추가해주세요.');

  // ── 중복(같은 연락처가 이미 그 표에 있음) ──────────────────────────
  const p8 = phone8Of(ph);
  const { rows: dup } = await db.query(
    `SELECT seq, reviewer_name FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND phone8=$3
      ORDER BY seq LIMIT 1`, [sheetId, tabName, p8]);
  if (dup.length) {
    _e('duplicate', `이 연락처는 이미 ${dup[0].seq}번 줄에 있습니다(${String(dup[0].reviewer_name || '이름 없음')}).`);
  }

  // 다음 자리 = 표의 마지막 seq + 1. ★ 삭제된 줄도 세어 재사용하지 않는다((sheet,tab,seq) 키 충돌).
  const { rows: mx } = await db.query(
    `SELECT COALESCE(MAX(seq), 1) AS m FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
    [sheetId, tabName]);
  const seq = Number(mx[0].m) + 1;

  const cols = {
    name: headers[col.name],
    phone: headers[col.phone],
    blog: headers[blogCols[0]],
  };
  if (dryRun) return { ok: true, dryRun: true, seq, columns: cols };

  const rowJson = {};
  if (col.num >= 0 && headers[col.num]) rowJson[headers[col.num]] = String(seq - 1);
  rowJson[cols.name] = nm;
  rowJson[cols.phone] = ph;
  // 매퍼가 쓰는 칸 **전부**에 같은 값(보통 1칸) — 한 칸만 채우면 다른 칸이 빈 채 남는다.
  blogCols.forEach(ci => { if (headers[ci]) rowJson[headers[ci]] = url; });

  await require('./participants.service').createSlotsFromSheetRows({
    sheetId, tabName, tabGid, campaignName: tc[0].campaign_name || null,
    rows: [{ seq, rowJson }], by,
  });
  // ★ 장부 재생성을 빼면 표에는 있는데 **검색·행배정에는 없는** 줄이 된다(= 블로거가 자기 건을 못 찾는다).
  await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by });

  logger.info(`[blog/register] 블로거 사전등록: ${tabName} - ${nm} (자리 ${seq}) by ${by}`);
  return { ok: true, dryRun: false, seq, columns: cols };
}

module.exports = { registerBlogger, phone8Of, BlogRegisterError, __setPoolForTest };
