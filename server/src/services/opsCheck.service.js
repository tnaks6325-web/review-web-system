'use strict';
/**
 * 「오늘 확인할 것」 (결정 302 · 사용자 확정 2026-10-27)
 *
 * 사람이 답해야 하는 일을 한곳(ops_checks)에 모은다. 홈과 입금관리가 같은 목록을 보여 준다.
 * 첫 종류 = 케이뱅크 대량이체 통장 대조 — 묶음(같은 시각에 이어 찍힌 대량이체 출금)마다
 *   ① 통장에서 안 나간 사람(대량이체에 있는데 통장에 그 금액이 모자람) — 직원이 [뺀 사람 고르기]로 답한다
 *   ② 리뷰웹 기록 없이 같이 나간 돈(금액 묶음별) — 직원이 「무슨 돈인가」를 골라 답한다
 *
 * ★ 숫자는 시스템이 계산한다(paymentBank 의 같은 재료·같은 기준 — 사본 금지). AI 는 문장만 쓴다.
 *   AI 문장에 사실에 없는 숫자가 하나라도 있으면 버리고 기본 문장을 쓴다(지어낸 숫자 금지).
 * ★ AI 에는 리뷰어 이름·계좌를 보내지 않는다(작업명·금액·건수만).
 * ★ 실패해도 통장 받기·자동 확정을 막지 않는다(부르는 쪽이 try/catch) · 모르면 '처리 완료'로 접지 않는다.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const { mapWorkManager } = require('../utils/workManager');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }
let _generate = null;   // 테스트가 AI 를 바꿔 끼운다(기본 = gemini.service.generateStructuredJson)
function __setGenerateForTest(f) { _generate = f || null; }

const KIND_BANK = 'bank_cluster';
// 이 날짜 이후 묶음만 만든다 — 기능 이전의 기록 없는 돈(10/21~26)을 한꺼번에 확인거리로 쏟지 않는다.
const SINCE_MS = Date.parse('2026-10-27T00:00:00+09:00');
const CHOICES = { direct: '리뷰비·페이백 직접 보냄', not_reviewer: '리뷰어 돈 아님', unknown: '모르겠음' };
const DONE_CHOICES = new Set(['direct', 'not_reviewer']);
const AI_TIMEOUT_MS = 8000;
const KST_MS = 9 * 3600 * 1000;

class OpsCheckError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const won = n => Number(n || 0).toLocaleString('ko-KR');
function _countBy(list, f) { const m = new Map(); for (const x of list) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return m; }
function _kst(ms) {
  const d = new Date(Number(ms) + KST_MS);
  const p = n => String(n).padStart(2, '0');
  return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}

/**
 * 묶음 하나의 사실(순수 계산 · 쓰기 없음).
 * @param {object} p
 * @param {{start:number,end:number,rows:Array<{at,amount,kind}>}} p.cluster
 * @param {Array} p.rows                      같은 기간 통장 줄(취소 반환을 찾는다)
 * @param {object|null} p.openRec             이 묶음을 차지한 처리 전 대량이체의 reconcileBatch 결과(+items) — 없으면 null
 * @param {object|null} p.batch               이 묶음의 대량이체 {id,seq,createdBy}
 * @param {Array<{amount}>} p.paidElsewhere   이 묶음 시각 ±여유 안에 '이체 완료'로 기록된 다른 줄
 * @param {Map<number,string[]>} p.feeWorks   리뷰비만 보내는 작업(금액 → 작업명들) — 추정 재료
 * @param {number} p.refundWindowMs
 */
function buildClusterFacts({ cluster, rows, openRec, batch, paidElsewhere = [], feeWorks = new Map(), refundWindowMs }) {
  const left = _countBy(cluster.rows, r => Number(r.amount));
  const take = (a, n) => { const v = left.get(a) || 0; left.set(a, Math.max(0, v - n)); };
  const short = []; const shortUnknown = [];
  if (openRec && Array.isArray(openRec.amounts)) {
    for (const a of openRec.amounts) {
      take(a.amount, Math.min(a.count, a.bank));   // 대량이체 몫(통장에 있는 만큼) — 남는 건 기록 없이 나간 돈
      if (a.failures == null) { shortUnknown.push({ amount: a.amount, count: a.count, bank: a.bank }); continue; }
      if (a.failures > 0) {
        const items = (openRec.items || []).filter(it => Number(it.amount) === a.amount && it.status === 'pending');
        const jobs = [...new Set(items.map(it => String(it.tabName || '')).filter(Boolean))];
        short.push({ amount: a.amount, failures: a.failures, count: a.count, bank: a.bank, refunds: a.refunds, jobs });
      }
    }
  }
  for (const p of paidElsewhere) take(Number(p.amount), 1);
  for (const r of rows) {
    if (r.kind !== 'refund_in' || r.at < cluster.start || r.at > cluster.end + refundWindowMs) continue;
    take(Number(r.amount), 1);
  }
  const outside = [...left.entries()].filter(([, n]) => n > 0).sort((x, y) => y[0] * y[1] - x[0] * x[1])
    .map(([amount, count]) => {
      const works = feeWorks.get(amount) || [];
      return { key: `out:${amount}`, amount, count, guess: works.length ? { kind: 'fee_only_work', works: works.slice(0, 3) } : null };
    });
  const t = _kst(cluster.start);
  return {
    cluster: { start: cluster.start, end: cluster.end, rowCount: cluster.rows.length,
      total: cluster.rows.reduce((s, r) => s + Number(r.amount), 0), date: t.md, time: t.hm },
    batch: batch ? { id: String(batch.id), seq: Number(batch.seq), createdBy: String(batch.createdBy || '') } : null,
    short, shortUnknown, outside,
    outsideTotal: { count: outside.reduce((s, o) => s + o.count, 0), sum: outside.reduce((s, o) => s + o.amount * o.count, 0) },
  };
}

function hasWork(f) { return !!(f && (f.short.length || f.shortUnknown.length || f.outside.length)); }

/** 기대하는 문장 자리(키) — AI 도 정확히 이 키들로만 답해야 한다. */
function expectedKeys(f) {
  const k = [];
  if (f.short.length) k.push('short');
  if (f.shortUnknown.length) k.push('short_unknown');
  if (f.outside.length) { k.push('out'); f.outside.forEach(o => k.push(o.key)); }
  return k;
}

/** 기본 문장(AI 없이도 늘 같은 뜻) */
function fallbackLines(f) {
  const lines = [];
  if (f.short.length) {
    const n = f.short.reduce((s, x) => s + x.failures, 0);
    const refunds = f.short.reduce((s, x) => s + (x.refunds || 0), 0);
    const parts = f.short.map(x => `${x.jobs.length ? x.jobs.join('·') + ' ' : ''}${won(x.amount)}원 ${x.failures}명`);
    lines.push({ key: 'short', text: `통장에서 ${n}명이 안 나갔습니다 — ${parts.join(' / ')}`
      + (refunds ? '' : '. 취소로 돌아온 돈이 없어 이체 파일에서 뺀 것으로 보입니다') });
  }
  if (f.shortUnknown.length) {
    lines.push({ key: 'short_unknown', text: f.shortUnknown.map(x => `${won(x.amount)}원`).join(' · ')
      + '은 통장에 대량이체보다 더 많이 찍혀, 누가 받았는지 통장만으로는 알 수 없습니다' });
  }
  if (f.outside.length) {
    lines.push({ key: 'out', text: `리뷰웹 기록 없이 같이 나간 돈 ${f.outsideTotal.count}건 · ${won(f.outsideTotal.sum)}원 — 무슨 돈인지 골라 주세요` });
    for (const o of f.outside) {
      lines.push({ key: o.key, text: `${won(o.amount)}원 × ${o.count}건`
        + (o.guess ? ` — 리뷰비만 보내는 작업(${o.guess.works.join(', ')})의 리뷰비와 같은 금액입니다` : '') });
    }
  }
  return lines;
}

/** 사실에 들어 있는 숫자 전부(+ 날짜·시각·작업명 속 숫자) — AI 문장 검사용 */
function allowedNumbers(f) {
  const set = new Set();
  const add = v => { const n = Number(v); if (Number.isFinite(n)) set.add(n); };
  const walk = v => {
    if (v == null) return;
    if (typeof v === 'number') { add(v); return; }
    if (typeof v === 'string') { (v.match(/\d+/g) || []).forEach(add); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (k === 'start' || k === 'end' || k === 'id') continue; walk(x); } }
  };
  walk(f);
  // 합계·건수 파생값(사람이 쓰는 말에 자연스럽게 나오는 것)
  add(f.short.reduce((s, x) => s + x.failures, 0));
  add(f.outside.length);
  return set;
}

/** AI 문장 검사 — 키가 정확히 같고, 모든 숫자가 사실에 있어야 통과. */
function validateAiLines(f, lines) {
  const keys = expectedKeys(f);
  if (!Array.isArray(lines) || lines.length !== keys.length) return false;
  const allowed = allowedNumbers(f);
  for (let i = 0; i < keys.length; i++) {
    const l = lines[i];
    if (!l || l.key !== keys[i] || typeof l.text !== 'string') return false;
    const text = l.text.trim();
    if (!text || text.length > 200) return false;
    for (const m of text.match(/\d[\d,]*/g) || []) {
      const n = Number(m.replace(/,/g, ''));
      if (!allowed.has(n)) return false;
    }
  }
  return true;
}

/** AI 에 보내는 사실 — 리뷰어 이름·계좌는 원래 facts 에 없다. id·시각 숫자는 뺀다. */
function _factsForAi(f) {
  return {
    대량이체: f.batch ? `#${f.batch.seq}` : '리뷰웹 대량이체와 이어지지 않은 묶음',
    통장묶음: { 날짜: f.cluster.date, 시각: f.cluster.time, 건수: f.cluster.rowCount, 합계: f.cluster.total },
    통장에서_안나간사람: f.short.map(x => ({ 작업: x.jobs, 금액: x.amount, 안나간사람: x.failures, 대량이체건수: x.count, 통장건수: x.bank, 취소로돌아옴: x.refunds })),
    통장에_더찍힌금액: f.shortUnknown.map(x => ({ 금액: x.amount, 대량이체건수: x.count, 통장건수: x.bank })),
    기록없이나간돈: f.outside.map(o => ({ key: o.key, 금액: o.amount, 건수: o.count, 같은금액_리뷰비만보내는작업: o.guess ? o.guess.works : [] })),
    기록없이나간돈_합계: f.outsideTotal,
  };
}

async function writeLines(f) {
  const fb = fallbackLines(f);
  const keys = expectedKeys(f);
  const gen = _generate || require('./gemini.service').generateStructuredJson;
  try {
    const prompt = [
      '리뷰 체험단 회사의 입금 담당 직원에게 보여 줄 「확인할 것」 문장을 쓴다.',
      '아래 사실 JSON 만 근거로, 정해진 key 마다 한 문장씩 쓴다(key 순서 그대로).',
      `key 목록: ${JSON.stringify(keys)}`,
      '- short: 통장에서 안 나간 사람 수와 작업·금액. 취소로 돌아온 돈이 0이면 "이체 파일에서 뺀 것으로 보입니다"라고 덧붙인다.',
      '- short_unknown: 그 금액은 통장만으로 누가 받았는지 알 수 없다는 사실.',
      '- out: 리뷰웹 기록 없이 같이 나간 돈의 합계와, 무슨 돈인지 골라 달라는 부탁.',
      '- out:<금액>: 그 금액 × 건수. 같은금액_리뷰비만보내는작업이 있으면 "~의 리뷰비로 보입니다"처럼 추정임을 밝힌다.',
      '규칙: 숫자는 사실 JSON 에 있는 것만 쓴다(새 숫자·계산한 숫자 금지). 금액은 1,000원처럼 쉼표. 쉬운 말, 한 문장 80자 안팎. 개발 용어 금지.',
      '출력: {"lines":[{"key":"...","text":"..."}]} JSON 만.',
      `사실: ${JSON.stringify(_factsForAi(f))}`,
    ].join('\n');
    const raw = await gen(prompt, { label: '[opsCheck]', timeoutMs: AI_TIMEOUT_MS, maxAttempts: 1, maxOutputTokens: 1024 });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const lines = parsed && Array.isArray(parsed.lines) ? parsed.lines.map(l => ({ key: String(l && l.key || ''), text: String(l && l.text || '').trim() })) : null;
    if (lines && validateAiLines(f, lines)) return { lines, source: 'ai' };
    logger.warn('[opsCheck] AI 문장이 사실과 맞지 않아 기본 문장을 씁니다');
  } catch (e) {
    logger.warn(`[opsCheck] AI 문장 실패 — 기본 문장: ${e && e.message}`);
  }
  return { lines: fb, source: 'fallback' };
}

/** 처리 완료 판정 — 안 나간 사람이 없고(고르기로 확정됨) · 통장만으로 모르는 금액도 없고(Codex P2 — 그 사람들은 아직 '결과 대기')
 *  · 기록 없는 돈 묶음마다 '모르겠음' 아닌 답이 있을 때. */
function isDone(f, answers) {
  if (!f) return true;
  if (f.short.length || (f.shortUnknown || []).length) return false;
  for (const o of f.outside) {
    const a = answers && answers[o.key];
    if (!a || !DONE_CHOICES.has(a.choice)) return false;
  }
  return true;
}

function factsHash(f) {
  return crypto.createHash('sha1').update(JSON.stringify(f)).digest('hex');
}

/* ── 저장소 ───────────────────────────────────────────── */

async function _feeWorksByAmount(amounts) {
  const list = [...new Set(amounts.map(Number))].filter(n => n > 0);
  const map = new Map();
  if (!list.length) return map;
  const { rows } = await _db().query(
    `SELECT DISTINCT COALESCE(NULLIF(btrim(tc.display_name), ''), c.linked_tab_name) AS label, c.review_fee AS fee
       FROM recruit_campaigns c
       LEFT JOIN tab_configs tc ON tc.sheet_id = c.linked_sheet_id AND tc.tab_name = c.linked_tab_name
      WHERE c.transfer_bank LIKE 'split%' AND c.review_fee = ANY($1::int[]) AND c.linked_tab_name IS NOT NULL
     UNION
     SELECT DISTINCT COALESCE(NULLIF(btrim(display_name), ''), tab_name), review_fee
       FROM tab_configs WHERE transfer_bank LIKE '제품비업체%' AND review_fee = ANY($1::int[])`, [list]);
  for (const r of rows) {
    const k = Number(r.fee); if (!map.has(k)) map.set(k, []);
    if (r.label && !map.get(k).includes(r.label)) map.get(k).push(String(r.label));
  }
  return map;
}

/** 최근 7일 케이뱅크 대량이체 묶음마다 사실을 만든다(쓰기 없음). */
async function collectBankFacts({ now = Date.now() } = {}) {
  const bank = require('./paymentBank.service');
  const { SYNC_DAYS, SETTLE_MS, REFUND_WINDOW_MS, CLAIM_SLACK_MS } = bank.TIMING;
  const fromMs = Math.max(SINCE_MS, now - SYNC_DAYS * 24 * 3600 * 1000);
  const rows = await bank.loadRows(fromMs - 3600 * 1000, now);
  const clusters = bank.clusterBulk(rows).filter(c => c.start >= fromMs && now >= c.end + SETTLE_MS);
  if (!clusters.length) return [];
  // 처리 전 대량이체 — 어느 묶음을 차지했는지(reconcileBatch 와 같은 기준)
  const { rows: open } = await _db().query(
    `SELECT b.id, b.seq, b.created_by FROM payment_batches b
      WHERE b.bank = 'kbank' AND b.status <> 'cancelled' AND b.created_at >= $1
        AND EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending')
      ORDER BY b.created_at`, [new Date(fromMs - 3 * 24 * 3600 * 1000).toISOString()]);
  const openRecs = [];
  for (const b of open) {
    try {
      const rec = await bank.inspectBatch(b.id, { now });
      if (rec.cluster) openRecs.push({ batch: { id: b.id, seq: b.seq, createdBy: b.created_by }, rec });
    } catch (e) { logger.warn(`[opsCheck] 대량이체 대조 건너뜀(${b.id}): ${e.message}`); }
  }
  const { rows: paid } = await _db().query(
    `SELECT i.batch_id, b.seq, b.created_by, i.amount, (EXTRACT(EPOCH FROM i.paid_at) * 1000)::bigint AS at
       FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
      WHERE b.bank = 'kbank' AND i.status = 'paid' AND i.paid_at >= $1`,
    [new Date(fromMs - 3600 * 1000).toISOString()]);
  const outsideAmounts = [];
  const pre = clusters.map(c => {
    const own = openRecs.find(o => o.rec.cluster.start === c.start) || null;
    const inWin = paid.filter(p => Number(p.at) >= c.start - CLAIM_SLACK_MS && Number(p.at) <= c.end + CLAIM_SLACK_MS
      && (!own || String(p.batch_id) !== String(own.batch.id)));
    let batch = own ? own.batch : null;
    if (!batch && inWin.length) {   // 처리 끝난 대량이체 — 이 묶음에 가장 많이 기록된 대량이체
      const top = [..._countBy(inWin, p => String(p.batch_id)).entries()].sort((a, b) => b[1] - a[1])[0];
      const p = inWin.find(x => String(x.batch_id) === top[0]);
      batch = { id: p.batch_id, seq: p.seq, createdBy: p.created_by };
    }
    c.rows.forEach(r => outsideAmounts.push(r.amount));
    return { c, own, inWin, batch };
  });
  const feeWorks = await _feeWorksByAmount(outsideAmounts);
  return pre.map(({ c, own, inWin, batch }) => buildClusterFacts({
    cluster: c, rows, openRec: own ? { ...own.rec } : null, batch,
    paidElsewhere: inWin.map(p => ({ amount: Number(p.amount) })), feeWorks, refundWindowMs: REFUND_WINDOW_MS,
  }));
}

/**
 * 통장 받은 뒤 부른다 — 묶음마다 확인거리를 만들거나 고친다. 사실이 같으면 문장을 다시 만들지 않는다(AI 호출 최소).
 * 확인거리가 사라진 묶음(빠진 사람을 고름 · 답 완료)은 '처리 완료'로 접는다.
 */
async function refreshBankChecks({ now = Date.now(), by = '' } = {}) {
  const all = await collectBankFacts({ now });
  const out = { created: 0, updated: 0, done: 0 };
  for (const f of all) {
    const ref = `${KIND_BANK}:${f.cluster.start}`;
    const { rows: [cur] } = await _db().query(`SELECT * FROM ops_checks WHERE ref_key = $1`, [ref]);
    if (!cur && !hasWork(f)) continue;
    const hash = factsHash(f);
    const manager = f.batch ? mapWorkManager(f.batch.createdBy) : '';
    if (cur && cur.facts_hash === hash) {
      const done = isDone(f, cur.answers);
      if (done !== (cur.status === 'done')) {
        // 읽은 뒤 직원이 답을 바꿨으면 건드리지 않는다(답 저장이 상태를 이미 정했다)
        const { rowCount } = await _db().query(
          `UPDATE ops_checks SET status = $2, done_at = $3, done_by = $4, updated_at = NOW() WHERE id = $1 AND answers = $5::jsonb`,
          [cur.id, done ? 'done' : 'open', done ? new Date(now).toISOString() : null, done ? (by || '자동') : '', JSON.stringify(cur.answers || {})]);
        if (done && rowCount) out.done++;
      }
      continue;
    }
    const { lines, source } = hasWork(f) ? await writeLines(f) : { lines: [], source: 'fallback' };
    // ★ AI 를 기다리는 사이 직원이 답을 저장했을 수 있다(Codex P2) — 쓰기 직전에 잠그고 **지금 답**을 다시 읽어 합친다.
    const client = await _db().connect();
    try {
      await client.query('BEGIN');
      const { rows: [now2] } = await client.query(`SELECT * FROM ops_checks WHERE ref_key = $1 FOR UPDATE`, [ref]);
      // 남아 있는 금액 묶음의 답은 그대로 둔다(사실이 조금 바뀌어도 직원 답을 지우지 않는다).
      const keep = {};
      const prev = (now2 && now2.answers) || {};
      for (const o of f.outside) if (prev[o.key]) keep[o.key] = prev[o.key];
      const done = isDone(f, keep);
      if (!now2) {
        await client.query(
          `INSERT INTO ops_checks (kind, ref_key, manager, facts, facts_hash, lines, text_source, answers, status, done_at, done_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11) ON CONFLICT (ref_key) DO NOTHING`,
          [KIND_BANK, ref, manager, JSON.stringify(f), hash, JSON.stringify(lines), source, JSON.stringify(keep),
            done ? 'done' : 'open', done ? new Date(now).toISOString() : null, done ? (by || '자동') : '']);
        out.created++;
      } else {
        await client.query(
          `UPDATE ops_checks SET manager = $2, facts = $3::jsonb, facts_hash = $4, lines = $5::jsonb, text_source = $6,
                  answers = $7::jsonb, status = $8, done_at = $9, done_by = $10, updated_at = NOW() WHERE id = $1`,
          [now2.id, manager, JSON.stringify(f), hash, JSON.stringify(lines), source, JSON.stringify(keep),
            done ? 'done' : 'open', done ? (now2.done_at || new Date(now).toISOString()) : null, done ? (now2.done_by || by || '자동') : '']);
        out.updated++;
        if (done && now2.status !== 'done') out.done++;
      }
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
  }
  return out;
}

function _view(r) {
  return {
    id: Number(r.id), kind: r.kind, manager: r.manager || '', facts: r.facts, lines: r.lines || [],
    textSource: r.text_source, answers: r.answers || {}, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at, doneBy: r.done_by || '',
  };
}

/** 목록 — 열린 것 전부 + 최근 2일 안에 끝난 것(방금 처리한 게 사라져 보이지 않게). */
async function listChecks({ includeDone = true } = {}) {
  const { rows } = await _db().query(
    `SELECT * FROM ops_checks
      WHERE status = 'open' OR ($1::bool AND done_at >= NOW() - INTERVAL '2 days')
      ORDER BY (status = 'open') DESC, created_at DESC LIMIT 50`, [!!includeDone]);
  return rows.map(_view);
}

/** 직원 답 — 기록 없이 나간 돈 묶음 하나에 「무슨 돈인가」+ 메모. */
async function answerCheck({ id, key, choice, memo, by }) {
  if (!Object.prototype.hasOwnProperty.call(CHOICES, choice)) throw new OpsCheckError('bad_choice', '답을 고르지 않았습니다.');
  const text = String(memo || '').trim().slice(0, 200);
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(`SELECT * FROM ops_checks WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw new OpsCheckError('not_found', '확인할 것을 찾을 수 없습니다. 새로고침해 주세요.');
    const f = r.facts || {};
    if (!(f.outside || []).some(o => o.key === key)) throw new OpsCheckError('bad_key', '이미 바뀐 항목입니다. 새로고침해 주세요.');
    const answers = { ...(r.answers || {}), [key]: { choice, memo: text, by: String(by || ''), at: new Date().toISOString() } };
    const done = isDone(f, answers);
    await client.query(
      `UPDATE ops_checks SET answers = $2::jsonb, status = $3, done_at = $4, done_by = $5, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(answers), done ? 'done' : 'open', done ? new Date().toISOString() : null, done ? String(by || '') : '']);
    await client.query('COMMIT');
    const { rows: [after] } = await _db().query(`SELECT * FROM ops_checks WHERE id = $1`, [id]);
    return _view(after);
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
}

module.exports = {
  KIND_BANK, CHOICES, SINCE_MS, OpsCheckError,
  buildClusterFacts, hasWork, expectedKeys, fallbackLines, validateAiLines, allowedNumbers, isDone, writeLines,
  collectBankFacts, refreshBankChecks, listChecks, answerCheck,
  __setPoolForTest, __setGenerateForTest,
};
