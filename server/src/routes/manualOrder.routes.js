/**
 * 외부모집 구매양식 관리자 수동제출 라우트 — 전부 admin/master 전용.
 *
 * ★ 무인증인 `/api/submit/order` 를 재사용하지 않는 이유: 그 경로는 loginPhone8 이 없으면
 *   신원게이트 전체를 건너뛰도록 설계돼 있다(레거시 호환). 관리자 기능의 정식 문을 그 우회로에
 *   두면 무인증 표면이 그대로 노출된다 → 별도 인증 라우트 + 서비스 재사용.
 */
const express = require('express');
const router = express.Router();
// Track B(trackB.routes.js)가 경로 문자열 대신 이름으로 부르는 핸들러 모음 — 맨 아래 router.handlers 로 내보낸다(결정 270).
const { lastRouteHandler } = require('../utils/routeHandlers');
const _handlers = {};

const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { parseSlashForm } = require('../utils/slashForm');
const { submitExternalOrder, dailyRemainingForCampaign, tabOptionChoices, manualDualBlock, searchReviewersForLink } = require('../services/manualOrder.service');
const { checkRepurchaseWindowBatch, phone8Of, resolveCampaignRepurchaseDays } = require('../utils/repurchaseGuard');
const { logger } = require('../utils/logger');
const { emitOrderSubmit } = require('../utils/sse');

const MAX_LINES = 50;   // 한 번에 처리할 최대 건수(오붙여넣기로 수백 건이 들어가는 사고 방지)

// ── 파싱 미리보기 (읽기 전용) ────────────────────────────────
// 제출 전에 9칸 분해 결과를 사람이 확인·수정하게 한다. DB 접근 없음.
const AI_REPAIR_MAX = parseInt(process.env.SLASHFORM_AI_REPAIR_MAX || '10', 10);   // 한 요청당 AI 호출 상한

router.post('/preview', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  // ★ 결정 344 — 동시진행 작업표·공고는 미리보기 단계에서 바로 알린다(분해·AI 보정 전 · 판정 실패도 거절 = fail-closed).
  //   화면은 `error` 를 그대로 alert 한다('분해 실패: …').
  // ★ 결정 349 화면(2026-11-07) — 새 화면(dualAware:true)은 동시진행 작업표에서도 양식 나누기만 받는다(dual:true 를 실어 돌려준다).
  //   접수는 /dual/submit 으로만(아래 /submit 의 거절은 그대로 · 결정 344 완화 금지). 옛 화면(dualAware 없음)은 종전처럼 409,
  //   판정 실패(dual_channel_manual_check_failed)는 dualAware 여도 409(fail-closed).
  let dualMode = false;
  { const pb = req.body || {};
    const blocked = await manualDualBlock(pool, { sheetId: pb.sheetId, tabName: pb.tabName, gid: pb.gid, campaignId: pb.campaignId });
    if (blocked) {
      if (pb.dualAware === true && blocked.code === require('../utils/dualPhase1').DUAL_MANUAL_UNSUPPORTED) dualMode = true;
      else return res.status(409).json(blocked);
    } }
  const text = String((req.body && req.body.text) || '');
  const all = parseSlashForm(text);
  const items = all.slice(0, MAX_LINES);

  // ── AI 보정 폴백 ────────────────────────────────────────────
  // 규칙 보정(utils/slashForm.js)이 이미 대부분의 "슬래시 한 칸 누락"을 잡는다.
  // 여기 오는 건 순서가 뒤섞였거나·라벨이 붙었거나·목록에 없는 은행명 같은 나머지다.
  // ★ fail-open: AI 미설정·오류·저확신은 **원래 오류 메시지 그대로** 둔다(값을 지어내지 않는다).
  // ★ 호출 상한 — 잘못 붙여넣은 50줄이 통째로 AI로 가지 않게.
  if (String(process.env.SLASHFORM_AI_REPAIR || '1') !== '0') {
    const targets = items.filter(i => !i.ok && /칸이 \d+개뿐/.test(i.errors[0] || '')).slice(0, AI_REPAIR_MAX);
    if (targets.length) {
      const { repairSlashFormLine } = require('../services/gemini.service');
      const { parseSlashLine, FIELD_LABELS } = require('../utils/slashForm');
      await Promise.all(targets.map(async (it) => {
        try {
          const f = await repairSlashFormLine(it.raw);
          if (!f) return;
          // AI 결과를 **정규 경로로 재검증**한다 — 9칸을 다시 조립해 같은 파서에 통과시킨다.
          //   (AI 출력이 파서를 우회해 그대로 접수되는 일이 없게)
          const rebuilt = [f.reviewerName, f.recipient, f.userId, f.phone, f.address,
            f.bank, f.account, f.depositor, f.price].map(v => String(v || '').replace(/\//g, ' ')).join('/');
          const re = parseSlashLine(rebuilt, { noShape: true });   // AI 결과는 표준 순서로만 재검증(생김새 자리 찾기로 덮지 않는다)
          if (!re.ok) {
            it.errors = it.errors.concat([`AI 보정도 실패: ${re.errors[0]}`]);
            return;
          }
          Object.assign(it, re, {
            raw: it.raw,                       // 원문은 보존(사람이 대조)
            aiRepaired: true,
            warnings: (re.warnings || []).concat([
              'AI가 항목을 나눴습니다 — 값이 맞는지 반드시 확인하세요'
              + (f.confident ? '' : ' (확신이 낮습니다)'),
            ]),
          });
        } catch (_) { /* fail-open — 원래 오류 유지 */ }
      }));
    }
  }

  // ★ 결정 211: 작업보드 경로(공고 없이 탭 단위)면 그 탭에 연결된 공고의 상품(선택지) 목록을 함께 싣는다.
  //   공고 화면 경로(campaignId 있음)는 종전대로(신청 선택이 옵션을 정한다).
  const b = req.body || {};
  //   동시진행 모드는 상품을 고르지 않는다(대리 묶음 입구가 옵션을 받지 않는다 — 옵션 없는 같은 상품 · 결정 341).
  const optCtx = (!dualMode && !b.campaignId && b.sheetId && b.tabName)
    ? await tabOptionChoices(pool, { sheetId: String(b.sheetId), tabName: String(b.tabName) }) : null;

  res.json({
    ok: true, items, ...(dualMode ? { dual: true } : {}),
    optionChoices: optCtx ? optCtx.choices : [],
    truncated: all.length > MAX_LINES ? all.length - MAX_LINES : 0,
    okCount: items.filter(i => i.ok).length,
    errCount: items.filter(i => !i.ok).length,
    repairedCount: items.filter(i => (i.repairs || []).length || i.aiRepaired).length,
  });
});
_handlers.manualOrderPreview = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// ── 제출 ─────────────────────────────────────────────────────
// body: { sheetId, tabName, gid, campaignId?, productCheck?, allowProductMismatch?,
//         items:[{fields, optionKey?, targetApplicationId?, captureName?, captureOption?}] }
// ★ 건별 독립 처리 — 일부 실패해도 성공 건은 접수된다(카톡 재수집 비용 회피).
router.post('/submit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { sheetId, tabName, gid, campaignId } = b;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });

    const items = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES) : [];
    if (!items.length) return res.status(400).json({ ok: false, error: '제출할 건이 없습니다' });

    // ★ 결정 344 — 동시진행 작업표·공고는 배치를 시작하기 전에 쓰기 0건으로 거절(fail-closed).
    //   서버 최종 방어는 건별 `submitExternalOrder` 맨 앞의 같은 판정(manualDualBlock)이 맡는다.
    { const blocked = await manualDualBlock(pool, { sheetId, tabName, gid, campaignId });
      if (blocked) return res.status(409).json(blocked); }

    const allowOverDaily = b.allowOverDaily === true;
    const allowRepurchase = b.allowRepurchase === true;
    const effectiveRepurchaseDays = await resolveCampaignRepurchaseDays(pool, campaignId);

    /* ★★ 재참여(재구매) 기간 사전 판정 — "같은 작업(탭)" 기준(사용자 확정 2026-08-24).
       배치를 시작하기 전에 전 건의 전화번호를 한 번에 훑어, 최근 며칠 안에 같은 탭에서 이미
       접수된 번호가 있으면 **쓰기 0건**으로 되돌려 확인을 받는다(일 정원 사전 판정과 같은 이유
       — 건별로 막으면 "몇 건은 들어가고 몇 건은 막힘"이 남아 담당자가 무엇이 들어갔는지 모른다).
       ★ 서버 최종 방어는 건별 게이트(`submitExternalOrder` ⓪-1.5)가 맡는다 — 낡은 화면이 이
       사전 판정을 건너뛰고 호출해도 그쪽에서 다시 걸린다. */
    if (!allowRepurchase) {
      const p8List = items.map(it => phone8Of((it.fields || {}).phone));
      const blockedMap = await checkRepurchaseWindowBatch(pool, {
        sheetId, tabName, campaignId, phone8List: p8List, days: effectiveRepurchaseDays,
      });
      if (blockedMap.size) {
        const blocked = items
          .map((it, i) => ({ index: i, name: (it.fields || {}).recipient || '', p8: phone8Of((it.fields || {}).phone) }))
          .filter(x => blockedMap.has(x.p8))
          .map(x => ({ ...x, availableFrom: blockedMap.get(x.p8).availableFrom }));
        return res.json({
          ok: false, needConfirm: 'repurchase_window', blocked,
          error: `${blocked.length}건이 최근 ${effectiveRepurchaseDays}일 안에 이 작업에 이미 참여한 연락처입니다.`,
        });
      }
    }

    /* ★★ 일 정원(오늘 몫) 사전 판정 — 배치를 **시작하기 전에** 한 번만 본다.
       건별로 막으면 "앞 3건은 들어가고 뒤 2건은 거절"이라는 부분 처리가 남아, 담당자가 무엇이
       들어갔는지 모른 채 재붙여넣기를 하게 된다(중복 접수의 입구). 여기서 되돌리면 **쓰기 0건**.
       ★ 막지 않는다 — 숫자를 돌려주고 확인창을 받는다(사용자 확정 "나"안).
       ★ 판정 불가(null)는 통과 = 종전 동작(모르면 막지 않는다).
       ★ 서버 최종 방어는 건별 게이트(`submitExternalOrder` ⓪-3)가 맡는다 — 낡은 화면이 이
         사전 판정을 건너뛰고 호출해도 그쪽에서 다시 걸린다. */
    if (campaignId && !allowOverDaily) {
      const dq = await dailyRemainingForCampaign(pool, campaignId);
      if (dq && items.length > dq.remaining) {
        return res.json({
          ok: false, needConfirm: 'over_daily',
          quota: { ...dq, want: items.length, over: items.length - dq.remaining },
          error: `오늘 모집인원 ${dq.quota}명 중 ${dq.todayCount}명이 찼습니다. 남은 자리 ${dq.remaining}명인데 ${items.length}건을 접수하면 ${items.length - dq.remaining}명 초과합니다. 이미 구매가 끝난 건이라 접수를 미뤄도 구매는 취소되지 않습니다.`,
        });
      }
    }

    /* ★ 결정 211: 작업보드 경로의 상품(선택지) — 연결 공고가 하나로 정해지면 줄마다 고른 상품을 검증한다.
       ★ 새 화면(optionAware)만 "안 고름·마감 미확인"을 막는다 — 옛 화면(배포 직후 캐시)은 종전대로 접수
         (이미 산 주문의 기록이 비는 쪽이 더 나쁘다 — 오늘 몫 초과와 같은 규율). 상품이 하나뿐이면 자동. */
    const optionAware = b.optionAware === true;
    const optCtx = !campaignId ? await tabOptionChoices(pool, { sheetId, tabName }) : null;

    /* ★★ 결정 236 ⑤ — 담당자 수동 입력도 상품 확인을 거친다(사용자 확정 2026-10-13).
       결제금액·붙인 캡처 글자·그 연락처의 최근 참여 신청이 **고른 상품과 다른 상품**을 가리키면, 배치를 시작하기 전에
       **쓰기 0건**으로 되돌려 확인을 받는다(재참여·오늘 몫 사전 판정과 같은 이유 — 부분 처리를 남기지 않는다).
       확인(allowProductMismatch) 후 접수한 줄은 결과에 경고를 남기고 이상로그(manual_product_mismatch_confirmed)를 쓴다 — (가) 막지 않는다
       (리뷰어 화면은 잘못 구매를 "담당자에게 문의"로 보낸다 — 담당자까지 막으면 그 주문을 넣을 길이 없다).
       ★ 새 화면(productCheck:true)만 — 옛 화면(배포 직후 캐시)은 종전대로(결정 211 과 같은 규율). 판정 실패 = 걸지 않음. */
    const productCheckOn = b.productCheck === true;
    const allowProductMismatch = b.allowProductMismatch === true;
    const _checkCampaignId = campaignId || (optCtx && optCtx.campaignId) || null;
    let productFlags = [];
    if (productCheckOn && _checkCampaignId) {
      const pv = require('../services/productMismatchVerify.service');
      productFlags = await pv.checkManualEntries({
        campaignId: _checkCampaignId,
        // 접수 단계에서 어차피 거절될 줄(필수 칸 빔·전화 자릿수 이상)은 확인창에 올리지 않는다(코드리뷰).
        items: items.map((it, i) => {
          const f = (it && it.fields) || {};
          const _pd = String(f.phone == null ? '' : f.phone).replace(/[^0-9]/g, '');
          if (['recipient', 'phone', 'address', 'bank', 'account', 'depositor'].some(k => !String(f[k] == null ? '' : f[k]).trim())
              || (_pd.length !== 11 && _pd.length !== 10)) return null;
          const asked = String((it && it.optionKey) || '');
          const auto = (!campaignId && !asked && optCtx && optCtx.choices.length === 1) ? optCtx.choices[0].optKey : '';
          return { index: i, name: f.recipient || '', chosenKey: asked || auto, targetApplicationId: (it && it.targetApplicationId) || null,
                   price: f.price, captureName: (it && it.captureName) || '', captureOption: (it && it.captureOption) || '', phone8: phone8Of(f.phone) };
        }).filter(Boolean),
      }).catch(() => []);
      if (productFlags.length && !allowProductMismatch) {
        return res.json({
          ok: false, needConfirm: 'product_check', flagged: productFlags,
          error: `${productFlags.length}건의 상품을 확인해 주세요 — 고른 상품과 다른 상품을 샀거나, 다른 공고에 참여 신청한 연락처입니다.`,
        });
      }
    }
    const _flagAt = new Map(productFlags.map(x => [x.index, x]));

    const adminName = (req.admin && req.admin.name) || '';
    const results = [];
    const optTaken = new Map();   // ★ 이 묶음 안에서 상품별로 이미 받은 줄 수 — 남은 자리를 묶음 전체로 본다(Codex 리뷰)
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const f = it.fields || {};
      // 서버측 재검증 — 프론트 미리보기를 우회한 직접 호출 방어.
      // ★ 자릿수까지 본다: phone8이 8자리가 안 되면 검색·행배정·정원 키가 전부 어긋난다.
      const missing = ['recipient', 'phone', 'address', 'bank', 'account', 'depositor']
        .filter(k => !String(f[k] == null ? '' : f[k]).trim());
      if (missing.length) {
        results.push({ index: i, ok: false, error: '필수 항목이 비어 있습니다: ' + missing.join(', '), name: f.recipient || '' });
        continue;
      }
      const pd = String(f.phone).replace(/[^0-9]/g, '');
      if (pd.length !== 11 && pd.length !== 10) {
        results.push({ index: i, ok: false, error: `전화번호 자릿수가 이상합니다 (${pd.length}자리)`, name: f.recipient || '' });
        continue;
      }
      // ★ 작업보드 경로에서 상품 목록을 못 읽었으면 화면 값을 쓰지 않는다(검증 못 한 이름이 옵션 칸에 남지 않게 = 종전).
      let itemOptKey = campaignId ? (it.optionKey || '') : '';
      let itemOver = false;
      if (optCtx) {
        const live = optCtx.choices;
        const asked = String(it.optionKey || '');
        // ★ 상품 1개 자동은 **고른 값이 비었을 때만** — 고른 상품이 그사이 사라졌는데 남은 하나로 바꿔 넣지 않는다.
        const ch = asked ? live.find(c => c.optKey === asked) : (live.length === 1 ? live[0] : null);
        if (optionAware && !ch) {
          results.push({ index: i, ok: false, reason: asked ? 'option_unavailable' : 'option_required', name: f.recipient || '',
            error: asked ? '고른 상품을 더 이상 고를 수 없습니다(마감·삭제) — 다시 열어 골라 주세요' : '상품(옵션)을 골라 주세요' });
          continue;
        }
        if (ch) {
          const n = (optTaken.get(ch.optKey) || 0) + 1;
          itemOver = ch.remaining != null && n > ch.remaining;
          if (optionAware && itemOver && it.optionFullAck !== true) {
            results.push({ index: i, ok: false, reason: 'option_full_confirm', name: f.recipient || '',
              error: `이 상품의 남은 자리(${ch.remaining})를 넘습니다 — 확인 체크 후 다시 제출해 주세요` });
            continue;
          }
          optTaken.set(ch.optKey, n);
        }
        itemOptKey = ch ? ch.optKey : '';
      }
      try {
        const r = await submitExternalOrder({
          sheetId, tabName, gid: gid || '',
          fields: f,
          campaignId: campaignId || null,
          optionCampaignId: optCtx ? optCtx.campaignId : null,
          optionKey: itemOptKey,
          // 참여형 수동확정은 전화번호만으로 홀드를 고르지 않는다. 관리자가 선택한 신청 ID를
          // 서버가 캠페인·명의와 함께 다시 검증한다(재참여 직후 새 홀드 오확정 방지).
          targetApplicationId: it.targetApplicationId || null,
          adminName,
          force: b.force === true,   // 중복 경고를 확인한 뒤 재시도할 때만
          allowOverDaily,            // 오늘 정원 초과 확인을 받은 뒤 재시도할 때만
          allowRepurchase,           // 재참여 기간 제한 확인을 받은 뒤 재시도할 때만
          repurchaseDaysOverride: effectiveRepurchaseDays, // 선택한 모집공고의 저장값(사전·최종 판정 일치)
          // ★ 결정 348: 줄마다 고른 리뷰어 연결 — 서버가 id 로 다시 읽어 판정한다(화면 값은 mode·id 만 받는다)
          reviewerLink: (it.reviewerLink && typeof it.reviewerLink === 'object')
            ? { mode: String(it.reviewerLink.mode || ''), reviewerId: it.reviewerLink.reviewerId == null ? '' : String(it.reviewerLink.reviewerId) } : null,
        });
        // ★ 초과 접수는 결과 화면에 남긴다 — 확인을 받았더라도 "조용히 넘어간" 것으로 보이면
        //   이번에 문제가 된 상태(정원을 넘긴 줄 모름)가 그대로 되돌아온다.
        if (allowOverDaily && r && r.ok) {
          r.warnings = (r.warnings || []).concat('오늘 모집인원을 초과해 접수했습니다(관리자 확인됨)');
        }
        const pf = _flagAt.get(i);
        if (r && r.ok && pf) {
          r.warnings = (r.warnings || []).concat(`상품 확인 경고를 확인하고 접수(관리자 확인됨): ${pf.notes.join(' · ')}`);
          try {
            require('../services/errorLog.service').logAbnormal({
              flow: 'order_submit', step: 'manual_product_mismatch_confirmed', category: 'validation', source: 'server', severity: 'warn',
              fingerprintKey: 'os-' + (r.orderSubmissionId || ''),   // 주문마다 따로(지문은 숫자를 지운다)
              error: new Error(`수동 입력 상품 확인 경고를 담당자가 확인하고 접수 — 고른 「${pf.chosen || '?'}」 · ${pf.notes.join(' · ')} · 주문 ${r.orderSubmissionId || '?'} · by ${adminName || '?'}`),
              context: { sheetId, tabName, campaignId: _checkCampaignId, orderSubmissionId: r.orderSubmissionId || null },
            });
          } catch (_) { /* 기록 실패는 접수에 영향 없음 */ }
        }
        if (r && r.ok && itemOver) {
          const ch = optCtx.choices.find(c => c.optKey === itemOptKey);
          r.warnings = (r.warnings || []).concat(`남은 자리가 없는 상품(${ch ? (ch.unitKind === 'option' ? ch.optKey : (ch.productName || ch.optKey)) : itemOptKey})에 정원을 넘겨 접수했습니다(관리자 확인됨)`);
        }
        results.push({ index: i, name: f.recipient || '', ...r });
      } catch (e) {
        logger.error(`[manual-order] 건별 실패 idx=${i}: ${e.message}`);
        results.push({ index: i, ok: false, name: f.recipient || '', error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    logger.info(`[manual-order] 제출 완료 tab=${tabName} ${okCount}/${results.length} by=${adminName}`);
    // ★ 결정 345 ⑧: 리뷰어 구매제출과 같은 실시간 알림 — 열린 작업보드(같은 sheetId+tabName)가 바로 다시 불러온다.
    if (okCount > 0) {
      try {
        const okRes = results.filter(r => r.ok);
        emitOrderSubmit({
          sheetId, tabName, workboardId: null,
          orderer: (okRes[0].name || '') + (okCount > 1 ? ` 외 ${okCount - 1}명` : ''), recipient: '',
          dbSaved: true, sheetsWritten: false, queued: okRes.some(r => r.queued), manual: true,
        });
      } catch (_) { /* 알림 실패는 접수에 영향 없음 */ }
    }
    res.json({ ok: true, okCount, failCount: results.length - okCount, results });
  } catch (err) { next(err); }
});
_handlers.manualOrderSubmit = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

/* ── 결정 349: 네이버·쿠팡 동시진행 — 직원 대리 묶음 제출 · 수동제출 보통 주문 보완 ──
   ★ 결정 344 차단(위 preview/submit 의 manualDualBlock)은 그대로 둔다 — 동시진행은 **이 두 입구로만** 받는다.
     반대로 동시진행이 아닌 작업표는 서비스가 409 dual_channel_required 로 거절한다.
   ★ 권한 = 수동제출과 같은 2단(원본 adminOrMaster · Track B 위임은 내부인 + AE/편집 허용 admin).
   ★ 준비 상태가 닫히면 409 dual_channel_not_ready(서비스 맨 앞). */
function _dualStaffFail(res, next, e) {
  if (e && e.code && (Number.isInteger(e.status) || e.code === 'dual_channel_not_ready')) {
    return res.status(Number.isInteger(e.status) ? e.status : 409).json({ ok: false, code: e.code, error: e.message, message: e.message });
  }
  return next(e);
}
function _dualStaff(req) { const a = req.admin || {}; return { name: a.name || a.username || '', id: a.id || null }; }
router.post('/dual/submit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await require('../services/dualStaffSubmission.service').submitStaffBundle({
      sheetId: b.sheetId, tabName: b.tabName, gid: b.gid || '', campaignId: b.campaignId, fields: b.fields || {},
      naver: b.naver || {}, coupang: b.coupang || {}, targetApplicationId: b.targetApplicationId,
      reviewerLink: b.reviewerLink || null,   // 결정 348 리뷰어 연결 — 서비스가 수동제출과 같은 resolveReviewerLink 로 다시 판정
      force: b.force === true, allowRepurchase: b.allowRepurchase === true, allowOverDaily: b.allowOverDaily === true,
      staff: _dualStaff(req),
    });
    if (r.ok && !r.idempotent) {
      try { emitOrderSubmit({ sheetId: b.sheetId, tabName: b.tabName, workboardId: null, orderer: (b.fields || {}).recipient || '', recipient: '',
        dbSaved: true, sheetsWritten: false, queued: false, manual: true }); } catch (_) { /* 알림 실패는 접수에 영향 없음 */ }
    }
    res.json(r);
  } catch (e) { _dualStaffFail(res, next, e); }
});
_handlers.manualOrderDualSubmit = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다

router.post('/dual/complete', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await require('../services/dualStaffSubmission.service').completePlainOrder({
      orderSubmissionId: b.orderSubmissionId, naver: b.naver || {}, coupang: b.coupang || {}, staff: _dualStaff(req),
    }));
  } catch (e) { _dualStaffFail(res, next, e); }
});
_handlers.manualOrderDualComplete = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다

/* 결정 349 화면 — 보완 대상 목록(읽기 전용). 수동제출 창이 열릴 때 부른다: dual(동시진행 작업표인가) + 보완 필요 주문.
   개인정보는 이름·전화 뒤 4자리·금액·작업표 줄 번호만(전체 번호·주소·계좌 없음). 판정 실패 = 409(모른다를 0건으로 꾸미지 않는다). */
router.get('/dual/pending', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const q = req.query || {};
    res.json(await require('../services/dualStaffSubmission.service').listPlainPending({ sheetId: q.sheetId, tabName: q.tabName, gid: q.gid || '' }));
  } catch (e) { _dualStaffFail(res, next, e); }
});
_handlers.manualOrderDualPending = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다
// ── 리뷰어 연결 검색 (결정 348) ───────────────────────────────
// 줄마다 「기존 리뷰어 고르기」를 하는 창의 검색. 예전 reviewer-search(PR #394 에서 제거)는 **화면이 쓰지 않는**
// PII 통로였다 — 이번 것은 수동제출 창이 실제로 부르고, 위험을 막는 조건을 서비스·라우트가 함께 건다:
//  ① 실제 입구는 /api/trackb/manual-order/reviewer-search 하나(내부 직원 + 편집 허용 명단 2단 · app.js 옛 입구 없음)
//  ② 검색어 2글자 미만은 DB 를 보지 않음 · 최대 20명 · 전화·계좌는 뒤 4자리만 · 주소 미반환(searchReviewersForLink)
//  ③ 읽기 전용(GET) — 검색어는 로그에 남기지 않는다(개인정보).
router.get('/reviewer-search', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await searchReviewersForLink(req.query && req.query.q, pool);
    if (out.items.length) logger.info(`[manual-order] 리뷰어 연결 검색 n=${out.items.length} by=${(req.admin && req.admin.name) || '?'}`);
    res.json(out);
  } catch (err) { next(err); }
});
_handlers.manualOrderReviewerSearch = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 348)

// ★ 이름을 빼거나 바꾸면 trackB 가 기동 시 바로 실패한다(fail-closed) — 옛 공개 경로를 지워도 Track B 는 그대로다.
router.handlers = Object.freeze(_handlers);

module.exports = router;
