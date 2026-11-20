'use strict';
/* 결정 377 — Q&A 추가 모집 「오늘부터」 실 SQL 시험 재료(PGlite · 저장소 migrations 그대로).
 *  운영 사례 「11/3더로우 Q/A 50건」을 본뜬 가상 자료: 총 50 · 49 확정 · 자리표 11/03~11/12(8·8·8·8·6·4·2·2·2·2) · 못 채운 1(11/03 · 줄 5).
 *  ★ 실제 값이 아니다(이름·번호 모두 가짜). 운영 DB 에 닿지 않는다. */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..');
const SHEET = 'wt_qna_fixture';
const TAB = '11/3더로우 Q/A 50건';
const CAMP = 'camp_qna_fixture';
const CAMP_REVIEW = 'camp_review_fixture';
const WO = 'wo_qna_fixture';
const PRODUCT = '벨벳틴 부티크 상품';
const DATES = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
const PER = [8, 8, 8, 8, 6, 4, 2, 2, 2, 2];
const UNFILLED_SEQ = 5;

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  const skipped = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    // PGlite 에 없는 확장(pg_trgm·pgcrypto)을 쓰는 몇 파일은 건너뛴다 — 이 시험이 읽는 표와 무관
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { skipped.push(f); }
  }
  return { db, skipped };
}

/** pg Pool 과 같은 모양(query·connect) — PGlite 는 연결이 하나라 시험은 차례로만 돈다. */
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}

function injectPool(pool) {
  const poolPath = require.resolve('../../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
}

// 작업표 진행일자 칸 표기 = 추가 모집이 쓰는 것과 같은 표기(businessDays 의 label)
const md = d => require('../../src/utils/worktablePlan').businessDays({ count: 1, startDate: d, skipWeekends: false })[0].label;

async function seed(pool, { plans = {}, windowStart = null, windowEnd = null, skipWeekends = false } = {}) {
  const q = (s, p) => pool.query(s, p);
  for (const t of ['campaign_applications', 'qna_slots', 'campaign_participants', 'campaign_daily_plans', 'campaign_plan_events',
    'order_submissions', 'recruit_campaigns', 'work_orders', 'tab_configs', 'campaign_options']) await q(`DELETE FROM ${t}`);
  const { selectionKey } = require('../../src/services/productOptions.service');
  const unit = selectionKey(PRODUCT, '', '');
  await q(`INSERT INTO work_orders (id, title, status, work_kind, product_options_json, recruit_count, daily_count, skip_weekends, created_by, linked_tab_sheet_id, linked_tab_name)
           VALUES ($1, $2, 'published', 'qna', $3, 50, 8, $4, '망고', $5, $6)`,
    [WO, TAB, JSON.stringify([{ name: PRODUCT, product_mode: 'base', count: 50, daily: 8, options: [] }]), skipWeekends, SHEET, TAB]);
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, $2, 'qna', true)`, [SHEET, TAB]);
  const camp = (id, title, kind) => q(
    `INSERT INTO recruit_campaigns (id, title, participation_mode, status, daily_limit, recruit_total, window_start, window_end, skip_weekends,
                                    carry_mode, carry_strategy, start_date, manager, linked_sheet_id, linked_tab_name, work_kind, source_work_order_id)
     VALUES ($1, $2, true, 'active', 8, 50, $3, $4, $5, 'auto', 'spread', '2026-11-03', '망고', $6, $7, $8, $9)`,
    [id, title, windowStart, windowEnd, skipWeekends, kind === 'qna' ? SHEET : null, kind === 'qna' ? TAB : null, kind, kind === 'qna' ? WO : null]);
  await camp(CAMP, TAB, 'qna');
  await camp(CAMP_REVIEW, '일반 리뷰 공고(비교용)', 'review');
  let seq = 2, us = 1;
  for (let i = 0; i < DATES.length; i++) {
    for (let k = 0; k < PER[i]; k++, seq++, us++) {
      const filled = seq !== UNFILLED_SEQ;
      let os = null;
      if (filled) os = (await q(`INSERT INTO order_submissions (sheet_id, tab_name, source, submitted_at) VALUES ($1, $2, 'qna_submit', $3::date + interval '2 hours') RETURNING id`, [SHEET, TAB, DATES[i]])).rows[0].id;
      await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, start_date, row_json, order_submission_id, reviewer_name, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [SHEET, TAB, seq, md(DATES[i]), JSON.stringify({ 진행일자: md(DATES[i]) }), os, filled ? '가짜리뷰어' + seq : null]);
      const sid = (await q(`INSERT INTO qna_slots (work_order_id, sheet_id, tab_name, seq, unit_key, product_name, unit_seq, slot_date, visibility)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'private') RETURNING id`, [WO, SHEET, TAB, seq, unit, PRODUCT, us, DATES[i]])).rows[0].id;
      if (filled) {
        await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, applied_at, submitted_at, expires_at, qna_slot_id, order_submission_id)
                 VALUES ($1, $2, $3, $4, 'submitted', $5::date + interval '10 hours', $5::date + interval '11 hours', $5::date + interval '12 hours', $6, $7)`,
          [CAMP, '가짜리뷰어' + seq, '010' + String(10000000 + seq), String(10000000 + seq), DATES[i], sid, os]);
      }
    }
  }
  for (const [d, n] of Object.entries(plans)) {
    await q(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by) VALUES ($1, $2::date, $3, '망고')`, [CAMP, d, n]);
  }
  return { unit };
}

/** KST 시각 → Date */
const kst = (ymd, hm) => new Date(`${ymd}T${hm}:00+09:00`);

module.exports = { openDb, poolOf, injectPool, seed, kst, SHEET, TAB, CAMP, CAMP_REVIEW, WO, PRODUCT, DATES, PER, UNFILLED_SEQ };
