/**
 * campaignWorktable.service.js — 공고 전용 작업보드 자동 확보 (탈 구글시트)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 하는 일 = **"이 공고의 주문은 어느 작업보드에 쌓이는가"를 항상 있게 만든다**
 *
 *   종전:  공고에 연결된 작업표가 없으면 주문마다 `no_worktable_mapping` →
 *          주문을 failed 로 강등 + critical 오류로그 + 2분마다 도는 reconcile 이
 *          `campaign:*` 키를 해석 못 해 영원히 스킵 → 같은 이상현상이 반복됐다.
 *   이번:  연결이 없으면 **그 공고 이름으로 무시트 작업표를 만들어 연결**하고
 *          그 뒤 주문은 거기에 계속 쌓인다(사람이 시트탭을 고르는 절차 없음).
 *
 * ★★ 구글 API 호출 0 · 시트 쓰기 0. 만드는 것은 **가상 작업표**(tab_configs.sheetless=TRUE)뿐이다.
 *
 * ★★ 등록 관문 규율: 작업오더 접수(accept)는 여전히 "작업오더 → 작업표"의 단일 관문이다.
 *   이 서비스는 **접수를 거치지 않고 발행된 공고**(직접 발행·테스트 공고 등)가 주문을 받을 때
 *   갈 곳을 만들어 줄 뿐이고, 접수로 이미 연결된 공고는 **손대지 않는다**.
 *
 * ★ 사본 0 — 열 구성은 `worktablePlan.buildColumns`(표준 열 템플릿), 작업표 줄 쓰기는
 *   `participants.service`, 장부는 `sheetlessLedger.rebuildLedgers`, 가상 ID 는
 *   `sheetlessAccept.service` 를 그대로 쓴다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/**
 * 공고에 연결된 작업보드를 보장한다.
 *
 * @returns {Promise<{ok:boolean, sheetId?:string, tabName?:string, tabGid?:string,
 *                     created?:boolean, reason?:string, message?:string}>}
 *   ok:false 는 "만들지 못했다"는 뜻이고 호출부는 종전처럼 미반영으로 처리한다
 *   (조용히 성공으로 꾸미지 않는다).
 */
async function ensureCampaignWorktable({ campaignId, by = 'system' } = {}) {
  if (!campaignId) return { ok: false, reason: 'bad_request' };
  const db = getPool();

  /* ① 접수로 이미 만들어진 작업표가 있는데 연결만 끊긴 공고는 **새로 만들지 않는다** —
     기존 복구 함수(작업오더 식별자 근거)로 먼저 되살린다. 사본을 두지 않으려고 그대로 호출한다.
     실패해도 아래 경로가 있으므로 fail-soft. */
  try {
    await require('./sheetlessOrder.service').reconcileCampaignWorktableLinks();
  } catch (_) { /* fail-soft */ }

  const client = await db.connect();
  let made = null;
  try {
    await client.query('BEGIN');
    /* ★ 공고 행 잠금 — 같은 공고에 주문이 동시에 들어와도 작업표가 두 개 생기지 않는다. */
    const { rows } = await client.query(
      `SELECT id, title, landing_url, linked_sheet_id, linked_tab_name, linked_tab_gid
         FROM recruit_campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'campaign_not_found' }; }
    const c = rows[0];

    if (String(c.linked_sheet_id || '') && String(c.linked_tab_name || '')) {
      await client.query('COMMIT');
      return {
        ok: true, created: false,
        sheetId: c.linked_sheet_id, tabName: c.linked_tab_name, tabGid: String(c.linked_tab_gid || ''),
      };
    }

    const title = String(c.title || '').trim().slice(0, 90);
    if (!title) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_title' }; }

    // ── 열 구성 = 표준 열 템플릿(설정 › 작업표 표준 열). 채널은 상품 링크에서 추정(실패=공통 열만).
    const { getTemplate } = require('./worktable.service');
    const { buildColumns, channelFromUrl } = require('../utils/worktablePlan');
    const template = await getTemplate();
    let channel = '';
    try { channel = channelFromUrl(c.landing_url || '') || ''; } catch (_) { channel = ''; }
    const columns = buildColumns({ template, channel, workTypes: [] }).map(x => x.name);
    if (!columns.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_columns' }; }

    /* ★★ 가상 ID 는 **결정적 파생**(sheetlessAccept 단일 출처) — 랜덤 발급 금지.
       링크 UPDATE 전에 실패해 재시도해도 같은 ID 라 `ON CONFLICT (sheet_id, tab_name)` 이
       스스로 dedupe 한다(작업오더 재접수에서 탭이 하나씩 늘던 사고와 같은 규율).
       키는 `campaign:<공고ID>` 로 작업오더 키스페이스와 겹치지 않게 둔다. */
    const { virtualSheetIdForOrder, virtualGidForOrder } = require('./sheetlessAccept.service');
    const idKey = `campaign:${campaignId}`;
    const sheetId = virtualSheetIdForOrder(idKey);
    const gid = virtualGidForOrder(idKey);

    // ── 등록: campaigns + tab_configs(sheetless=TRUE) ──
    //   ★ `sheet_url` 은 **빈 값** — 가상 ID 를 구글 URL 로 조립하면 죽은 링크가 된다.
    await client.query(
      `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
       VALUES ($1, $2, '')
       ON CONFLICT (sheet_id, campaign_name) DO NOTHING`, [sheetId, title]);
    await client.query(
      `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheet_url, campaign_name, display_name,
                                sheetless, updated_at)
       VALUES ($1, $2, $3, '', $4, $4, TRUE, NOW())
       ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
         sheetless = TRUE, tab_gid = COALESCE(NULLIF(tab_configs.tab_gid,''), EXCLUDED.tab_gid),
         updated_at = NOW()`, [sheetId, title, gid, title]);

    await client.query(
      `UPDATE recruit_campaigns
          SET linked_sheet_id = $2, linked_tab_name = $3, linked_tab_gid = $4, updated_at = NOW()
        WHERE id = $1`, [campaignId, sheetId, title, gid]);

    await client.query('COMMIT');
    made = { sheetId, tabName: title, tabGid: gid, columns };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error(`[campaignWorktable] 작업보드 생성 실패 camp=${campaignId}: ${err.message}`);
    return { ok: false, reason: 'exception', message: err.message };
  } finally {
    client.release();
  }

  /* ② 장부 3권 — 등록(sheetless=TRUE)이 커밋된 **뒤에** 부른다(rebuildLedgers 가 그 플래그를
     fail-closed 로 확인한다). 줄은 0개로 시작하고 주문이 들어올 때마다 이어붙는다. */
  try {
    await require('./sheetlessLedger.service').rebuildLedgers({
      sheetId: made.sheetId, tabName: made.tabName, columns: made.columns,
      by: `campaign-worktable:${by}`,
    });
  } catch (err) {
    // 등록은 살아 있고 다음 주문·복구 때 다시 만들어진다. 조용히 넘기지 않고 남긴다.
    logger.warn(`[campaignWorktable] 장부 생성 실패(등록은 완료) tab=${made.tabName}: ${err.message}`);
  }

  logger.info(`[campaignWorktable] 공고 전용 작업보드 생성 camp=${campaignId} tab=${made.tabName} sheet=${made.sheetId}`);
  return { ok: true, created: true, sheetId: made.sheetId, tabName: made.tabName, tabGid: made.tabGid };
}

module.exports = { ensureCampaignWorktable, __setPoolForTest };
