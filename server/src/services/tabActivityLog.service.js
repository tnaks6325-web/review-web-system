/**
 * tabActivityLog.service.js — 작업(탭) 로그 (2026-08-23 사용자 확정 ⑥-㉮ 6종 전부)
 *
 * ★★ **신규 저장소 0** — 이미 쌓이고 있는 기록을 한 타임라인으로 모으기만 한다.
 *    새 이벤트 테이블을 만들면 "어떤 것은 여기, 어떤 것은 저기"로 갈리고 과거 기록이 비어 보인다.
 *
 * ★★ **읽기 전용** — 이 파일에는 쓰기 문장이 한 줄도 없다(회귀가드가 고정).
 *    되돌리기·수정은 각자의 자리에서 한다.
 *
 * ★ 소스별 조회는 **독립**이다 — 하나가 실패해도 나머지는 나오고, 실패한 종류는
 *   `failed[]` 로 **말한다**(0건으로 꾸미면 "아무 일도 없었다"로 읽힌다).
 */
const { logger } = require('../utils/logger');

/** 유형 — 화면 탭이 이 목록을 그대로 그린다(라벨 사본 0). */
const LOG_KINDS = [
  { key: 'order',  label: '주문' },
  { key: 'cancel', label: '취소' },
  { key: 'review', label: '리뷰' },
  { key: 'edit',   label: '편집' },
  { key: 'quota',  label: '정원' },
  { key: 'money',  label: '정산' },
  { key: 'sys',    label: '시스템' },
];
const LOG_KIND_KEYS = LOG_KINDS.map(k => k.key);

const _clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const _num = (v) => (v === 0 || v ? Number(v) : null);

/* ── 소스 정의 ────────────────────────────────────────────────
   각 항목: { key, kinds, run(db, ctx) → [{at, kind, message, who, ref}] }
   ★ 모든 쿼리에 `LIMIT` 을 건다 — 한 소스가 목록을 통째로 먹지 않게. */
const SOURCES = [
  {
    key: 'orders',
    kinds: ['order', 'cancel'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT id, sheet_row, COALESCE(NULLIF(recipient,''), orderer, '') AS name,
                price, submitted_at, deleted_at, canceled_by
           FROM order_submissions
          WHERE sheet_id=$1 AND tab_name=$2
          ORDER BY GREATEST(COALESCE(deleted_at, to_timestamp(0)), COALESCE(submitted_at, to_timestamp(0))) DESC
          LIMIT $3`, [sheetId, tabName, limit]);
      const out = [];
      rows.forEach(r => {
        if (r.submitted_at) out.push({
          at: r.submitted_at, kind: 'order',
          message: `구매양식 접수 — ${_clip(r.name, 40) || '이름 없음'}`,
          who: `리뷰어${r.sheet_row ? ` · ${r.sheet_row}행` : ''}${r.price ? ` · 결제금액 ${_clip(r.price, 20)}` : ''}`,
        });
        if (r.deleted_at) {
          /* ★ 누가 취소했는지 그대로 말한다 — `canceled_by` 는 `reviewer:1234`·`dedupe:…`·담당자명이다.
             "취소됨"만 적으면 리뷰어 자발 취소와 정리 도구를 구분할 수 없다. */
          const by = String(r.canceled_by || '');
          const whoLabel = /^reviewer:/i.test(by) ? '리뷰어 본인'
            : /^dedupe/i.test(by) ? '중복 정리'
            : (by || '담당자');
          out.push({
            at: r.deleted_at, kind: 'cancel',
            message: `주문 취소 — ${_clip(r.name, 40) || '이름 없음'}`,
            who: `${whoLabel}${r.sheet_row ? ` · ${r.sheet_row}행` : ''}`,
          });
        }
      });
      return out;
    },
  },
  {
    key: 'reviewer_events',
    kinds: ['cancel', 'sys'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT occurred_at, event_type, severity, message, reviewer_name, context
           FROM reviewer_event_logs
          WHERE sheet_id=$1 AND tab_name=$2
          ORDER BY occurred_at DESC LIMIT $3`, [sheetId, tabName, limit]);
      return rows.map(r => ({
        at: r.occurred_at,
        kind: r.event_type === 'order_canceled_by_reviewer' ? 'cancel' : 'sys',
        message: _clip(r.message, 300),
        who: [r.severity === 'critical' ? '⚠ 중요' : '시스템', _clip(r.reviewer_name, 40),
          (r.context && r.context.rowIndex) ? `${r.context.rowIndex}행` : ''].filter(Boolean).join(' · '),
      }));
    },
  },
  {
    key: 'review_submissions',
    kinds: ['review'],
    async run(db, { sheetId, tabName, limit }) {
      // 한 사람이 여러 장을 올려도 **제출 한 번**으로 접는다(장 수는 함께 말한다).
      const { rows } = await db.query(
        `SELECT MAX(uploaded_at) AS at, row_index, reviewer_name, COUNT(*)::int AS n
           FROM review_submissions
          WHERE sheet_id=$1 AND tab_name=$2 AND uploaded_at IS NOT NULL
          GROUP BY row_index, reviewer_name
          ORDER BY MAX(uploaded_at) DESC LIMIT $3`, [sheetId, tabName, limit]);
      return rows.map(r => ({
        at: r.at, kind: 'review',
        message: `리뷰 캡처 제출 — ${_clip(r.reviewer_name, 40) || '이름 없음'}`,
        who: `리뷰어${r.row_index ? ` · ${r.row_index}행` : ''} · ${r.n}장`,
      }));
    },
  },
  {
    key: 'inspections',
    kinds: ['review'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT COALESCE(resolved_at, updated_at, created_at) AS at,
                status, resolution, reviewer_name, row_index, resolved_by
           FROM review_inspections
          WHERE sheet_id=$1 AND tab_name=$2 AND status IN ('fail','suspect','resolved')
          ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC LIMIT $3`, [sheetId, tabName, limit]);
      const lab = { fail: '불량', suspect: '의심', resolved: '확인 완료' };
      return rows.map(r => ({
        at: r.at, kind: 'review',
        message: `리뷰 캡처 검수 — ${lab[r.status] || r.status}${r.resolution === 'ok' ? '(정상으로 종결)' : r.resolution === 'bad' ? '(불량으로 종결)' : ''}`,
        who: [_clip(r.resolved_by, 40) || '시스템', _clip(r.reviewer_name, 40), r.row_index ? `${r.row_index}행` : ''].filter(Boolean).join(' · '),
      }));
    },
  },
  {
    key: 'edits',
    kinds: ['edit'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT created_at, reverted_at, field, kind, value_text, value_bool, created_by, reverted_by
           FROM participant_edits
          WHERE sheet_id=$1 AND tab_name=$2
          ORDER BY GREATEST(created_at, COALESCE(reverted_at, created_at)) DESC LIMIT $3`,
        [sheetId, tabName, limit]);
      const fieldLabel = (f) => String(f || '').replace(/^col:/, '').replace(/^ccol:.*$/, '추가 열');
      const out = [];
      rows.forEach(r => {
        const v = r.kind === 'bool' ? (r.value_bool ? '켬' : '끔') : _clip(r.value_text, 60);
        out.push({ at: r.created_at, kind: 'edit',
          message: `표 편집 — ${fieldLabel(r.field)} → “${v}”`, who: _clip(r.created_by, 40) || '담당자' });
        if (r.reverted_at) out.push({ at: r.reverted_at, kind: 'edit',
          message: `표 편집 되돌리기 — ${fieldLabel(r.field)}`, who: _clip(r.reverted_by, 40) || '담당자' });
      });
      return out;
    },
  },
  {
    key: 'plans',
    kinds: ['quota'],
    async run(db, { sheetId, tabName, gid, limit }) {
      /* 정원은 **공고**에 매달려 있어 그 탭에 연결된 공고를 거쳐 찾는다(이름 → gid 폴백).
         ★ 빈 gid 는 절을 켜지 않는다 — 켜면 gid 없는 공고가 전부 매칭된다. */
      const { rows } = await db.query(
        `SELECT e.created_at AS at, e.action, e.detail, e.actor
           FROM campaign_plan_events e
           JOIN recruit_campaigns rc ON rc.id = e.campaign_id
          WHERE rc.linked_sheet_id=$1
            AND (rc.linked_tab_name=$2 OR ($3 <> '' AND rc.linked_tab_gid=$3))
          ORDER BY e.created_at DESC LIMIT $4`, [sheetId, tabName, String(gid || ''), limit]);
      const lab = {
        plan_save: '날짜별 인원 조절', carry_apply: '이월 반영',
        round_add: '차수 추가', round_remove: '차수 제거',
        worktable_rebuild: '작업표 재구성', participant_delete_replenish: '행 삭제 보충',
      };
      return rows.map(r => {
        const d = (r.detail && typeof r.detail === 'object') ? r.detail : {};
        const n = Array.isArray(d.set) ? d.set.length : null;
        return {
          at: r.at, kind: 'quota',
          message: `${lab[r.action] || r.action}${n ? ` — ${n}일치` : ''}${_num(d.amount) != null ? ` ${d.amount}명` : ''}`,
          who: _clip(r.actor, 40) || '담당자',
        };
      });
    },
  },
  {
    key: 'payments',
    kinds: ['money'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT MAX(paid_at) AS at, batch_id, COUNT(*)::int AS n
           FROM payment_batch_items
          WHERE sheet_id=$1 AND tab_name=$2 AND status='paid' AND paid_at IS NOT NULL
          GROUP BY batch_id
          ORDER BY MAX(paid_at) DESC LIMIT $3`, [sheetId, tabName, limit]);
      return rows.map(r => ({
        at: r.at, kind: 'money',
        message: `리뷰비 입금 반영 — 이 작업 ${r.n}건`,
        who: '입금관리',
      }));
    },
  },
  {
    key: 'finished',
    kinds: ['money'],
    async run(db, { sheetId, tabName, limit }) {
      const { rows } = await db.query(
        `SELECT finished_at, deleted_at, finished_by, reopened_by
           FROM trackb_tab_finished
          WHERE sheet_id=$1 AND tab_name=$2
          ORDER BY finished_at DESC LIMIT $3`, [sheetId, tabName, limit]);
      const out = [];
      rows.forEach(r => {
        if (r.finished_at) out.push({ at: r.finished_at, kind: 'money', message: '작업 마감', who: _clip(r.finished_by, 40) || '담당자' });
        if (r.deleted_at) out.push({ at: r.deleted_at, kind: 'money', message: '마감 복귀', who: _clip(r.reopened_by, 40) || '담당자' });
      });
      return out;
    },
  },
];

/**
 * 작업 로그 — 소스별 독립 조회 후 시간순 병합.
 * @returns {{ok:true, items:[], failed:[], kinds:[], truncated:boolean}}
 */
async function tabActivityLog({ sheetId, tabName, gid = '', kind = 'all', limit = 60, pool } = {}) {
  const db = pool || require('../db/pool');
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName 필수' };
  const want = LOG_KIND_KEYS.includes(String(kind)) ? String(kind) : 'all';
  const cap = Math.min(Math.max(parseInt(limit, 10) || 60, 10), 300);
  const perSource = cap + 20;   // 병합 후 잘리므로 소스마다 조금 넉넉히

  const targets = SOURCES.filter(s => want === 'all' || s.kinds.includes(want));
  const failed = [];
  const settled = await Promise.all(targets.map(async (s) => {
    try { return await s.run(db, { sheetId, tabName, gid, limit: perSource }); }
    catch (e) {
      // ★ 실패를 빈 배열로 접지 않는다 — 화면이 "조회 실패"라고 말해야 한다.
      logger.warn(`[tab-log] ${s.key} 조회 실패 tab=${tabName}: ${(e && e.message) || e}`);
      failed.push(s.key);
      return [];
    }
  }));

  let items = settled.flat()
    .filter(x => x && x.at && (want === 'all' || x.kind === want))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const truncated = items.length > cap;
  items = items.slice(0, cap).map(x => ({ at: x.at, kind: x.kind, message: x.message, who: x.who || '' }));
  return { ok: true, items, failed, kinds: LOG_KINDS, truncated };
}

module.exports = { LOG_KINDS, LOG_KIND_KEYS, tabActivityLog };
