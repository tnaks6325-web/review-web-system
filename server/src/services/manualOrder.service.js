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

/** 외부 대리제출 건의 출처 표시.
 *  ★ diag의 `order-manual-add`가 `order_submissions.source='manual'`을 쓰므로 그 값과 겹치면
 *    두 경로를 목록·집계에서 구분할 수 없다(별도 값으로 둔다). */
const SOURCE_EXTERNAL = 'admin_external';

const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const KST_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 시트 구매일자 칸에 넣을 오늘(KST) 표기 — 리뷰어 제출과 **같은 형식** `M / D (요일)`
 * (`search-app.js`가 보내는 값, 063 일정 파서가 읽는 값).
 *
 * ★★ 빈 문자열을 보내면 안 된다. `mapOrderToSheetRow`는 날짜·옵션 칸에 `''`를 반환하고
 *   `buildBatchUpdateData`는 `null`만 걸러내므로, 빈 값은 **그 칸을 지우는 쓰기**가 된다.
 *   로스터 행에는 구매일자가 미리 적혀 있고 063이 "그 날짜 칸의 값 개수"로 그날 정원을
 *   파생하므로, 한 건 제출할 때마다 그날 계획 물량이 1 줄어드는 이중 차감이 일어난다.
 */
function todayKstDateStr(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return `${k.getUTCMonth() + 1} / ${k.getUTCDate()} (${KST_DAYS[k.getUTCDay()]})`;
}

// 옵션 칸 인덱스·기존값 되쓰기는 **원장(orderLedger)이 단일 출처**다.
//   사본을 두면 "리뷰어 제출은 보존하는데 수동제출은 지운다" 같은 드리프트가 난다.
const { optionColIndexes, existingOptionKeyAt } = require('./orderLedger.service');

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
    // ★ 사칭 차단(063과 같은 규율): 이미 리뷰어로 등록된 번호는 남의 타계정으로 붙이지 않는다.
    //   sub_accounts 는 소유 증명이 없는 자기신고 배열이고, 여기서 소유자는 **붙여넣은 이름**만으로
    //   찾는다 — 카톡 양식의 이름 한 번 겹치면 실존 리뷰어의 신원이 남의 계정에 매달린다.
    const policy = String(process.env.CAMPAIGN_SUB_REGISTERED_POLICY || 'block').toLowerCase();
    let registeredElsewhere = false;
    if (policy !== 'allow') {
      try {
        const { rows: ex } = await db.query(
          `SELECT 1 FROM reviewers WHERE phone8 = $1 AND status <> 'inactive' LIMIT 1`, [p8]);
        registeredElsewhere = ex.length > 0;
      } catch (_) { /* 조회 실패는 기존 동작(연결 진행) */ }
    }
    if (registeredElsewhere && policy === 'block') {
      warnings.push(`'${f.recipient}'(***${p8.slice(-4)})은 이미 등록된 리뷰어라 '${owner.name}'의 타계정으로 연결하지 않았습니다`);
      return { registered: true, linkedOwner: null, ownerPhone8: null, warnings };
    }
    if (registeredElsewhere) warnings.push(`'${f.recipient}'은 이미 등록된 리뷰어입니다 — 타계정 연결을 확인하세요`);
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
 * 오늘 남은 자리 — "일 정원(daily quota) 대비 몇 명 더 받을 수 있나".
 *
 * ★★ **판정 사본 금지** — 정원은 `computeCampaignState` 하나가 정한다(리뷰어 apply 게이트·카드
 *    게이지·[📅 인원] 이 보는 그 값). 여기서 `daily_limit` 을 직접 세면 066 이월·095 날짜별 조절·
 *    098 이월 보류·총량 clamp 를 모르는 두 번째 기준이 생겨 "화면은 15인데 서버는 20"으로 갈린다.
 *
 * ★ **모르면 막지 않는다(fail-soft)** — 조회 실패·판정 불가·무제한(quota<=0)은 `null` 을 돌려주고
 *   호출부는 종전대로 통과시킨다. 외부모집은 이미 약속된 구매라, 우리 오류로 접수를 막는 쪽이 나쁘다.
 *
 * @returns {Promise<{remaining:number, quota:number, todayCount:number}|null>}
 */
async function dailyRemainingForCampaign(db, campaignId, now = new Date()) {
  if (!campaignId) return null;
  try {
    const { rows } = await db.query('SELECT * FROM recruit_campaigns WHERE id = $1', [campaignId]);
    if (!rows.length || rows[0].participation_mode !== true) return null;
    const camp = rows[0];
    const { fetchCampaignCounts, computeCampaignState } = require('./campaignState.service');
    const { deriveSchedules, tabsOfCampaigns, scheduleFor } = require('./campaignSchedule.service');
    const counts = await fetchCampaignCounts(db, [campaignId], now);
    const sch = await deriveSchedules(db, tabsOfCampaigns([camp]), now);
    const st = computeCampaignState(camp, counts.get(campaignId), now, scheduleFor(sch, camp));
    const quota = Number(st.dailyQuota) || 0;
    if (quota <= 0) return null;                      // 무제한·정원 개념 없음 = 판정하지 않는다
    const todayCount = Number(st.todayCount) || 0;
    return { remaining: Math.max(0, quota - todayCount), quota, todayCount };
  } catch (e) {
    logger.warn(`[manual-order] 일 정원 판정 실패(통과 처리) camp=${campaignId}: ${e.message}`);
    return null;
  }
}

/**
 * 참여형 캠페인 신청 행 생성 → 즉시 확정(submitted). 정원 차감의 유일한 수단
 * (정원 = campaign_applications.status='submitted' 행 수).
 * 잠금 계층 준수: recruit_campaigns FOR UPDATE → 신청 행.
 * @returns {{ok:boolean, applicationId?:number, skipped?:string, error?:string}}
 */
async function confirmExternalApplication(client, {
  campaignId, name, phone, phone8, optionKey, orderSubmissionId, allowOverCapacity, targetApplicationId,
  sheetId, gid, tabName,
}) {
  const { rows: cRows } = await client.query(
    `SELECT id, participation_mode, is_popular, recruit_total, linked_sheet_id, linked_tab_gid, linked_tab_name
       FROM recruit_campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
  if (!cRows.length) return { ok: false, error: '캠페인을 찾을 수 없습니다' };
  if (!cRows[0].participation_mode) return { ok: false, skipped: 'not_participation' };

  // ★ 공고↔탭 결속 검증 — 리뷰어 홀드 확정과 같은 판정(tabMatchesCampaign).
  //   campaignId·sheetId·tabName이 각각 독립 입력이라, 화면이 낡았거나 문맥이 어긋나면
  //   "A 탭에 기록하면서 B 공고의 정원을 깎는" 일이 생긴다. 행은 이미 잠갔으니 비용 0.
  if (sheetId) {
    const { tabMatchesCampaign } = require('./campaignHold.service');
    if (!tabMatchesCampaign(cRows[0], sheetId, gid || '', tabName || '')) {
      return { ok: false, error: '이 공고에 연결된 작업 탭이 아니어서 정원을 반영하지 않았습니다' };
    }
  }

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

  let appId;
  const selectedId = parseInt(targetApplicationId, 10);
  if (selectedId) {
    const { rows: selected } = await client.query(
      `SELECT id, status FROM campaign_applications
        WHERE id = $1 AND campaign_id = $2 AND phone8 = $3 FOR UPDATE`,
      [selectedId, campaignId, phone8]);
    if (!selected.length) return { ok: false, reason: 'application_target_invalid', error: '선택한 참여 신청을 찾을 수 없거나 연락처가 일치하지 않습니다' };
    if (!['applied', 'expired', 'cancelled'].includes(selected[0].status)) {
      return { ok: false, reason: 'application_target_invalid', error: '선택한 참여 신청은 확정할 수 있는 상태가 아닙니다' };
    }
    appId = selected[0].id;
    await client.query(
      `UPDATE campaign_applications
          SET status = 'submitted', submitted_at = NOW(), order_submission_id = $2, option_key = COALESCE($3, option_key)
        WHERE id = $1`, [appId, orderSubmissionId, optionKey || null]);
  } else {
    const { rows: candidates } = await client.query(
      `SELECT id FROM campaign_applications
        WHERE campaign_id = $1 AND phone8 = $2
          AND status IN ('applied', 'expired', 'cancelled')
        ORDER BY applied_at DESC LIMIT 2 FOR UPDATE`, [campaignId, phone8]);
    if (candidates.length) {
      return { ok: false, reason: 'application_selection_required',
        error: '기존 참여 신청이 있어 자동 확정하지 않았습니다. 해당 신청을 선택해 다시 제출해주세요' };
    }
    const ins = await client.query(
      `INSERT INTO campaign_applications
         (campaign_id, applicant_name, applicant_phone, phone8, status, applied_at, submitted_at, order_submission_id, option_key, is_popular_snapshot)
       VALUES ($1,$2,$3,$4,'submitted',NOW(),NOW(),$5,$6,$7)
       RETURNING id`,
      [campaignId, name, phone, phone8, orderSubmissionId, optionKey || null, cRows[0].is_popular === true]);
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
  sheetId, tabName, gid, fields, campaignId, optionKey, targetApplicationId, adminName, allowOverCapacity = true, force = false,
  allowOverDaily = false, allowRepurchase = false,
}) {
  const warnings = [];
  const f = fields || {};
  const phoneDigits = digits(f.phone);
  const p8 = phoneDigits.slice(-8);
  if (phoneDigits.length < 10) {
    // phone8이 8자리 미만이면 검색·행배정·정원 키가 전부 어긋난다 → 접수 자체를 거부
    return { ok: false, error: `전화번호 자릿수가 이상합니다 (${phoneDigits.length}자리)` };
  }

  // ⓪ 중복 접수 방지 — 재붙여넣기는 **예상되는 복구 동작**이다(결과 화면이 그렇게 안내하고,
  //    배치가 끊기면 무엇이 들어갔는지 모른다). 주문번호가 없는 건이 대부분이라 dedupKey가
  //    `osid:<uuid>` 폴백으로 매번 새 값이 되어 원장 자체로는 중복을 못 막는다.
  if (!force) {
    try {
      const { rows: dupRows } = await pool.query(
        `SELECT id, submitted_at FROM order_submissions
          WHERE sheet_id = $1 AND tab_name = $2 AND phone = $3
            AND deleted_at IS NULL AND submitted_at > NOW() - interval '24 hours'
          ORDER BY submitted_at DESC LIMIT 1`,
        [sheetId, tabName, f.phone || '']);
      if (dupRows.length) {
        return {
          ok: false, duplicate: true,
          error: `같은 연락처의 주문이 24시간 내에 이미 접수돼 있습니다 (제출 ${new Date(dupRows[0].submitted_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})`,
        };
      }
    } catch (e) { warnings.push('중복 확인 실패(제출은 계속): ' + e.message); }
  }

  // ⓪-1.5 재참여(재구매) 기간 제한 — **"같은 작업(탭)" 기준**(사용자 확정 2026-08-24). 위 24시간
  //     중복 체크는 사고 방지용이고, campaignId 별 영구 차단(⓪-2)은 그 캠페인 안에서만 본다.
  //     이번에 문제된 사고(8/20 참여 → 4일 뒤 이 화면으로 같은 탭 재구매)는 캠페인 지정 없이
  //     등록될 때 ⓪-2가 통째로 비활성화되면서 통과됐다 — 그래서 여기서는 campaignId 유무와
  //     무관하게 항상 본다. 단일 출처 = utils/repurchaseGuard(리뷰어 셀프 참여와 공용).
  //     ★ 여기만 유일하게 확인 후 강제 통과(allowRepurchase)를 허용한다(관리자가 "다른 사람인데
  //     번호만 같다" 같은 사정을 판단해 넘길 수 있게 — 사용자 확정, 리뷰어 셀프 참여는 예외 없음).
  if (!allowRepurchase) {
    try {
      const { checkRepurchaseWindow } = require('../utils/repurchaseGuard');
      const rw = await checkRepurchaseWindow(pool, { sheetId, tabName, phone: f.phone });
      if (rw.blocked) {
        const dateStr = rw.availableFrom.toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short',
        });
        return {
          ok: false, repurchaseBlocked: true, days: rw.days, availableFrom: rw.availableFrom,
          error: `이 작업은 최근 ${rw.days}일 안에 같은 연락처로 이미 참여한 이력이 있습니다 — ${dateStr} 이후 다시 가능합니다. 다른 사람인데 번호만 같다면 확인 후 강제로 등록할 수 있습니다.`,
        };
      }
    } catch (e) { warnings.push('재참여 기간 확인 실패(제출은 계속): ' + e.message); }
  } else {
    warnings.push('재참여 기간 제한을 넘겨 접수했습니다(관리자 확인됨)');
  }

  // ⓪-2 참여형이면 **원장 기록 전에** 확정 가능 여부를 본다 — 나중에 거절되면
  //     시트 행만 생기고 정원은 안 깎이는 어긋난 상태가 남는다.
  let selectedApplication = null;
  if (campaignId) {
    try {
      const { rows: pre } = await pool.query(
        `SELECT id FROM campaign_applications
          WHERE campaign_id = $1 AND phone8 = $2 AND status = 'submitted' LIMIT 1`, [campaignId, p8]);
      if (pre.length) {
        return { ok: false, duplicate: true, error: `이 공고에 이미 확정된 참여(#${pre[0].id})가 있습니다` };
      }
      const selectedId = parseInt(targetApplicationId, 10);
      if (selectedId) {
        const { rows: selected } = await pool.query(
          `SELECT id, status, option_key FROM campaign_applications
            WHERE id = $1 AND campaign_id = $2 AND phone8 = $3`, [selectedId, campaignId, p8]);
        if (!selected.length || !['applied', 'expired', 'cancelled'].includes(selected[0].status)) {
          return { ok: false, reason: 'application_target_invalid', error: '선택한 참여 신청을 찾을 수 없거나 확정할 수 없는 상태입니다' };
        }
        selectedApplication = selected[0];
      } else {
        const { rows: existing } = await pool.query(
          `SELECT id FROM campaign_applications
            WHERE campaign_id = $1 AND phone8 = $2
              AND status IN ('applied', 'expired', 'cancelled') LIMIT 1`, [campaignId, p8]);
        if (existing.length) {
          return { ok: false, reason: 'application_selection_required',
            error: '기존 참여 신청이 있습니다. 확정할 신청을 선택해주세요' };
        }
      }
    } catch (e) { warnings.push('참여 이력 확인 실패(제출은 계속): ' + e.message); }
  }

  // ⓪-3 일 정원(오늘 몫) 게이트 — **원장 기록 전에** 본다(⓪-2 와 같은 이유: 뒤에서 거절하면
  //     시트 행만 생기고 정원은 안 깎이는 어긋난 상태가 남는다).
  //   ★★ **막지 않는다 — 확인만 받는다**(사용자 확정 2026-08-19 "나"안): 외부모집은 **이미 구매가
  //     끝난 건의 사후 등록**이라, 막으면 되돌릴 수 없는 구매가 시스템에 기록되지 않은 채 남는다
  //     (초과를 막는 것보다 기록이 비는 쪽이 훨씬 나쁘다). 확인은 '허가'가 아니라 '고지'다. 대신 `allowOverDaily` 없이 오면 초과 사실과 숫자를
  //     돌려주고, 담당자가 확인창에서 승인해 재전송하면 그대로 접수한다.
  //   ★ 종전에는 총 정원(`recruit_total`)만 봤고 일 정원은 **아예 보지 않아**, 오늘 몫이 찬 뒤에도
  //     아무 신호 없이 들어갔다(2026-08-19 실측: 정원 15인 두 공고에 각 +2, 확정 17).
  if (campaignId && !allowOverDaily) {
    const dq = await dailyRemainingForCampaign(pool, campaignId);
    if (dq && dq.remaining <= 0) {
      return {
        ok: false, overDaily: true, quota: dq,
        error: `오늘 모집인원(${dq.quota}명)이 이미 찼습니다 — 현재 ${dq.todayCount}명. 이미 구매가 끝난 건이므로 초과로 기록하려면 확인이 필요합니다`,
      };
    }
  }

  // ①-0 옵션 확정 — 화면 값 → 살아있는 홀드 → 공고에 옵션이 하나뿐이면 그것.
  //   (셋 다 아니면 배정 행의 기존 값을 되쓴다 — 아래 ② 뒤에서 처리)
  let resolvedOptKey = String(optionKey || '').trim();
  if (!resolvedOptKey && selectedApplication && selectedApplication.option_key) resolvedOptKey = selectedApplication.option_key;
  if (!resolvedOptKey && campaignId) {
    try {
      const { rows: h } = await pool.query(
        `SELECT option_key FROM campaign_applications
          WHERE campaign_id = $1 AND phone8 = $2 AND status = 'applied' AND expires_at > NOW()
          ORDER BY applied_at DESC LIMIT 1`, [campaignId, p8]);
      if (h.length && h[0].option_key) resolvedOptKey = h[0].option_key;
      if (!resolvedOptKey) {
        const { rows: o } = await pool.query(
          `SELECT opt_key FROM campaign_options WHERE campaign_id = $1 AND status = 'active'`, [campaignId]);
        if (o.length === 1) resolvedOptKey = o[0].opt_key;
        else if (o.length > 1) warnings.push(`옵션이 ${o.length}종이라 자동 선택하지 않았습니다 — 시트의 기존 옵션값을 유지합니다`);
      }
    } catch (e) { warnings.push('옵션 확인 실패(제출은 계속): ' + e.message); }
  }
  // ★★ 134 복합 작업: 고른 단위가 "옵션 없는 상품"이면 그 키는 상품명이라 시트 옵션 칸에 쓰지 않는다
  //   (리뷰어 제출 경로 submit.routes 와 같은 규율 — 8/3 상품명이 리뷰옵션 칸을 덮은 사고 재현 방지).
  //   빈 값 = "안 고름" = 배정 행의 기존 옵션값을 되쓴다(칸을 지우지 않는다).
  //   ★ 조회 실패는 종전 동작(그대로 사용) — fail-open.
  /* ★ 138 선택 상품 — 옵션 칸을 비우는 위 규율은 그대로 두고, 그 상품명을 **별개의 「상품」 칸**으로
     흘려보낸다(리뷰어 제출 경로와 같은 규율). 같은 왕복에서 읽으므로 쿼리 순증 0. */
  let resolvedProduct = '';
  if (resolvedOptKey && campaignId) {
    try {
      const { rows: u } = await pool.query(
        `SELECT unit_kind, product_name FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2 LIMIT 1`,
        [campaignId, resolvedOptKey]);
      if (u.length) {
        resolvedProduct = String(u[0].product_name || '');
        if (String(u[0].unit_kind || '') === 'product') resolvedOptKey = '';
      }
    } catch (_) { /* fail-open: 종전 동작 */ }
  }

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
    // ★ 빈 값 금지 — 매퍼가 날짜 칸에 ''를 쓰면 로스터의 구매일자가 지워진다(위 주석 참조)
    dateStr: todayKstDateStr(), orderNum: f.orderNum || '',
    memo: `외부모집 수동제출${adminName ? ' · ' + adminName : ''}`,
    selectedOptKey: resolvedOptKey || '',
    selectedProduct: resolvedProduct || '',   // ★ 138 — 고른 상품은 「상품」 칸으로(옵션 칸과 별개)
  };
  const ledger = await createOrderLedgerEntry({
    sheetId, tabName, gid, orderData,
    slotRowNumber: null,
    loginPhone8: p8, loginName: f.recipient || '',
    // 신규 신청 행을 우리가 직접 만들어 확정하므로 홀드 문맥은 넘기지 않는다(이중 확정 방지)
  });

  // ★ C′: 옵션 칸 보호는 쓰기 시점(syncQueue blank-only 필터)이 담당한다. 시트에 적힌 값을
  //   원장(selected_opt_key)이나 신청(option_key)으로 역주입하지 않는다 —
  //   관리자 작업지시값이 "리뷰어가 고른 옵션"으로 굳어 정원·CS·정산이 오독한다.
  //   (역주입은 리뷰어 제출 경로와도 갈려 "수동제출만 다르게 동작"하는 드리프트를 만든다.)

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
        optionKey: resolvedOptKey, orderSubmissionId: ledger.orderSubmissionId, allowOverCapacity,
        targetApplicationId,
        sheetId, gid: ledger.tabGid || gid || '', tabName,
      });
      if (r.ok) { await client.query('COMMIT'); application = r; if (r.overCapacity) warnings.push('모집 정원을 초과해 확정했습니다'); }
      else { await client.query('ROLLBACK'); warnings.push(r.skipped ? '참여형 공고가 아니라 정원 차감은 건너뜁니다' : ('정원 반영 실패: ' + r.error)); }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      warnings.push('정원 반영 중 오류(주문은 접수됨): ' + e.message);
    } finally { client.release(); }
  }

  // ④ 반영 — 무시트 탭은 작업표에 바로 기록(큐 미경유), 그 외는 종전대로 시트 반영 큐
  //   ★ 판정은 `sheetlessScope` 단일 출처. 실패 시 종전 경로(fail-open) — 큐 실행부가 최종 방어.
  let queued = false;
  let sheetlessDone = null;
  let isSl = false;
  try { isSl = await require('../utils/sheetlessScope').isSheetless(require('../db/pool'), sheetId, tabName); } catch (_) { isSl = false; }
  if (isSl) {
    /* 외부모집은 원장 출처가 admin_external이고 수취인·연락처가 확정된 경우에만 작업표 서비스가
       정원 밖의 완성 행을 허용한다. 그래서 sheetRow가 없어도 호출해야 하며, 일반 경로에는 이
       서비스가 호출되지 않는다. */
    try {
      sheetlessDone = await require('./sheetlessOrder.service').writeOrderToWorktable({
        sheetId, tabName, tabGid: ledger.tabGid || gid || '',
        sheetRow: ledger.sheetRow, orderData, orderSubmissionId: ledger.orderSubmissionId,
        loginPhone8: p8, loginName: f.recipient || '',
      });
    } catch (e) { sheetlessDone = { ok: false, reason: 'exception', message: e.message }; }
    if (!sheetlessDone.ok) warnings.push('작업표 기록 실패(자동복구 대상): ' + (sheetlessDone.message || sheetlessDone.reason));
  }
  if (ledger.sheetRow && !sheetlessDone) {
    try {
      await enqueue('order_append', {
        sheetId, tabName, gid: ledger.tabGid || gid || '',
        orderData, orderSubmissionId: ledger.orderSubmissionId,
        sheetRow: ledger.sheetRow, dedupKey: ledger.dedupKey,
        loginPhone8: p8, loginName: f.recipient || '',
      });
      await markOrderQueued(ledger.orderSubmissionId);
      queued = true;
      // 리뷰어 제출과 같은 kick — 없으면 cron까지 시트에 안 뜨고 현황 위젯도 반응하지 않는다
      try {
        if (process.env.ORDER_BATCH_AUTO === '1') require('../jobs/orderBatchScheduler').kickOrderBatch(sheetId, tabName);
        else require('../jobs/queuePump').kickQueuePump();
      } catch (e2) { logger.warn(`[manual-order] kick 실패(무시, cron 백스톱): ${e2.message}`); }
    } catch (e) {
      await markOrderMirrorFailed(ledger.orderSubmissionId, e);
      warnings.push('시트 반영 예약 실패(자동복구 대상): ' + e.message);
    }
  } else if (!ledger.sheetRow && !sheetlessDone) {
    warnings.push('빈 행을 찾지 못해 보류 — 자동복구가 하단에 기록합니다');
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
  dailyRemainingForCampaign,
  ensureExternalReviewer,
  confirmExternalApplication,
  todayKstDateStr,
  existingOptionKeyAt,
  SOURCE_EXTERNAL,
};
