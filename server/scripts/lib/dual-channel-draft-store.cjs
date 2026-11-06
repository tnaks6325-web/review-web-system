'use strict';

// Development-only, ephemeral PostgreSQL. Never import the application pool or dotenv.
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('node:crypto');
const { normalizeDualChannelProduct } = require('../../src/utils/dualChannel');

class DraftError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bad = message => { throw new DraftError(400, 'invalid_draft', message); };

function integer(value, label, min = 0) {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(n) || n < min || n > 100000) bad(`${label}은 ${min}~100000 범위의 정수여야 합니다.`);
  return n;
}
function rejectLinks(value, depth = 0) {
  if (depth > 40) bad('중첩된 자료가 너무 깊습니다.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:linked_|source_work_order_id$|work_order_id$|bidir$|__proto__$|constructor$|prototype$)/.test(key)) {
      bad('기존 작업 연결이나 내부 전용 항목은 로컬 초안에서 받지 않습니다.');
    }
    rejectLinks(child, depth + 1);
  }
}
function normalizedDraft(body, current) {
  if (!plain(body)) bad('요청은 객체여야 합니다.');
  const allowed = ['title', 'status', 'channel', 'recruit_total', 'daily_limit', 'work_detail'];
  if (Object.keys(body).some(k => !allowed.includes(k))) bad('허용되지 않은 공고 항목이 있습니다.');
  rejectLinks(body);
  if (own(body, 'status') && body.status !== 'draft') bad('로컬 임시저장 상태만 허용합니다.');
  if (own(body, 'channel') && body.channel !== '네이버+쿠팡') bad('네이버+쿠팡 설정만 허용합니다.');
  if (own(body, 'work_detail') && !plain(body.work_detail)) bad('작업 안내는 객체여야 합니다.');
  const title = own(body, 'title') ? body.title : current?.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 500) bad('제목은 비어 있지 않은 500자 이하 글이어야 합니다.');
  const wd = { ...(current?.work_detail || {}), ...(body.work_detail || {}) };
  const p = normalizeDualChannelProduct(wd.dualChannelProduct);
  if (p.option_schema_version !== 2) bad('상품 설정 버전은 숫자 2여야 합니다.');
  let url;
  try { url = new URL(p.url); } catch (_) { bad('상품 주소가 올바르지 않습니다.'); }
  if (typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url.trim())
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || p.url.length > 2048) bad('상품 주소가 올바르지 않습니다.');
  const daily = own(p.base, 'daily') ? integer(p.base.daily, '상품 일일 인원') : 0;
  wd.dualChannelProduct = { ...p, url: p.url.trim(), base: { ...p.base, daily } };
  const count = integer(own(body, 'recruit_total') ? body.recruit_total : current?.recruit_total ?? p.base.count, '모집 인원', 1);
  const limit = integer(own(body, 'daily_limit') ? body.daily_limit : current?.daily_limit ?? daily, '일일 인원');
  if (count !== p.base.count) bad('모집 인원과 상품 인원이 같아야 합니다.');
  if (limit !== daily) bad('일일 인원과 상품 일일 인원이 같아야 합니다.');
  return { title, wd, count, limit };
}

async function createDraftStore() {
  // No configurable connection string/data directory: the database cannot target actual PG.
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE recruit_campaigns (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status='draft'),
      channel TEXT NOT NULL CHECK(channel='네이버+쿠팡'),
      recruit_total INTEGER NOT NULL CHECK(recruit_total > 0), daily_limit INTEGER NOT NULL CHECK(daily_limit >= 0),
      work_detail JSONB NOT NULL CHECK(jsonb_typeof(work_detail)='object'),
      linked_sheet_id TEXT NOT NULL DEFAULT '' CHECK(linked_sheet_id=''),
      linked_tab_name TEXT NOT NULL DEFAULT '' CHECK(linked_tab_name=''),
      linked_tab_gid TEXT NOT NULL DEFAULT '' CHECK(linked_tab_gid=''),
      source_work_order_id TEXT NOT NULL DEFAULT '' CHECK(source_work_order_id=''),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  } catch (error) { await db.close(); throw error; }

  async function read(id) {
    const row = (await db.query('SELECT * FROM recruit_campaigns WHERE id=$1', [id])).rows[0];
    if (!row) throw new DraftError(404, 'draft_not_found', '로컬 임시저장을 찾을 수 없습니다.');
    return row;
  }

  async function save(body, id) {
    return db.transaction(async tx => {
      const current = id ? (await tx.query('SELECT * FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [id])).rows[0] : null;
      if (id && !current) throw new DraftError(404, 'draft_not_found', '로컬 임시저장을 찾을 수 없습니다.');
      const { title, wd, count, limit } = normalizedDraft(body, current);
      const values = [id || 'local-dual-' + randomUUID(), title, count, limit, JSON.stringify(wd)];
      const sql = current
        ? `UPDATE recruit_campaigns SET title=$2,recruit_total=$3,daily_limit=$4,work_detail=$5::jsonb,updated_at=NOW()
            WHERE id=$1 RETURNING *`
        : `INSERT INTO recruit_campaigns(id,title,status,channel,recruit_total,daily_limit,work_detail)
            VALUES ($1,$2,'draft','네이버+쿠팡',$3,$4,$5::jsonb) RETURNING *`;
      return (await tx.query(sql, values)).rows[0];
    });
  }
  return { db, read, save, close: () => db.close() };
}

module.exports = { createDraftStore, DraftError };
