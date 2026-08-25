/**
 * 외부모집 구매양식 관리자 수동제출 라우트 — 전부 admin/master 전용.
 *
 * ★ 무인증인 `/api/submit/order` 를 재사용하지 않는 이유: 그 경로는 loginPhone8 이 없으면
 *   신원게이트 전체를 건너뛰도록 설계돼 있다(레거시 호환). 관리자 기능의 정식 문을 그 우회로에
 *   두면 무인증 표면이 그대로 노출된다 → 별도 인증 라우트 + 서비스 재사용.
 */
const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { parseSlashForm } = require('../utils/slashForm');
const { submitExternalOrder, dailyRemainingForCampaign } = require('../services/manualOrder.service');
const { checkRepurchaseWindowBatch, phone8Of } = require('../utils/repurchaseGuard');
const { logger } = require('../utils/logger');

const MAX_LINES = 50;   // 한 번에 처리할 최대 건수(오붙여넣기로 수백 건이 들어가는 사고 방지)

// ── 파싱 미리보기 (읽기 전용) ────────────────────────────────
// 제출 전에 9칸 분해 결과를 사람이 확인·수정하게 한다. DB 접근 없음.
const AI_REPAIR_MAX = parseInt(process.env.SLASHFORM_AI_REPAIR_MAX || '10', 10);   // 한 요청당 AI 호출 상한

router.post('/preview', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
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
          const re = parseSlashLine(rebuilt);
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

  res.json({
    ok: true, items,
    truncated: all.length > MAX_LINES ? all.length - MAX_LINES : 0,
    okCount: items.filter(i => i.ok).length,
    errCount: items.filter(i => !i.ok).length,
    repairedCount: items.filter(i => (i.repairs || []).length || i.aiRepaired).length,
  });
});

// ── 제출 ─────────────────────────────────────────────────────
// body: { sheetId, tabName, gid, campaignId?, items:[{fields, optionKey?, targetApplicationId?}] }
// ★ 건별 독립 처리 — 일부 실패해도 성공 건은 접수된다(카톡 재수집 비용 회피).
router.post('/submit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { sheetId, tabName, gid, campaignId } = b;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });

    const items = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES) : [];
    if (!items.length) return res.status(400).json({ ok: false, error: '제출할 건이 없습니다' });

    const allowOverDaily = b.allowOverDaily === true;
    const allowRepurchase = b.allowRepurchase === true;

    /* ★★ 재참여(재구매) 기간 사전 판정 — "같은 작업(탭)" 기준(사용자 확정 2026-08-24).
       배치를 시작하기 전에 전 건의 전화번호를 한 번에 훑어, 최근 며칠 안에 같은 탭에서 이미
       접수된 번호가 있으면 **쓰기 0건**으로 되돌려 확인을 받는다(일 정원 사전 판정과 같은 이유
       — 건별로 막으면 "몇 건은 들어가고 몇 건은 막힘"이 남아 담당자가 무엇이 들어갔는지 모른다).
       ★ 서버 최종 방어는 건별 게이트(`submitExternalOrder` ⓪-1.5)가 맡는다 — 낡은 화면이 이
       사전 판정을 건너뛰고 호출해도 그쪽에서 다시 걸린다. */
    if (!allowRepurchase) {
      const p8List = items.map(it => phone8Of((it.fields || {}).phone));
      const blockedMap = await checkRepurchaseWindowBatch(pool, { sheetId, tabName, phone8List: p8List });
      if (blockedMap.size) {
        const blocked = items
          .map((it, i) => ({ index: i, name: (it.fields || {}).recipient || '', p8: phone8Of((it.fields || {}).phone) }))
          .filter(x => blockedMap.has(x.p8))
          .map(x => ({ ...x, availableFrom: blockedMap.get(x.p8).availableFrom }));
        return res.json({
          ok: false, needConfirm: 'repurchase_window', blocked,
          error: `${blocked.length}건이 최근 ${(require('../utils/repurchaseGuard').repurchaseDays)()}일 안에 이 작업에 이미 참여한 연락처입니다.`,
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

    const adminName = (req.admin && req.admin.name) || '';
    const results = [];
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
      try {
        const r = await submitExternalOrder({
          sheetId, tabName, gid: gid || '',
          fields: f,
          campaignId: campaignId || null,
          optionKey: it.optionKey || '',
          // 참여형 수동확정은 전화번호만으로 홀드를 고르지 않는다. 관리자가 선택한 신청 ID를
          // 서버가 캠페인·명의와 함께 다시 검증한다(재참여 직후 새 홀드 오확정 방지).
          targetApplicationId: it.targetApplicationId || null,
          adminName,
          force: b.force === true,   // 중복 경고를 확인한 뒤 재시도할 때만
          allowOverDaily,            // 오늘 정원 초과 확인을 받은 뒤 재시도할 때만
          allowRepurchase,           // 재참여 기간 제한 확인을 받은 뒤 재시도할 때만
        });
        // ★ 초과 접수는 결과 화면에 남긴다 — 확인을 받았더라도 "조용히 넘어간" 것으로 보이면
        //   이번에 문제가 된 상태(정원을 넘긴 줄 모름)가 그대로 되돌아온다.
        if (allowOverDaily && r && r.ok) {
          r.warnings = (r.warnings || []).concat('오늘 모집인원을 초과해 접수했습니다(관리자 확인됨)');
        }
        results.push({ index: i, name: f.recipient || '', ...r });
      } catch (e) {
        logger.error(`[manual-order] 건별 실패 idx=${i}: ${e.message}`);
        results.push({ index: i, ok: false, name: f.recipient || '', error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    logger.info(`[manual-order] 제출 완료 tab=${tabName} ${okCount}/${results.length} by=${adminName}`);
    res.json({ ok: true, okCount, failCount: results.length - okCount, results });
  } catch (err) { next(err); }
});

module.exports = router;
