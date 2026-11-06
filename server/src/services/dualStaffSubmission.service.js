'use strict';
/* 결정 349 — 네이버·쿠팡 동시진행 직원 대리 묶음 제출 · 외부모집 수동제출로 들어간 보통 주문 보완.
   리뷰어 구매양식 경로(dualPurchaseSubmission)는 리뷰어 로그인·신청·홀드·신원 승인·AI 판독 토큰에 묶여 있어
   관리자가 대신 넣을 수 없다. 이 서비스는 「직원 대리」 주체로 같은 묶음(부모 주문 1·구매처 기록 2·구매캡처 2·
   합계 금액)을 만든다. 재사용(사본 금지): cleanPurchase · identityVerdict(수취인·연락처·주소 · 아이디는 달라도 됨)
   · conditionForCampaign(현금영수증 필요) · finishBundleInTx(구매처 기록·귀속·합계·근거 해시) · dualEvidenceShaLock
   (리뷰 사진과 공용) · discoverDualScope/withDualLifecycleInTx · externalDuplicateGuard · repurchaseGuard ·
   dailyRemainingForCampaign · ensureExternalReviewer(호출만) · confirmExternalApplication · writeOrderToWorktable(동시진행 분기).
   ★ 명의는 언제나 「직원 확인 필요」(purchase_identity_result='uncertain' → 지급 판정 identity_staff_pending) —
     직원 명의 확인 창구(/api/trackb/dual-purchase/identity-review)에서 확정한다. 리뷰·영수증은 리뷰어 본인이 낸다. */
const proof = require('./dualPurchaseProof.service');
const sub = require('./dualPurchaseSubmission.service');
const CHANNELS = ['naver', 'coupang'];
const fail = (code, message, status = 409) => proof.fail(code, message || code, status);

function toAmount(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[,\s원]/g, '');
  return /^\d{1,10}$/.test(s) ? Number(s) : v;
}
function staffLabel(staff) {
  const name = String((staff && (staff.name || staff.username)) || '').trim();
  if (!name) fail('STAFF_REQUIRED', '직원 확인이 필요합니다.', 401);
  return name.slice(0, 100);
}

function createService(deps = {}) {
  const db = deps.db || require('../db/pool');
  const runtime = () => deps.runtime || require('./dualChannelRuntime.service');
  const lifecycle = () => deps.lifecycle || require('./dualChannelLifecycle.service');
  const manual = () => require('./manualOrder.service');
  const drive = deps.drive || {
    upload: async (b, mime, folder) => (await require('./drive.service').uploadFileBase64(b.toString('base64'), 'dual-staff-' + require('crypto').randomUUID(), mime, folder)).id,
    read: async id => (await require('./drive.service').downloadFile(id)).buffer,
  };
  const resolveFolder = deps.resolveFolder || (async campaignId => {
    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) fail('DUAL_DRIVE_NOT_CONFIGURED');
    return (await require('./captureFolder.service').resolveCaptureFolder({ sheetId: 'campaign:' + campaignId, tabName: 'campaign:' + campaignId, rootFolderId })).folderId;
  });
  const ensureReviewer = deps.ensureReviewer || (f => manual().ensureExternalReviewer(f));
  const confirmApplication = deps.confirmApplication || ((client, a) => manual().confirmExternalApplication(client, a));
  const applyWorktable = deps.applyWorktable || defaultApplyWorktable;

  /** 작업표/공고 → 동시진행 공고 하나. 동시진행이 아니면 거절(이 입구는 동시진행만 받는다) · 판정 실패도 막는다. */
  async function dualCampaignFor({ sheetId, tabName, gid, campaignId }) {
    const targets = [];
    if (sheetId && tabName) targets.push({ sheetId: String(sheetId), tabName: String(tabName), tabGid: String(gid || '') });
    if (campaignId != null && String(campaignId).trim()) targets.push({ campaignId: String(campaignId) });
    if (!targets.length) fail('BAD_REQUEST', 'sheetId, tabName 필수', 400);
    let scope;
    try { scope = await lifecycle().discoverDualScope(db, targets); }
    catch (_) { fail('dual_channel_manual_check_failed', '동시진행 여부를 확인하지 못해 접수하지 않았어요 — 잠시 뒤 다시 시도해 주세요.'); }
    if (!scope.campaignIds.length) fail('dual_channel_required', '이 작업은 네이버·쿠팡 동시진행이 아니에요 — 일반 수동제출로 넣어 주세요.');
    if (scope.campaignIds.length !== 1) fail('dual_campaign_ambiguous', '이 작업표에 동시진행 공고가 여러 개 연결돼 있어 접수하지 않았어요.');
    return scope.campaignIds[0];
  }
  function cleanChannels(body, fallback) {
    const purchases = {};
    for (const ch of CHANNELS) {
      const p = body[ch] || {}, fb = fallback(ch);
      const pick = k => (typeof p[k] === 'string' && p[k].trim()) ? p[k] : fb[k];
      purchases[ch] = sub.cleanPurchase({ orderNum: pick('orderNum'), userId: pick('userId'), recipient: pick('recipient'), phone: pick('phone'),
        address: pick('address'), paidAmount: toAmount(p.paidAmount != null && p.paidAmount !== '' ? p.paidAmount : fb.paidAmount) });
    }
    return purchases;
  }
  function priceFlags(body, snapshot, purchases) {
    const flags = [];
    for (const ch of CHANNELS) {
      const d = require('./capturePriceCheck.service').decideForExpected({ channel: ch, expected: snapshot.channels[ch].pay, capturePrice: '',
        typedPrice: purchases[ch].paidAmount, staffReview: body[ch]?.capturePriceStaffReview === true, ack: body[ch]?.capturePriceAck === true });
      if (d.action === 'block' || d.action === 'warn') fail(d.action === 'block' ? 'CAPTURE_PRICE_OVER' : 'CAPTURE_PRICE_DIFF', d.error);
      if (d.action === 'flag') flags.push({ channel: ch, ...d });
    }
    return flags;
  }
  async function uploadVerified(buffer, mime, folder, sha) {
    const fileId = await drive.upload(buffer, mime || 'image/jpeg', folder);
    if (!fileId || proof.sha(await drive.read(fileId)) !== sha) fail('DUAL_FILE_BYTES_CHANGED');
    return fileId;
  }
  /** 증빙 SHA 잠금 — 리뷰 사진·다른 구매캡처와 공용(같은 함수). 이미 어디에든 쓰인 사진이면 거절. */
  async function lockShas(client, shas) {
    const shaGuard = require('../utils/dualEvidenceShaLock');
    for (const sha of [...new Set(shas)].sort()) {
      await shaGuard.lockEvidenceShaInTx(client, sha);
      if ((await shaGuard.evidenceShaUsesInTx(client, sha)).length) fail('DUAL_IMAGE_REUSED', '이미 다른 구매·리뷰에 쓰인 사진입니다.');
    }
  }
  async function insertArtifact(client, { applicationId, channel, fileId, sha, purchase, snapshot, staff }) {
    const cur = (await client.query(`SELECT id FROM purchase_capture_artifacts WHERE application_id=$1 AND channel=$2 AND role='primary' AND superseded_at IS NULL AND status IN ('staged','committed') FOR UPDATE`, [applicationId, channel])).rows;
    if (cur.length) fail('DUAL_ARTIFACT_CHANGED');
    const rev = (await client.query(`SELECT COALESCE(MAX(revision),0)::int+1 AS r FROM purchase_capture_artifacts WHERE application_id=$1 AND channel=$2 AND role='primary'`, [applicationId, channel])).rows[0].r;
    const extraction = { staffProxy: { by: staff, sha }, ok: false };
    const r = await client.query(`INSERT INTO purchase_capture_artifacts
      (application_id,channel,role,revision,file_id,byte_sha256,extraction_json,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,created_by)
      VALUES($1,$2,'primary',$3,$4,$5,$6,$7,$8,$9,'staged',$10) RETURNING id`,
      [applicationId, channel, rev, fileId, sha, extraction, proof.hash(extraction), proof.hash(purchase), proof.hash(snapshot), 'staff:' + staff]);
    return r.rows[0].id;
  }
  async function ownerReviewerId(phone8) {
    if (!/^\d{8}$/.test(String(phone8 || ''))) return null;
    try {
      const r = await db.query(`SELECT id FROM reviewers WHERE phone8=$1 AND status <> 'inactive' LIMIT 2`, [phone8]);
      return r.rows.length === 1 ? r.rows[0].id : null;
    } catch (_) { return null; }
  }
  async function defaultApplyWorktable({ sheetId, tabName, gid, orderSubmissionId, phone8, name }) {
    const ledger = require('./orderLedger.service');
    let queuedTarget = false;
    try { queuedTarget = !!(await require('./workboardQueueApply.service').resolveQueuedWorkboardTarget({ sheetId, tabName })).enabled; } catch (_) { queuedTarget = false; }
    let written;
    if (queuedTarget) {
      try {
        await require('./syncQueue.service').enqueue('workboard_apply', { sheetId, tabName, tabGid: gid || '', orderSubmissionId, loginPhone8: phone8, loginName: name });
        await ledger.markOrderQueued(orderSubmissionId);
        try { require('../jobs/queuePump').kickQueuePump(); } catch (_) { /* noop */ }
        written = { ok: true, queued: true };
      } catch (e) { written = { ok: false, reason: 'queue_enqueue_failed', message: e.message }; }
    } else {
      try {
        written = await require('./sheetlessOrder.service').writeOrderToWorktable({ sheetId, tabName, tabGid: gid || '', orderData: {}, orderSubmissionId,
          loginPhone8: phone8, loginName: name, allowConfirmedCampaignOverflow: true });
      } catch (e) { written = { ok: false, reason: 'exception', message: e.message }; }
    }
    if (!written || !written.ok) {
      try { await ledger.markOrderMirrorFailed(orderSubmissionId, (written && (written.message || written.reason)) || 'dual_worktable_write_failed'); } catch (_) { /* 원장은 저장됨 */ }
    }
    return written;
  }
  function worktableNote(written, warnings) {
    if (!written || !written.ok) warnings.push('작업표 기록 실패(자동복구 대상): ' + ((written && (written.message || written.reason)) || '알 수 없음'));
    const n = Number(written && written.seq);
    return written && written.ok && Number.isFinite(n) && n > 0 ? n : null;
  }

  /** 1) 직원 대리 묶음 제출 — 동시진행 작업표에 두 구매처를 한 번에 접수한다. */
  async function submitStaffBundle(body = {}) {
    runtime().assertDualChannelReady('purchase');
    const staff = staffLabel(body.staff);
    const { sheetId, tabName, gid = '' } = body;
    const f = body.fields || {};
    const dualId = await dualCampaignFor({ sheetId, tabName, gid, campaignId: body.campaignId });
    const phoneDigits = String(f.phone || '').replace(/\D/g, '');
    if (phoneDigits.length < 10) fail('PHONE_INVALID', `전화번호 자릿수가 이상합니다 (${phoneDigits.length}자리)`, 400);
    const p8 = phoneDigits.slice(-8);
    const purchases = cleanChannels(body, () => ({ userId: f.userId, recipient: f.recipient, phone: f.phone, address: f.address }));
    for (const k of ['bank', 'account', 'depositor']) if (typeof f[k] !== 'string' || !f[k].trim()) fail('DUAL_ACCOUNT_REQUIRED', '은행·계좌·예금주가 필요합니다.', 400);
    const typedVerdict = sub.identityVerdict(purchases.naver, purchases.coupang);
    const images = {};
    for (const ch of CHANNELS) {
      if (!body[ch]?.imageBase64) fail('DUAL_TWO_CAPTURES_REQUIRED', '네이버·쿠팡 구매캡처 두 장이 모두 필요합니다.', 400);
      const buffer = proof.bytes(body[ch].imageBase64);
      images[ch] = { buffer, sha: proof.sha(buffer), mime: body[ch].mimeType };
    }
    if (images.naver.sha === images.coupang.sha) fail('DUAL_IMAGE_REUSED', '두 구매처에 같은 사진을 올렸습니다.');
    const warnings = [];
    // 중복·재참여·일 정원 — 외부모집 수동제출과 같은 판정(재사용).
    if (!body.force) {
      for (const ch of CHANNELS) {
        const dup = await manual().externalDuplicateGuard(db, { sheetId, tabName, gid, campaignId: dualId, phone: f.phone, orderNum: purchases[ch].orderNum, warnings });
        if (dup) return dup;
      }
      const onums = CHANNELS.map(ch => purchases[ch].orderNum.replace(/\D/g, '')).filter(n => n.length >= 6);
      if (onums.length) {
        const same = await db.query(`SELECT 1 FROM order_purchase_channels c JOIN order_submissions os ON os.id=c.order_submission_id
          WHERE os.deleted_at IS NULL AND regexp_replace(COALESCE(c.order_num,''),'[^0-9]','','g') = ANY($1::text[])
            AND RIGHT(regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g'),8)=$2 LIMIT 1`, [onums, p8]);
        if (same.rows.length) return { ok: false, duplicate: true, sameOrderNum: true, error: '같은 주문번호·연락처로 이미 접수된 동시진행 구매가 있습니다' };
      }
    }
    if (body.allowRepurchase !== true) {
      try {
        const { checkRepurchaseWindow, resolveCampaignRepurchaseDays } = require('../utils/repurchaseGuard');
        const rw = await checkRepurchaseWindow(db, { sheetId, tabName, campaignId: dualId, phone: f.phone, days: await resolveCampaignRepurchaseDays(db, dualId) });
        if (rw.blocked) return { ok: false, repurchaseBlocked: true, days: rw.days, availableFrom: rw.availableFrom,
          error: `이 작업은 최근 ${rw.days}일 안에 같은 연락처로 이미 참여한 이력이 있습니다. 다른 사람인데 번호만 같다면 확인 후 강제로 등록할 수 있습니다.` };
      } catch (e) { warnings.push('재참여 기간 확인 실패(제출은 계속): ' + e.message); }
    } else warnings.push('재참여 기간 제한을 넘겨 접수했습니다(관리자 확인됨)');
    if (body.allowOverDaily !== true) {
      const dq = await manual().dailyRemainingForCampaign(db, dualId);
      if (dq && dq.remaining <= 0) return { ok: false, overDaily: true, quota: dq,
        error: `오늘 모집인원(${dq.quota}명)이 이미 찼습니다 — 현재 ${dq.todayCount}명. 이미 구매가 끝난 건이므로 초과로 기록하려면 확인이 필요합니다` };
    }
    const snapshot = await sub.conditionForCampaign(db, dualId);
    const captureFlags = priceFlags(body, snapshot, purchases);
    const price = purchases.naver.paidAmount + purchases.coupang.paidAmount;
    if (!Number.isSafeInteger(price) || price > 2147483647) fail('DUAL_AMOUNT_INVALID');
    const hash = proof.hash({ kind: 'staff_bundle_v1', campaignId: dualId, sheetId, tabName, purchases, captureShas: { naver: images.naver.sha, coupang: images.coupang.sha },
      bank: f.bank, account: f.account, depositor: f.depositor, captureFlags });
    // 리뷰어 등록·연결 — 기존 함수 그대로(호출만). 실패해도 접수는 계속(수동제출과 같은 계약).
    let reviewerInfo = { registered: false, ownerPhone8: null, warnings: [] };
    try { reviewerInfo = await ensureReviewer(f); } catch (e) { warnings.push('리뷰어 등록 중 오류(제출은 계속): ' + e.message); }
    warnings.push(...(reviewerInfo.warnings || []));
    const ownerId = await ownerReviewerId(reviewerInfo.ownerPhone8 || p8);
    if (!ownerId) warnings.push('리뷰어 계정을 하나로 찾지 못했습니다 — 리뷰어가 리뷰를 내려면 담당자 연결이 필요합니다');
    // Drive 는 트랜잭션 밖(리뷰어 경로와 같은 순서). 모르는 COMMIT 결과에서도 파일을 지우지 않는다.
    const folder = await resolveFolder(dualId);
    const files = {};
    for (const ch of CHANNELS) files[ch] = await uploadVerified(images[ch].buffer, images[ch].mime, folder, images[ch].sha);
    const out = await lifecycle().withDualLifecycleInTx({ db, targets: [{ campaignId: dualId }], run: async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dual-staff-bundle:' + hash]);
      const prior = (await client.query('SELECT id FROM order_submissions WHERE purchase_bundle_hash=$1 AND deleted_at IS NULL', [hash])).rows[0];
      if (prior) return { orderSubmissionId: prior.id, idempotent: true };
      if (proof.hash(await sub.conditionForCampaign(client, dualId)) !== proof.hash(snapshot)) fail('DUAL_ARTIFACT_CHANGED');
      await lockShas(client, [images.naver.sha, images.coupang.sha]);
      const app = await confirmApplication(client, { campaignId: dualId, name: f.recipient || '', phone: f.phone || '', phone8: p8, optionKey: null,
        orderSubmissionId: null, allowOverCapacity: true, targetApplicationId: body.targetApplicationId, sheetId, gid, tabName });
      if (!app || !app.ok || !app.applicationId) fail('dual_application_failed', (app && app.error) || '참여 신청을 확정하지 못해 접수하지 않았어요.');
      const n = purchases.naver;
      const ins = await client.query(`INSERT INTO order_submissions
        (sheet_id,tab_name,gid,tab_gid,orderer,recipient,user_id,phone,address,order_num,bank,account,depositor,price,source,dedup_key,mirror_status,
         owner_reviewer_id,purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_identity_review,purchase_bundle_revision)
        VALUES($1,$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,'pending',$14,1,$15,$16,$17,'uncertain',$18,1) RETURNING id`,
        [sheetId, tabName, gid || '', f.recipient || n.recipient, n.userId, f.phone, n.address, n.orderNum, f.bank, f.account, f.depositor, String(price),
          manual().SOURCE_EXTERNAL, ownerId, app.applicationId, hash, snapshot, { status: 'pending', staffProxy: { by: staff, typedVerdict } }]);
      const orderSubmissionId = ins.rows[0].id;
      await client.query('UPDATE order_submissions SET capture_flags=$2,date_str=$3,dedup_key=$4 WHERE id=$1',
        [orderSubmissionId, captureFlags.length ? { flags: captureFlags } : null, manual().todayKstDateStr(), 'osid:' + orderSubmissionId]);
      await client.query('UPDATE campaign_applications SET order_submission_id=$2 WHERE id=$1', [app.applicationId, orderSubmissionId]);
      const artifactIds = [];
      for (const ch of CHANNELS) artifactIds.push(await insertArtifact(client, { applicationId: app.applicationId, channel: ch, fileId: files[ch], sha: images[ch].sha, purchase: purchases[ch], snapshot, staff }));
      await sub.finishBundleInTx(client, { orderSubmissionId, purchases, verdict: 'uncertain', artifactIds, price });
      return { orderSubmissionId, applicationId: app.applicationId, overCapacity: !!app.overCapacity };
    } });
    if (out.overCapacity) warnings.push('총 모집 정원을 넘겨 기록했습니다');
    const written = out.idempotent ? null : await applyWorktable({ sheetId, tabName, gid, orderSubmissionId: out.orderSubmissionId, phone8: p8, name: f.recipient || '' });
    return { ok: true, orderSubmissionId: out.orderSubmissionId, applicationId: out.applicationId || null, idempotent: !!out.idempotent,
      identity: 'staff_pending', price, worktableRow: out.idempotent ? null : worktableNote(written, warnings), reviewerRegistered: !!reviewerInfo.registered, warnings };
  }

  return { submitStaffBundle };
}
let production;
const get = () => production || (production = createService());
module.exports = { createService, submitStaffBundle: b => get().submitStaffBundle(b) };
