// ═══════════════════════════════════════════════════════════════════════════
// 작업 활동 시기 판정 — "이 작업이 언제 진행된 것인가"를 정해 과거 연도를 걸러낸다.
//
// 배경: 등록된 작업이 몇 년치 쌓여 점검 목록이 과거 데이터로 뒤덮였다(사용자 신고).
//   그런데 **탭 이름에는 연도가 없다**(`6/11퓨비아표백제_네이버15건`) — 이름만으로는
//   2025년 6월인지 2026년 6월인지 구분할 수 없다. 그래서 DB 신호로 판정한다.
//
// ★★ 쓰면 안 되는 신호(완화 금지):
//   · `raw_sheet_tabs.mirrored_at` — 미러가 돌 때마다 `NOW()` 로 갱신된다.
//   · `index_master.built_at`      — 빌드할 때마다 갱신된다.
//   둘 다 **2025년 작업에도 어제 시각이 찍혀** 전부 최신으로 보인다. 이걸 기준으로 삼으면
//   필터가 아무것도 걸러내지 못한다(있으나 마나 한 기능이 된다).
//
// ★ 쓰는 신호(전부 "그 작업이 실제로 진행된 시기"를 가리킨다):
//   ① 주문 제출 시각 `order_submissions.submitted_at` 최댓값 — 리뷰어가 실제로 낸 시각(가장 확실)
//   ② 연결 공고 생성일 `recruit_campaigns.created_at`
//   ③ 시트 구매일자 표본 `review_index.start_date` — **연도가 명시된 표기(`26.8.24`)일 때만**
//      (`6 / 11 (목)` 처럼 연도가 없으면 추론이 되어 신호로 쓸 수 없다 → 무시)
//   ④ 시트 등록일 `campaigns.created_at` — 시트 단위(같은 시트의 여러 탭이 같은 값)
//
// ★★ 판정값 = 신호들의 **최댓값**(가장 늦은 활동). 2025년에 등록됐어도 2026년에 주문이
//   들어왔으면 현재 작업이다 — 최솟값이나 단일 신호로 판정하면 살아있는 작업을 숨긴다.
// ★★ 신호가 하나도 없으면 **연도를 모르는 것**이지 과거가 아니다 → `unknown` 으로 분리해
//   화면이 건수를 고지하고 버튼 한 번으로 볼 수 있게 한다(조용한 누락 금지).
// ═══════════════════════════════════════════════════════════════════════════
const { parseDateToken } = require('./koreanDate');

// 기본 하한 — 이 날짜 이전 활동은 과거 자료로 보고 목록에서 제외(사용자 확정: 2026년부터).
const ACTIVITY_SINCE_DEFAULT = '2026-01-01';

// 두 점검(반영 점검·시트 우위 점검)이 **같은 신호**를 보도록 SQL 조각을 한 곳에 둔다.
//   ★ 사본을 두면 한쪽 화면만 과거를 걸러 "같은 작업이 여기선 보이고 저기선 안 보이는" 상태가 된다.
//   ★ 전제: 두 쿼리 모두 tab_configs 를 `tc` 로 별칭한다.
const ACTIVITY_LATERAL_SQL = `
       LEFT JOIN LATERAL (
         SELECT MAX(os.submitted_at) AS "lastOrderAt"
           FROM order_submissions os
          WHERE os.sheet_id = tc.sheet_id AND os.tab_name = tc.tab_name AND os.deleted_at IS NULL
       ) act_ord ON TRUE
       LEFT JOIN LATERAL (
         SELECT MAX(rc.created_at) AS "campCreatedAt"
           FROM recruit_campaigns rc
          WHERE rc.linked_sheet_id = tc.sheet_id
            AND (rc.linked_tab_name = tc.tab_name
                 OR (NULLIF(tc.tab_gid, '') IS NOT NULL AND rc.linked_tab_gid = tc.tab_gid))
       ) act_camp ON TRUE
       LEFT JOIN LATERAL (
         SELECT ri2.start_date AS "sampleStartDate"
           FROM review_index ri2
          WHERE ri2.sheet_id = tc.sheet_id AND ri2.tab_name = tc.tab_name
            AND NULLIF(ri2.start_date, '') IS NOT NULL
          ORDER BY ri2.row_index DESC LIMIT 1
       ) act_sd ON TRUE`;

const ACTIVITY_SELECT_SQL = `act_ord."lastOrderAt", act_camp."campCreatedAt", act_sd."sampleStartDate"`;

function _iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * 시트 구매일자 표본에서 **명시된 연도만** 뽑는다.
 * ★ 연도가 없는 표기(`6 / 11 (목)`)는 null — 추론으로 연도를 만들면 2025/2026 을 찍는 셈이 된다.
 */
function explicitYearDate(sampleStartDate) {
  const t = parseDateToken(String(sampleStartDate == null ? '' : sampleStartDate).trim());
  if (!t || t.y == null) return null;
  const mm = String(t.m || 1).padStart(2, '0');
  const dd = String(t.d || 1).padStart(2, '0');
  return `${t.y}-${mm}-${dd}`;
}

/**
 * 활동 시기 판정(순수함수 — 회귀가드가 직접 실행).
 * @returns {{activityAt: string|null, activitySource: string|null, yearUnknown: boolean}}
 */
function resolveActivity(r = {}) {
  const cands = [
    ['order', _iso(r.lastOrderAt)],          // 리뷰어 실제 제출
    ['campaign', _iso(r.campCreatedAt)],     // 연결 공고 생성
    ['sheet_date', explicitYearDate(r.sampleStartDate)],  // 구매일자(연도 명시분만)
    ['registered', _iso(r.registeredAt)],    // 시트 등록일(시트 단위)
  ].filter(([, v]) => !!v);
  if (!cands.length) return { activityAt: null, activitySource: null, yearUnknown: true };
  // 가장 늦은 활동이 그 작업의 시기 — 2025년 등록이어도 2026년 주문이 있으면 현재 작업이다.
  let best = cands[0];
  for (const c of cands) if (c[1] > best[1]) best = c;
  return { activityAt: best[1], activitySource: best[0], yearUnknown: false };
}

/** 'YYYY-MM-DD' 형식만 인정 — 아니면 기본값(형식 오류로 필터가 통째로 꺼지는 것 방지) */
function normalizeSince(since) {
  return (typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since)) ? since : ACTIVITY_SINCE_DEFAULT;
}

/**
 * 목록에 남길지 판정.
 * @returns {'keep'|'old'|'unknown'}  old/unknown 은 **건수를 고지**해야 한다(조용한 누락 금지).
 */
function activityVerdict(act, since, includeUnknown = false) {
  if (act.yearUnknown) return includeUnknown ? 'keep' : 'unknown';
  return act.activityAt >= since ? 'keep' : 'old';
}

module.exports = {
  ACTIVITY_SINCE_DEFAULT,
  ACTIVITY_LATERAL_SQL,
  ACTIVITY_SELECT_SQL,
  resolveActivity,
  explicitYearDate,
  normalizeSince,
  activityVerdict,
};
