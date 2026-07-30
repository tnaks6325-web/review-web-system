/**
 * 외부모집 구매양식 관리자 수동제출 서비스.
 *
 * 배경: 리뷰어 페이지로 참여하지 못하는 외부 리뷰어를 카톡으로 모집해 관리자가 구글시트에
 *   직접 수기 입력해 왔다. 그 수기 입력이 "유령 written"(DB=성공, 시트=없음) 사고의 유발 조건이었고,
 *   캠페인 모집 정원에도 안 잡히며, 외부 리뷰어는 시스템에 없어 리뷰캡쳐를 우리 경로로 못 냈다.
 *   → 관리자가 슬래시양식을 붙여넣으면 **리뷰어가 직접 제출한 것과 같은 길**로 접수한다.
 *
 * 설계 원칙
 *  1) 원장은 `createOrderLedgerEntry` **단일 진입점 재사용**. diag의 order-manual-add 처럼
 *     행배정 로직을 인라인 복제하지 않는다(이미 그쪽이 campaignHold 미처리로 드리프트했다).
 *  2) 리뷰어 등록은 `registerReviewer` 단일 경로 재사용(ON CONFLICT 3분기 멱등성 상속) +
 *     주소·계좌는 `handleReviewerProfile`로 **빈 칸만 백필**(기존 리뷰어 정보 덮어쓰기 금지).
 *  3) 참여형 캠페인이면 `campaign_applications` 행을 만들어 즉시 submitted → 정원 차감.
 *     잠금 계층은 기존과 동일: **recruit_campaigns 행 FOR UPDATE → 신청 행**.
 *  4) 건별 독립 처리 — 5건 중 1건이 실패해도 나머지는 접수된다(카톡 재수집 비용 회피).
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { createOrderLedgerEntry, markOrderQueued, markOrderMirrorFailed } = require('./orderLedger.service');
const { enqueue } = require('./syncQueue.service');
const { registerReviewer } = require('./reviewer.service');
const { findSubAccount } = require('./identity.service');
const { digits } = require('../utils/slashForm');

/** 외부 대리제출 건의 출처 표시 — Track B가 특수취급하는 'manual'과 구분한다.
 *  ★ trackB.service.js가 source==='manual'을 "재투영 면역 물리행"으로 다루는데,
 *    이 기능의 건들은 order_submission_id를 가진 정상 원장 건이므로 그 면역에 들어가면 오분류된다. */
const SOURCE_EXTERNAL = 'admin_external';

const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();

/**
 * 리뷰어 등록·연결.
 *  - 본인 건(리뷰어 == 수취인): 그 명의로 등록/멱등 확인
 *  - 타계정 건(리뷰어 != 수취인): 소유자(리뷰어명)를 기존 리뷰어에서 찾아 연결하고,
 *    수취인을 그 리뷰어의 sub_accounts 에 등록. 소유자를 못 찾으면 명의(수취인) 기준 단독 등록 + 경고.
 * 전화가 11자리가 아니면 등록 자체가 불가(registerReviewer 계약) → 생략하고 경고만.
 * @returns {{registered:boolean, linkedOwner:string|null, warnings:string[], ownerPhone8:string|null}}
 */
async function ensureExternalReviewer(f, { db = pool } = {}) {
  const warnings = [];
  const phoneDigits = digits(f.phone);
  const p8 = phoneDigits.slice(-8);
  const isSub = !!f.isSubAccount;

  if (phoneDigits.length !== 11) {
    warnings.push('전화번호가 11자리가 아니어서 리뷰어 자동등록을 건너뜁니다');
    return { registered: false, linkedOwner: null, ownerPhone8: null, warnings };
  }

  // ── 타계정 건: 소유자(리뷰어명)를 기존 리뷰어에서 찾는다 ──
  let owner = null;
  if (isSub) {
    const { rows } = await db.query(
      `SELECT id, name, phone, phone8, sub_accounts FROM reviewers
        WHERE REPLACE(LOWER(name), ' ', '') = $1 AND status <> 'inactive'
        ORDER BY registered_at ASC LIMIT 2`,
      [norm(f.reviewerName)]);
    if (rows.length === 1) owner = rows[0];
    else if (rows.length > 1) warnings.push(`'${f.reviewerName}' 이름의 리뷰어가 여러 명이라 소유자 연결을 건너뜁니다`);
    else warnings.push(`소유자 '${f.reviewerName}'을(를) 찾지 못해 수취인 명의로 단독 등록합니다`);
  }

  if (owner) {
    // 수취인을 소유자의 타계정 명부에 등록(이미 있으면 그대로) — findSubAccount와 같은 정규화 사용
    let subs = owner.sub_accounts;
    if (typeof subs === 'string') { try { subs = JSON.parse(subs); } catch (_) { subs = []; } }
    if (!Array.isArray(subs)) subs = [];
    if (!findSubAccount(subs, f.recipient, p8)) {
      subs.push({
        name: String(f.recipient || '').trim(),
        phone: f.phone,
        address: f.address || '',
        bankName: f.bank || '', bankAccount: f.account || '', accountHolder: f.depositor || '',
      });
      await db.query('UPDATE reviewers SET sub_accounts = $1::jsonb WHERE id = $2',
        [JSON.stringify(subs), owner.id]);
    }
    return { registered: true, linkedOwner: owner.name, ownerPhone8: owner.phone8 || null, warnings };
  }

  // ── 본인 건 or 소유자 미확인 → 명의(수취인) 기준 등록 ──
  const regName = String((isSub ? f.recipient : (f.reviewerName || f.recipient)) || '').trim();
  const reg = await registerReviewer({ name: regName, phone: phoneDigits, consent: true });
  if (!reg.ok) { warnings.push(`리뷰어 등록 실패: ${reg.error}`); return { registered: false, linkedOwner: null, ownerPhone8: null, warnings }; }
  if (reg.addedAsSubAccount) {
    warnings.push(`이 번호는 이미 '${reg.mainName}' 리뷰어의 번호라 타계정으로 추가되었습니다`);
  }

  // 주소·계좌 백필 — 등록 INSERT에는 없는 항목이라 여기서 채워야 내정보 4종이 완비되고,
  // 이후 리뷰어가 직접 로그인해 리뷰캡쳐를 제출할 수 있다.
  // ★ 반드시 "비어 있을 때만" 채운다. 기존 saveBankInfo/saveAddress 는 값이 있으면 덮어쓰므로 쓰지 않는다
  //   — 이미 등록된 리뷰어의 계좌를 카톡으로 받은 값으로 갈아치우면 정산 사고가 난다.
  // ★ 대상은 phone(UNIQUE)으로 지목한다. phone8은 GENERATED·비유니크라 동일 phone8 타인 행을 건드릴 수 있다.
  try {
    await db.query(
      `UPDATE reviewers SET
         address        = CASE WHEN COALESCE(address,'')        = '' THEN $2 ELSE address END,
         bank_name      = CASE WHEN COALESCE(bank_name,'')      = '' THEN $3 ELSE bank_name END,
         bank_account   = CASE WHEN COALESCE(bank_account,'')   = '' THEN $4 ELSE bank_account END,
         account_holder = CASE WHEN COALESCE(account_holder,'') = '' THEN $5 ELSE account_holder END
       WHERE phone = $1`,
      [phoneDigits, f.address || '', f.bank || '', f.account || '', f.depositor || '']);
  } catch (e) { warnings.push('주소·계좌 저장 중 일부 실패(제출은 계속)'); }

  return { registered: true, linkedOwner: null, ownerPhone8: null, warnings };
}

/**
 * 참여형 캠페인 신청 행 생성 → 즉시 확정(submitted). 정원 차감의 유일한 수단
 * (정원 = campaign_applications.status='submitted' 행 수).
 * 잠금 계층 준수: recruit_campaigns FOR UPDATE → 신청 행.
 * @returns {{ok:boolean, applicationId?:number, skipped?:string, error?:string}}
 */
async function confirmExternalApplication(client, { campaignId, name, phone, phone8, optionKey, orderSubmissionId, allowOverCapacity }) {
  const { rows: cRows } = await client.query(
    'SELECT id, participation_mode, recruit_total FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
  if (!cRows.length) return { ok: false, error: '캠페인을 찾을 수 없습니다' };
  if (!cRows[0].participation_mode) return { ok: false, skipped: 'not_participation' };

  // 같은 (캠페인, 명의)로 이미 확정된 참여가 있으면 중복 차단(리뷰어 apply와 같은 규칙)
  const { rows: dup } = await client.query(
    `SELECT id FROM campaign_applications
      WHERE campaign_id = $1 AND phone8 = $2 AND status = 'submitted' LIMIT 1`, [campaignId, phone8]);
  if (dup.length) return { ok: false, error: `이 캠페인에 이미 확정된 참여(#${dup[0].id})가 있습니다` };

  // 정원 확인 — 외부모집은 이미 약속된 건이라 기본 허용하되, 초과 사실은 호출부에 알린다
  const total = Number(cRows[0].recruit_total) || 0;
  let overCapacity = false;
  if (total > 0) {
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM campaign_applications WHERE campaign_id = $1 AND status = 'submitted'`, [campaignId]);
    if (cnt[0].n >= total) {
      if (!allowOverCapacity) return { ok: false, error: `모집 정원(${total}명)이 이미 찼습니다` };
      overCapacity = true;
    }
  }

  // 살아있는 applied 홀드가 있으면 그것을 확정(중복 행 생성 방지), 없으면 새로 만든다
  const { rows: live } = await client.query(
    `SELECT id FROM campaign_applications
      WHERE campaign_id = $1 AND phone8 = $2 AND status = 'applied'
      ORDER BY applied_at DESC LIMIT 1 FOR UPDATE`, [campaignId, phone8]);

  let appId;
  if (live.length) {
    appId = live[0].id;
    await client.query(
      `UPDATE campaign_applications
          SET status = 'submitted', submitted_at = NOW(), order_submission_id = $2, option_key = COALESCE($3, option_key)
        WHERE id = $1`, [appId, orderSubmissionId, optionKey || null]);
  } else {
    const ins = await client.query(
      `INSERT INTO campaign_applications
         (campaign_id, applicant_name, applicant_phone, phone8, status, applied_at, submitted_at, order_submission_id, option_key)
       VALUES ($1,$2,$3,$4,'submitted',NOW(),NOW(),$5,$6)
       RETURNING id`,
      [campaignId, name, phone, phone8, orderSubmissionId, optionKey || null]);
    appId = ins.rows[0].id;
  }

  const { maybePersistClosed } = require('./campaignHold.service');
  await maybePersistClosed(client, campaignId);
  return { ok: true, applicationId: appId, overCapacity };
}

/**
 * 한 건 제출. 리뷰어 등록/연결 → 원장 기록 → (참여형이면) 정원 차감 → 시트 큐 등록.
 * @returns {{ok:boolean, orderSubmissionId?:string, sheetRow?:number, warnings:string[], error?:string, ...}}
 */
async function submitExternalOrder({
  sheetId, tabName, gid, fields, campaignId, optionKey, adminName, allowOverCapacity = true,
}) {
  const warnings = [];
  const f = fields || {};
  const phoneDigits = digits(f.phone);
  const p8 = phoneDigits.slice(-8);

  // ① 리뷰어 등록·연결 (실패해도 주문 접수는 계속 — 카톡으로 이미 약속된 구매다)
  let reviewerInfo = { registered: false, linkedOwner: null, ownerPhone8: null, warnings: [] };
  try { reviewerInfo = await ensureExternalReviewer(f); }
  catch (e) { warnings.push('리뷰어 등록 중 오류(제출은 계속): ' + e.message); }
  warnings.push(...reviewerInfo.warnings);

  // ② 원장 기록 — 리뷰어 직접 제출과 동일 경로
  const orderData = {
    orderer: f.recipient || '', recipient: f.recipient || '', userId: f.userId || '',
    phone: f.phone || '', address: f.address || '',
    bank: f.bank || '', account: f.account || '', depositor: f.depositor || '',
    price: f.price == null ? '' : String(f.price),
    dateStr: '', orderNum: f.orderNum || '',
    memo: `외부모집 수동제출${adminName ? ' · ' + adminName : ''}`,
    selectedOptKey: optionKey || '',
  };
  const ledger = await createOrderLedgerEntry({
    sheetId, tabName, gid, orderData,
    slotRowNumber: null,
    loginPhone8: p8, loginName: f.recipient || '',
    // 신규 신청 행을 우리가 직접 만들어 확정하므로 홀드 문맥은 넘기지 않는다(이중 확정 방지)
  });

  // 출처 표시 — 목록에서 대리제출 건을 구분
  try {
    await pool.query('UPDATE order_submissions SET source = $2 WHERE id = $1', [ledger.orderSubmissionId, SOURCE_EXTERNAL]);
  } catch (_) { /* 표시 실패는 접수에 영향 없음 */ }

  // ③ 참여형이면 정원 차감
  let application = null;
  if (campaignId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await confirmExternalApplication(client, {
        campaignId, name: f.recipient || '', phone: f.phone || '', phone8: p8,
        optionKey, orderSubmissionId: ledger.orderSubmissionId, allowOverCapacity,
      });
      if (r.ok) { await client.query('COMMIT'); application = r; if (r.overCapacity) warnings.push('모집 정원을 초과해 확정했습니다'); }
      else { await client.query('ROLLBACK'); warnings.push(r.skipped ? '참여형 공고가 아니라 정원 차감은 건너뜁니다' : ('정원 반영 실패: ' + r.error)); }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      warnings.push('정원 반영 중 오류(주문은 접수됨): ' + e.message);
    } finally { client.release(); }
  }

  // ④ 시트 반영 큐 등록 (행 배정 성공 시에만 — 실패해도 reconcile 이 자가치유)
  let queued = false;
  if (ledger.sheetRow) {
    try {
      await enqueue('order_append', {
        sheetId, tabName, gid: ledger.tabGid || gid || '',
        orderData, orderSubmissionId: ledger.orderSubmissionId,
        sheetRow: ledger.sheetRow, dedupKey: ledger.dedupKey,
        loginPhone8: p8, loginName: f.recipient || '',
      });
      await markOrderQueued(ledger.orderSubmissionId);
      queued = true;
    } catch (e) {
      await markOrderMirrorFailed(ledger.orderSubmissionId, e);
      warnings.push('시트 반영 예약 실패(자동복구 대상): ' + e.message);
    }
  } else {
    warnings.push('시트 빈 행을 찾지 못해 보류 — 자동복구가 하단에 기록합니다');
  }

  logger.info(`[manual-order] 외부제출 tab=${tabName} name=${f.recipient} osid=${ledger.orderSubmissionId}`
    + (application ? ` app=${application.applicationId}` : '') + ` by=${adminName || '?'}`);

  return {
    ok: true,
    orderSubmissionId: ledger.orderSubmissionId,
    sheetRow: ledger.sheetRow || null,
    queued,
    reviewerRegistered: reviewerInfo.registered,
    linkedOwner: reviewerInfo.linkedOwner,
    applicationId: application ? application.applicationId : null,
    quotaCounted: !!application,
    warnings,
  };
}

module.exports = {
  submitExternalOrder,
  ensureExternalReviewer,
  confirmExternalApplication,
  SOURCE_EXTERNAL,
};
