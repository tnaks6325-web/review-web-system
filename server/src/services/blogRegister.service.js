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

/** 한 줄 입력 검증 — 실패면 BlogRegisterError 를 던진다(단건·여러 명 같은 규칙). */
function _validateLine({ name, phone, blogUrl } = {}) {
  const nm = String(name == null ? '' : name).trim();
  const ph = String(phone == null ? '' : phone).trim();
  const url = String(blogUrl == null ? '' : blogUrl).trim();
  if (!nm) _e('name_required', '블로거 이름을 입력해주세요.');
  // ★ 연락처 필수 — 없으면 그 사람이 자기 참여 내역·리뷰 제출 화면을 영영 못 찾는다(검색 키가 phone8).
  if (phone8Of(ph).length !== 8) _e('phone_required', '연락처를 정확히 입력해주세요(숫자 8자리 이상).');
  if (!isPostUrl(url)) _e('blog_url_required', `블로그 주소를 확인해주세요 (${BLOG_URL_HINT})`);
  return { name: nm, phone: ph, blogUrl: url, phone8: phone8Of(ph) };
}

/** 이 작업이 블로거를 넣을 수 있는 작업인가 + 넣을 칸(fail-closed). 쓰기 0. */
async function _resolveTarget(db, sheetId, tabName) {
  if (!sheetId || !tabName) _e('bad_request', '작업(시트·탭)이 지정되지 않았습니다.');
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); } catch (_) { sheetless = false; }
  // ★ 시트 기반 탭은 거부한다(조용히 다른 길로 가지 않는다) — 여기서 시트 append 경로를 새로 열면
  //   쓰기 표면이 늘고, 그 줄이 어느 쪽 진실원본인지 갈린다. 이관(탈시트 전환) 뒤에 등록한다.
  if (!sheetless) _e('not_sheetless', '아직 구글시트를 쓰는 작업이라 여기서 줄을 만들 수 없습니다. [탈시트 전환] 후 등록해주세요.');

  const { rows: tc } = await db.query(
    `SELECT tab_gid, campaign_name, work_kind FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
    [sheetId, tabName]);
  if (!tc.length) _e('tab_not_registered', '등록되지 않은 작업입니다(접수 후 이용해주세요).');

  // 종류 판정은 공고 > 탭(단일 출처) — 탭에만 값이 없어도 공고가 블로그면 등록할 수 있어야 한다.
  let campKind = null;
  try { campKind = await require('./workKindContext.service').workKindForTab({ sheetId, tabName }); } catch (_) { campKind = null; }
  const kind = campKind || resolveWorkKind({ tabKind: tc[0].work_kind });
  if (!isBlogKind(kind)) {
    _e('not_blog', '이 작업은 블로그체험단으로 지정되어 있지 않습니다. 공고(또는 탭 설정)에서 체험단 종류를 블로그로 지정해주세요.');
  }

  const tabGid = String(tc[0].tab_gid || '');
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

  return {
    tabGid, campaignName: tc[0].campaign_name || null, headers, blogCols,
    numHeader: col.num >= 0 ? headers[col.num] || '' : '',
    columns: { name: headers[col.name], phone: headers[col.phone], blog: headers[blogCols[0]] },
  };
}

/**
 * ★★ 이미 그 표에 있는 연락처 — 칸(phone8) **또는 표에 적힌 연락처**로 본다.
 *   사전등록 줄은 2026-11-03 전까지 phone8 칸을 비워 두고 row_json 에만 연락처를 넣었다 —
 *   칸만 보면 그 줄들끼리의 중복을 못 잡는다.
 */
async function _existingPhones(q, sheetId, tabName, { phoneHeader, nameHeader }, phone8s) {
  if (!phone8s.length) return new Map();
  const { rows } = await q.query(
    `SELECT seq, reviewer_name, row_json->>$4 AS name_cell,
            COALESCE(NULLIF(phone8, ''), right(regexp_replace(COALESCE(row_json->>$3, ''), '[^0-9]', '', 'g'), 8)) AS p8
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
        AND (phone8 = ANY($5::text[]) OR right(regexp_replace(COALESCE(row_json->>$3, ''), '[^0-9]', '', 'g'), 8) = ANY($5::text[]))
      ORDER BY seq`,
    [sheetId, tabName, phoneHeader, nameHeader, phone8s]);
  const m = new Map();
  for (const r of rows) if (r.p8 && !m.has(r.p8)) m.set(r.p8, r);
  return m;
}

/**
 * 블로거 여러 명을 그 작업의 표에 등록한다(직원이 직접 섭외한 블로거 — 공고·승인 없이).
 *
 * ★★ 준비된 **빈 줄부터** 채운다(2026-11-03 · 결정 328) — 종전에는 맨 뒤에 줄을 덧붙여 모집인원을 넘겼고,
 *   이름·연락처를 `row_json` 에만 넣어 그 줄이 빈 줄로 판정됐다(openSlotRowSql 은 칸만 본다).
 *   그 결과 블로거 본인의 구매양식이 **맨 위 빈 줄**로 들어가 한 사람이 두 줄(주소만 있는 줄 + 주문만 있는 줄)이 됐다.
 *   → 줄 쓰기는 `participants.fillPreparedRow` 가 칸(reviewer_name·phone8)까지 함께 채운다.
 * ★ 빈 줄이 모자라면 남은 사람은 맨 뒤에 새 줄로 붙인다(종전 동작) — 결과의 `appended` 로 알린다.
 * ★ dryRun = 쓰기 0. 줄별 자리(seq)와 새 줄 여부를 미리 보여준다.
 * ★ 한 명이라도 거부되면 **아무도 넣지 않는다**(일부만 들어가면 누가 빠졌는지 놓친다).
 *
 * @returns {{ok:true, dryRun:boolean, columns:object, rows:Array<{name:string,phone:string,seq:number,appended:boolean}>, appended:number}}
 */
async function registerBloggers({ sheetId, tabName, lines = [], dryRun = false, by = 'admin' } = {}) {
  const db = _db();
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) _e('lines_required', '넣을 블로거를 한 명 이상 입력해주세요.');
  if (list.length > 200) _e('too_many', '한 번에 200명까지 넣을 수 있습니다.');
  const parsed = list.map((ln, i) => {
    try { return _validateLine(ln); }
    catch (e) { if (e instanceof BlogRegisterError) _e(e.code, list.length > 1 ? `${i + 1}번째 줄: ${e.message}` : e.message); throw e; }
  });
  const seen = new Map();
  parsed.forEach((p, i) => {
    if (seen.has(p.phone8)) _e('duplicate', `${i + 1}번째 줄의 연락처가 ${seen.get(p.phone8) + 1}번째 줄과 같습니다.`);
    seen.set(p.phone8, i);
  });

  const target = await _resolveTarget(db, sheetId, tabName);
  const { columns, headers, blogCols } = target;
  const { MANUAL_SEQ_BASE } = require('./participants.service');
  const { openSlotRowSql } = require('../utils/worktableOpenSlot');
  // ★ 빈 줄 = 주문 판정(openSlotRowSql)과 **같은 조건** + 표에 이름·연락처가 적혀 있지 않은 줄
  //   (종전 방식으로 등록돼 칸이 빈 블로거 줄을 덮지 않는다).
  const openSql = `SELECT cp.seq FROM campaign_participants cp
      WHERE ${openSlotRowSql('cp', { sheet: '$1', tab: '$2', workboard: 'NULL' })}
        AND cp.seq < ${MANUAL_SEQ_BASE}
        AND NULLIF(btrim(COALESCE(cp.row_json->>$3, '')), '') IS NULL
        AND NULLIF(btrim(COALESCE(cp.row_json->>$4, '')), '') IS NULL
      ORDER BY cp.seq`;
  const openArgs = [sheetId, tabName, columns.name, columns.phone];

  const plan = async (q) => {
    const dup = await _existingPhones(q, sheetId, tabName, { phoneHeader: columns.phone, nameHeader: columns.name }, parsed.map(p => p.phone8));
    parsed.forEach((p, i) => {
      const d = dup.get(p.phone8);
      if (d) {
        _e('duplicate', `${list.length > 1 ? `${i + 1}번째 줄: ` : ''}이 연락처는 이미 ${d.seq}번 줄에 있습니다(${String(d.reviewer_name || d.name_cell || '이름 없음')}).`);
      }
    });
    const { rows: open } = await q.query(openSql, openArgs);
    const { rows: mx } = await q.query(
      `SELECT COALESCE(MAX(seq) FILTER (WHERE seq < ${MANUAL_SEQ_BASE}), 1) AS m FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
      [sheetId, tabName]);
    let next = Number(mx[0].m) + 1;
    return parsed.map((p, i) => (i < open.length
      ? { ...p, seq: Number(open[i].seq), appended: false }
      : { ...p, seq: next++, appended: true }));
  };

  const summary = rows => ({
    ok: true, dryRun, columns,
    rows: rows.map(r => ({ name: r.name, phone: r.phone, seq: r.seq, appended: r.appended })),
    appended: rows.filter(r => r.appended).length,
  });

  if (dryRun) return summary(await plan(db));

  const parts = require('./participants.service');
  const client = await db.connect();
  let placed;
  try {
    await client.query('BEGIN');
    // ★ 주문 기록과 같은 탭 잠금 — 그 사이 들어온 주문과 같은 빈 줄을 두고 겨루지 않는다.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sheetless_worktable:${sheetId}:${tabName}`]);
    placed = await plan(client);
    for (const r of placed) {
      const rowPatch = {};
      rowPatch[columns.name] = r.name;
      rowPatch[columns.phone] = r.phone;
      // 매퍼가 쓰는 칸 **전부**에 같은 값(보통 1칸) — 한 칸만 채우면 다른 칸이 빈 채 남는다.
      blogCols.forEach(ci => { if (headers[ci]) rowPatch[headers[ci]] = r.blogUrl; });
      if (r.appended) {
        const rowJson = target.numHeader ? { [target.numHeader]: '' } : {};
        // ★ minSeq 2 — 1번은 열 이름 줄이다. 빈 표에서 1번에 넣으면 장부가 그 줄을 건너뛰어 검색 명단에 안 들어간다(Codex P2).
        const added = await parts.appendSlot(client, {
          sheetId, tabName, tabGid: target.tabGid || null, campaignName: target.campaignName, rowJson, by: `blog-register:${by}`, minSeq: 2,
        });
        if (!added) _e('append_failed', '새 줄을 만들지 못했습니다. 잠시 뒤 다시 시도해주세요.');
        r.seq = Number(added.seq);
        if (target.numHeader) rowPatch[target.numHeader] = String(r.seq - 1);
      }
      const ok = await parts.fillPreparedRow(client, {
        sheetId, tabName, seq: r.seq, name: r.name, phone8: r.phone8, rowPatch, by: `blog-register:${by}`,
      });
      if (!ok) _e('slot_taken', `${r.seq}번 줄에 방금 다른 사람이 들어왔습니다. 다시 시도해주세요.`);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 연결 오류 */ }
    throw e;
  } finally {
    client.release();
  }
  // ★ 장부 재생성을 빼면 표에는 있는데 **검색·행배정에는 없는** 줄이 된다(= 블로거가 자기 건을 못 찾는다).
  await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by });

  logger.info(`[blog/register] 블로거 사전등록 ${placed.length}명: ${tabName} (빈 줄 ${placed.length - placed.filter(r => r.appended).length} · 새 줄 ${placed.filter(r => r.appended).length}) by ${by}`);
  return summary(placed);
}

/**
 * ★★ 이 연락처로 **미리 등록된 블로거 줄**(주문 아직 없음)의 번호 — 없으면 null.
 *   블로거 본인의 구매양식이 그 줄로 들어가게 한다(결정 328). 안 그러면 주문은 맨 위 빈 줄로 가고
 *   블로그 주소가 적힌 본인 줄은 주문 없이 남는다(2026-11-03 실제 제출 경로로 재현).
 * ★ **블로그 작업만**(종류 판정 = 공고 > 탭) — 리뷰 작업의 줄 고르기는 종전 그대로.
 * ★ 판정 실패는 null(= 종전 경로 · fail-open) — 주문 접수를 막지 않는다.
 * ★ `lock` = 호출부 트랜잭션·탭 잠금 안에서 그 줄을 FOR UPDATE 로 잡는다.
 */
async function preRegisteredSeq(q, { sheetId, tabName, phone8, workboardId = null, lock = false } = {}) {
  const p8 = String(phone8 || '').replace(/\D/g, '').slice(-8);
  if (!q || !sheetId || !tabName || p8.length !== 8) return null;
  try {
    const { MANUAL_SEQ_BASE } = require('./participants.service');
    const { tableOrderNumOf } = require('../utils/tableOrderNum');
    /* ★★ 주문 링크가 비었다고 "구매 전"은 아니다(Codex P1) — 가져온 줄(source='import')·담당자 수기 주문 줄은 링크 없이
         구매·제출·입금이 적혀 있다. 그런 줄을 등록 줄로 집으면 새 구매가 예전 구매를 덮어쓴다.
         → 작업표가 만든 줄(source='worktable') · 표 주문번호 없음 · 제출/입금 표시 없음인 줄만. */
    // 별칭 pr — 주문 기록의 중복 방어 조회(cp.phone8 + 표 주문번호)와 섞여 읽히지 않게.
    const { rows } = await q.query(
      `SELECT pr.seq, pr.row_json FROM campaign_participants pr
        WHERE pr.sheet_id=$1 AND pr.tab_name=$2 AND pr.deleted_at IS NULL AND pr.active = TRUE
          AND pr.order_submission_id IS NULL AND pr.phone8 = $3 AND pr.seq < ${MANUAL_SEQ_BASE}
          AND pr.source = 'worktable' AND pr.is_submitted = FALSE AND pr.is_paid = FALSE
          AND ($4::uuid IS NULL OR pr.workboard_id IS NULL OR pr.workboard_id = $4::uuid)
        ORDER BY pr.seq LIMIT 1${lock ? ' FOR UPDATE OF pr' : ''}`,
      [sheetId, tabName, p8, workboardId]);
    // 표에 주문번호가 적힌 줄(담당자 수기 주문)은 구매가 있는 줄이다 — 판정은 tableOrderNum 과 같은 규칙.
    if (!rows.length || tableOrderNumOf(rows[0].row_json)) return null;
    // ★ 종류 판정은 **후보 줄이 있을 때만**(공고 > 탭) — 주문 대부분(리뷰 작업·미등록 리뷰어)은 위 한 번의 조회로 끝난다.
    const { rows: tc } = await q.query(`SELECT work_kind FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]);
    if (!tc.length) return null;
    let campKind = null;
    try { campKind = await require('./workKindContext.service').workKindForTab({ sheetId, tabName }); } catch (_) { campKind = null; }
    if (!isBlogKind(campKind || resolveWorkKind({ tabKind: tc[0].work_kind }))) return null;
    return Number(rows[0].seq);
  } catch (e) {
    logger.warn(`[blog/register] 사전등록 줄 찾기 실패 — 종전 경로: ${e.message}`);
    return null;
  }
}

/**
 * 블로거 한 명 — 종전 응답 모양(`seq`·`columns`) 그대로. 규칙은 registerBloggers 와 같다.
 * @returns {{ok:true, seq:number, dryRun:boolean, appended:boolean, columns:{name:string,phone:string,blog:string}}}
 */
async function registerBlogger({ sheetId, tabName, name, phone, blogUrl, dryRun = false, by = 'admin' } = {}) {
  if (!sheetId || !tabName) _e('bad_request', '작업(시트·탭)이 지정되지 않았습니다.');
  const r = await registerBloggers({ sheetId, tabName, lines: [{ name, phone, blogUrl }], dryRun, by });
  return { ok: true, dryRun: r.dryRun, seq: r.rows[0].seq, appended: r.rows[0].appended, columns: r.columns };
}

module.exports = { registerBlogger, registerBloggers, preRegisteredSeq, phone8Of, BlogRegisterError, __setPoolForTest };
