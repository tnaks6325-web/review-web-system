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
 *
 * ★★ **과거로 이어 붙이기(무한 스크롤) — 커서 `before` (2026-08-24 사용자 확정)**
 *    "최근 N건만"에서 **처음까지 전부**로 바뀌었다. 화면이 아래로 내려가면 `before`(= 지금까지
 *    보여준 것 중 가장 오래된 항목의 시각)를 들고 다시 물어 **더 과거**를 이어 받는다.
 *    ★ 그래서 이 파일의 두 가지 규율이 새로 생겼다:
 *      ① **한 행 = 한 항목** — 한 행이 두 시각(접수/취소 · 편집/되돌리기 · 마감/복귀)을 내면
 *         행 단위 커서로는 **한쪽이 조용히 사라진다**(커서가 두 시각 사이에 놓이는 순간 옛 항목이
 *         영영 안 나온다) → 그런 소스는 **UNION ALL 로 항목 단위로 편다**.
 *      ② **유형(kind) 조건은 SQL 로 내린다** — JS 에서만 거르면 `[취소]` 탭에서 LIMIT 이
 *         접수 행으로 다 차 **그 페이지가 0건**이 되고 커서가 제자리에 멈춘다.
 *    ★ 경계 시각이 겹치는 항목을 잃지 않도록 커서는 `<=`(엄격 부등호 아님)이고,
 *      대신 **항목마다 `id`(각 표의 PK 파생)를 발급**해 화면이 이미 받은 것을 걸러낸다.
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
   각 항목: { key, kinds, run(db, ctx) → { items:[{id, at, kind, message, who}], hitLimit } }
   ★ 모든 소스 쿼리에 `LIMIT` 을 건다 — 한 소스가 목록을 통째로 먹지 않게.
   ★ 커서 절은 "값이 없으면 통과, 있으면 그 시각 이하"이고 **정렬 기준과 같은 식**을 써야 한다 —
     다른 식을 쓰면 페이지 경계에서 항목이 샌다. */
const SOURCES = [
  {
    key: 'orders',
    kinds: ['order', 'cancel'],
    async run(db, { sheetId, tabName, limit, before, want }) {
      /* ★ 한 행이 접수·취소 두 항목을 내므로 **UNION ALL 로 항목 단위로 편다**(위 ① 규율). */
      const { rows } = await db.query(
        `SELECT x.id, x.sheet_row, x.name, x.price, x.canceled_by, x.ev, x.at FROM (
            SELECT id, sheet_row, COALESCE(NULLIF(recipient,''), orderer, '') AS name,
                   price, canceled_by, 'order'::text AS ev, submitted_at AS at
              FROM order_submissions
             WHERE sheet_id=$1 AND tab_name=$2 AND submitted_at IS NOT NULL
            UNION ALL
            SELECT id, sheet_row, COALESCE(NULLIF(recipient,''), orderer, '') AS name,
                   price, canceled_by, 'cancel'::text AS ev, deleted_at AS at
              FROM order_submissions
             WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NOT NULL
          ) x
          WHERE ($4::text = 'all' OR x.ev = $4::text)
            AND ($5::timestamptz IS NULL OR x.at <= $5::timestamptz)
          ORDER BY x.at DESC
          LIMIT $3`, [sheetId, tabName, limit, want, before]);
      const items = rows.map(r => {
        if (r.ev === 'order') return {
          id: `o:${r.id}:n`, at: r.at, kind: 'order',
          message: `구매양식 접수 — ${_clip(r.name, 40) || '이름 없음'}`,
          who: `리뷰어${r.sheet_row ? ` · ${r.sheet_row}행` : ''}${r.price ? ` · 결제금액 ${_clip(r.price, 20)}` : ''}`,
        };
        /* ★ 누가 취소했는지 그대로 말한다 — `canceled_by` 는 `reviewer:1234`·`dedupe:…`·담당자명이다.
           "취소됨"만 적으면 리뷰어 자발 취소와 정리 도구를 구분할 수 없다. */
        const by = String(r.canceled_by || '');
        const whoLabel = /^reviewer:/i.test(by) ? '리뷰어 본인'
          : /^dedupe/i.test(by) ? '중복 정리'
          : (by || '담당자');
        return {
          id: `o:${r.id}:c`, at: r.at, kind: 'cancel',
          message: `주문 취소 — ${_clip(r.name, 40) || '이름 없음'}`,
          who: `${whoLabel}${r.sheet_row ? ` · ${r.sheet_row}행` : ''}`,
        };
      });
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'reviewer_events',
    kinds: ['cancel', 'sys'],
    async run(db, { sheetId, tabName, limit, before, want }) {
      /* ★ 유형 조건을 SQL 로 내린다(위 ② 규율) — JS 에서만 거르면 그 페이지가 통째로 빌 수 있다. */
      const { rows } = await db.query(
        `SELECT id, occurred_at, event_type, severity, message, reviewer_name, context
           FROM reviewer_event_logs
          WHERE sheet_id=$1 AND tab_name=$2
            AND ($4::text = 'all'
                 OR ($4::text = 'cancel' AND event_type = 'order_canceled_by_reviewer')
                 OR ($4::text = 'sys'    AND event_type <> 'order_canceled_by_reviewer'))
            AND ($5::timestamptz IS NULL OR occurred_at <= $5::timestamptz)
          ORDER BY occurred_at DESC LIMIT $3`, [sheetId, tabName, limit, want, before]);
      const items = rows.map(r => ({
        id: `rel:${r.id}`,
        at: r.occurred_at,
        kind: r.event_type === 'order_canceled_by_reviewer' ? 'cancel' : 'sys',
        message: _clip(r.message, 300),
        who: [r.severity === 'critical' ? '⚠ 중요' : '시스템', _clip(r.reviewer_name, 40),
          (r.context && r.context.rowIndex) ? `${r.context.rowIndex}행` : ''].filter(Boolean).join(' · '),
      }));
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'review_submissions',
    kinds: ['review'],
    async run(db, { sheetId, tabName, limit, before }) {
      // 한 사람이 여러 장을 올려도 **제출 한 번**으로 접는다(장 수는 함께 말한다).
      const { rows } = await db.query(
        `SELECT MAX(uploaded_at) AS at, row_index, reviewer_name, COUNT(*)::int AS n
           FROM review_submissions
          WHERE sheet_id=$1 AND tab_name=$2 AND uploaded_at IS NOT NULL
          GROUP BY row_index, reviewer_name
         HAVING ($4::timestamptz IS NULL OR MAX(uploaded_at) <= $4::timestamptz)
          ORDER BY MAX(uploaded_at) DESC LIMIT $3`, [sheetId, tabName, limit, before]);
      const items = rows.map(r => ({
        id: `rs:${r.row_index == null ? '-' : r.row_index}:${_clip(r.reviewer_name, 40)}`,
        at: r.at, kind: 'review',
        message: `리뷰 캡처 제출 — ${_clip(r.reviewer_name, 40) || '이름 없음'}`,
        who: `리뷰어${r.row_index ? ` · ${r.row_index}행` : ''} · ${r.n}장`,
      }));
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'inspections',
    kinds: ['review'],
    async run(db, { sheetId, tabName, limit, before }) {
      const { rows } = await db.query(
        `SELECT id, COALESCE(resolved_at, updated_at, created_at) AS at,
                status, resolution, reviewer_name, row_index, resolved_by
           FROM review_inspections
          WHERE sheet_id=$1 AND tab_name=$2 AND status IN ('fail','suspect','resolved')
            AND ($4::timestamptz IS NULL OR COALESCE(resolved_at, updated_at, created_at) <= $4::timestamptz)
          ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC LIMIT $3`, [sheetId, tabName, limit, before]);
      const lab = { fail: '불량', suspect: '의심', resolved: '확인 완료' };
      const items = rows.map(r => ({
        id: `ri:${r.id}`,
        at: r.at, kind: 'review',
        message: `리뷰 캡처 검수 — ${lab[r.status] || r.status}${r.resolution === 'ok' ? '(정상으로 종결)' : r.resolution === 'bad' ? '(불량으로 종결)' : ''}`,
        who: [_clip(r.resolved_by, 40) || '시스템', _clip(r.reviewer_name, 40), r.row_index ? `${r.row_index}행` : ''].filter(Boolean).join(' · '),
      }));
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'edits',
    kinds: ['edit'],
    async run(db, { sheetId, tabName, limit, before }) {
      /* ★ 편집·되돌리기 두 항목 → UNION ALL 로 항목 단위(위 ① 규율). */
      const { rows } = await db.query(
        `SELECT x.id, x.field, x.kind, x.value_text, x.value_bool, x.actor, x.ev, x.at FROM (
            SELECT id, field, kind, value_text, value_bool, created_by AS actor,
                   'new'::text AS ev, created_at AS at
              FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND created_at IS NOT NULL
            UNION ALL
            SELECT id, field, kind, value_text, value_bool, reverted_by AS actor,
                   'rev'::text AS ev, reverted_at AS at
              FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NOT NULL
          ) x
          WHERE ($4::timestamptz IS NULL OR x.at <= $4::timestamptz)
          ORDER BY x.at DESC
          LIMIT $3`, [sheetId, tabName, limit, before]);
      const fieldLabel = (f) => String(f || '').replace(/^col:/, '').replace(/^ccol:.*$/, '추가 열');
      const items = rows.map(r => {
        if (r.ev === 'rev') return {
          id: `pe:${r.id}:r`, at: r.at, kind: 'edit',
          message: `표 편집 되돌리기 — ${fieldLabel(r.field)}`, who: _clip(r.actor, 40) || '담당자',
        };
        const v = r.kind === 'bool' ? (r.value_bool ? '켬' : '끔') : _clip(r.value_text, 60);
        return {
          id: `pe:${r.id}:n`, at: r.at, kind: 'edit',
          message: `표 편집 — ${fieldLabel(r.field)} → “${v}”`, who: _clip(r.actor, 40) || '담당자',
        };
      });
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'plans',
    kinds: ['quota'],
    async run(db, { sheetId, tabName, gid, limit, before }) {
      /* 정원은 **공고**에 매달려 있어 그 탭에 연결된 공고를 거쳐 찾는다(이름 → gid 폴백).
         ★ 빈 gid 는 절을 켜지 않는다 — 켜면 gid 없는 공고가 전부 매칭된다. */
      const { rows } = await db.query(
        `SELECT e.id, e.created_at AS at, e.action, e.detail, e.actor
           FROM campaign_plan_events e
           JOIN recruit_campaigns rc ON rc.id = e.campaign_id
          WHERE rc.linked_sheet_id=$1
            AND (rc.linked_tab_name=$2 OR ($3 <> '' AND rc.linked_tab_gid=$3))
            AND ($5::timestamptz IS NULL OR e.created_at <= $5::timestamptz)
          ORDER BY e.created_at DESC LIMIT $4`, [sheetId, tabName, String(gid || ''), limit, before]);
      const lab = {
        plan_save: '날짜별 인원 조절', carry_apply: '이월 반영',
        round_add: '차수 추가', round_remove: '차수 제거',
        worktable_rebuild: '작업표 재구성', participant_delete_replenish: '행 삭제 보충',
      };
      const items = rows.map(r => {
        const d = (r.detail && typeof r.detail === 'object') ? r.detail : {};
        const n = Array.isArray(d.set) ? d.set.length : null;
        return {
          id: `cpe:${r.id}`,
          at: r.at, kind: 'quota',
          message: `${lab[r.action] || r.action}${n ? ` — ${n}일치` : ''}${_num(d.amount) != null ? ` ${d.amount}명` : ''}`,
          who: _clip(r.actor, 40) || '담당자',
        };
      });
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'payments',
    kinds: ['money'],
    async run(db, { sheetId, tabName, limit, before }) {
      const { rows } = await db.query(
        `SELECT MAX(paid_at) AS at, batch_id, COUNT(*)::int AS n
           FROM payment_batch_items
          WHERE sheet_id=$1 AND tab_name=$2 AND status='paid' AND paid_at IS NOT NULL
          GROUP BY batch_id
         HAVING ($4::timestamptz IS NULL OR MAX(paid_at) <= $4::timestamptz)
          ORDER BY MAX(paid_at) DESC LIMIT $3`, [sheetId, tabName, limit, before]);
      const items = rows.map(r => ({
        id: `pb:${r.batch_id}`,
        at: r.at, kind: 'money',
        message: `리뷰비 입금 반영 — 이 작업 ${r.n}건`,
        who: '입금관리',
      }));
      return { items, hitLimit: rows.length >= limit };
    },
  },
  {
    key: 'finished',
    kinds: ['money'],
    async run(db, { sheetId, tabName, limit, before }) {
      /* ★ 마감·복귀 두 항목 → UNION ALL 로 항목 단위(위 ① 규율). */
      const { rows } = await db.query(
        `SELECT x.id, x.actor, x.ev, x.at FROM (
            SELECT id, finished_by AS actor, 'fin'::text AS ev, finished_at AS at
              FROM trackb_tab_finished
             WHERE sheet_id=$1 AND tab_name=$2 AND finished_at IS NOT NULL
            UNION ALL
            SELECT id, reopened_by AS actor, 'reo'::text AS ev, deleted_at AS at
              FROM trackb_tab_finished
             WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NOT NULL
          ) x
          WHERE ($4::timestamptz IS NULL OR x.at <= $4::timestamptz)
          ORDER BY x.at DESC
          LIMIT $3`, [sheetId, tabName, limit, before]);
      const items = rows.map(r => (r.ev === 'fin'
        ? { id: `tf:${r.id}:f`, at: r.at, kind: 'money', message: '작업 마감', who: _clip(r.actor, 40) || '담당자' }
        : { id: `tf:${r.id}:r`, at: r.at, kind: 'money', message: '마감 복귀', who: _clip(r.actor, 40) || '담당자' }));
      return { items, hitLimit: rows.length >= limit };
    },
  },
];

/** 커서 파싱 — 못 읽는 값은 **없는 것으로 접는다**(잘못된 값 때문에 목록이 통째로 비지 않게). */
function _parseBefore(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 작업 로그 — 소스별 독립 조회 후 시간순 병합.
 * @param {string} [before] 이 시각 **이하**(`<=`)의 기록만 — 화면이 아래로 내려갈 때 더 과거를 이어 받는다.
 * @returns {{ok:true, items:[], failed:[], kinds:[], hasMore:boolean, nextBefore:string|null, truncated:boolean}}
 */
async function tabActivityLog({ sheetId, tabName, gid = '', kind = 'all', limit = 60, before = null, pool } = {}) {
  const db = pool || require('../db/pool');
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName 필수' };
  const want = LOG_KIND_KEYS.includes(String(kind)) ? String(kind) : 'all';
  const cap = Math.min(Math.max(parseInt(limit, 10) || 60, 10), 300);
  const perSource = cap + 20;   // 병합 후 잘리므로 소스마다 조금 넉넉히
  const cursor = _parseBefore(before);

  const targets = SOURCES.filter(s => want === 'all' || s.kinds.includes(want));
  const failed = [];
  let anyHitLimit = false;
  const settled = await Promise.all(targets.map(async (s) => {
    try {
      const out = await s.run(db, { sheetId, tabName, gid, limit: perSource, before: cursor, want });
      const list = (out && out.items) || [];
      if (out && out.hitLimit) anyHitLimit = true;
      return list;
    }
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
  /* ★ 더 있는가 = 잘렸거나(병합 결과가 한 페이지보다 많다) 어느 소스든 자기 LIMIT 을 채웠다.
     모르면 "더 있다" 쪽으로 접는다 — 다음 요청이 0건이면 화면이 그때 끝을 말한다(끝을 지어내지 않는다). */
  const hasMore = items.length > cap || anyHitLimit;
  items = items.slice(0, cap).map(x => ({ id: x.id || '', at: x.at, kind: x.kind, message: x.message, who: x.who || '' }));
  /* ★ 다음 커서는 **지금 페이지의 가장 오래된 항목 시각**이고 `<=` 로 다시 묻는다(경계 동시각 유실 방지).
     그래서 겹치는 항목이 다시 오며, 화면은 `id` 로 이미 받은 것을 걸러낸다. */
  const last = items.length ? items[items.length - 1] : null;
  const nextBefore = (hasMore && last && last.at) ? new Date(last.at).toISOString() : null;
  return { ok: true, items, failed, kinds: LOG_KINDS, hasMore, nextBefore, truncated: hasMore };
}

module.exports = { LOG_KINDS, LOG_KIND_KEYS, tabActivityLog };
