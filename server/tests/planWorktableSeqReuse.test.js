/**
 * 모집인원 조절 → 작업표 반영 회귀가드 (2026-08-19)
 *
 * ① 🔴 새 준비 행의 번호(seq)는 **지운 줄까지 포함한 최대값 + 1** 에서 시작한다.
 *    uq_participants_seq(sheet_id, tab_name, seq) 에는 소프트 삭제·비활성 행이 그대로 들어 있고,
 *    116 의 삭제 표식은 "그 번호를 되살리지 말라"는 기록이다. 활성 행만 보고 번호를 매기면
 *    [🧹 줄 정리]로 뒤쪽 줄을 지운 탭에서 인원을 늘리는 순간 23505 로 **저장이 통째로 실패**한다.
 * ② 작업표가 안 바뀐 저장(무시트 전환 누락)을 "완료"로 뭉뚱그리지 않는다.
 * ③ 모달 기준선(readWorktableDates)은 그리드·조절 실행과 같은 active 기준으로 센다.
 *
 * 실행: node tests/planWorktableSeqReuse.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

const svc = require('../src/services/sheetlessDailyPlan.service');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessDailyPlan.service.js'), 'utf8');
const planSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignPlan.service.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');

/* ── ① seq 재사용 차단 — 실제 실행 ─────────────────────────── */
async function runSeqCase() {
  const today = '2026-08-19';
  // 활성 준비 행 2개(seq 1,2). seq 3·4 는 [줄 정리]로 소프트 삭제됐고 5 는 삭제 표식만 남았다.
  const active = [
    { id: 'r1', seq: 1, tab_gid: '1', reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null, row_json: { '구매일자': '8/19 (수)' } },
    { id: 'r2', seq: 2, tab_gid: '1', reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null, row_json: { '구매일자': '8/19 (수)' } },
  ];
  const inserts = [];
  let sawMaxQuery = false;
  const client = {
    query: async (sql, params) => {
      const q = String(sql);
      if (q.includes('FROM campaign_participants') && q.includes('FOR UPDATE')) return { rows: active };
      if (q.includes('workdesk_participant_deletions')) { sawMaxQuery = true; return { rows: [{ max_seq: 5 }] }; }
      if (q.includes('INSERT INTO campaign_participants')) { inserts.push(params[3]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const r = await svc.syncAdjustedPlansToWorktable({
    client, sheetId: 'S1', tabName: 'T1', today,
    set: [{ date: '2026-08-25', count: 3 }],
  });
  return { r, inserts, sawMaxQuery };
}

(async () => {
  const m = await runSeqCase();
  const r = m.r;

  ok('★ 지운 줄까지 포함한 최대 번호를 조회한다(활성 행만 보지 않는다)', m.sawMaxQuery === true);
  ok('★ 새 준비 행은 6번부터 — 지운 3·4·5 번을 재사용하지 않는다(23505·되살아남 차단)',
    r.created === 3 && m.inserts.join(',') === '6,7,8');
  ok('두 생성 경로 모두 같은 헬퍼를 쓴다(사본 금지)',
    (src.match(/await _nextSeqStart\(client, sheetId, tabName\)/g) || []).length === 2
    && !/rows\.reduce\(\(m, r\) => Math\.max\(m, Number\(r\.seq\)/.test(src));

  /* ── ② 표가 안 바뀐 저장은 사실대로 말한다 ── */
  ok('서버가 not_sheetless 를 경고 신호로 올린다',
    /reason: 'not_sheetless', warn: true/.test(planSrc) && /message: '이 작업은 아직 무시트/.test(planSrc));
  ok('★ 화면이 그 경우를 "저장 완료"로 뭉뚱그리지 않는다',
    /j\.worktableSync && j\.worktableSync\.warn/.test(front) && /'warning'\)/.test(front));
  ok('조절 화면이 전환 누락을 상단에 고지한다', /worktableLinked === false/.test(front) && /무시트 작업표로 전환되지 않은 상태/.test(front));
  ok('★ [작업표 재구성]은 무시트가 아니면 비활성 + 사유(죽은 버튼 금지)',
    /function syncRebuildBtn\(\)[\s\S]{0,500}btn\.disabled = \(linked === false\)/.test(front)
    && /syncRebuildBtn\(\);/.test(front));
  /* ★ 툴팁·확인창은 실제로 일어나는 일 3가지(날짜 이동 · 부족분 줄 추가 · 남는 빈 줄 날짜 비우기)와
     건드리지 않는 것(참여·주문 있는 줄, 계획에 없는 미래 날짜 줄)을 말해야 한다 — "빈 줄만 다시
     배치"로 줄이면 줄 수가 늘거나 준 것을 사고로 오해한다(rebuildAdjustedPlansToWorktable 실제 동작). */
  ok('★ [작업표 재구성] 툴팁이 실제 동작 3가지를 말한다',
    /저장된 오늘 이후 계획에 맞춰 작업표의 빈 줄을 다시 배열합니다[^']*날짜 이동[^']*줄 추가[^']*날짜 비우기/.test(front));
  ok('★ 확인창이 줄 추가·날짜 비우기·보호 대상까지 말한다(뭉뚱그리기 금지)',
    /빈 줄의 구매일자를 계획일로 옮깁니다/.test(front)
    && /계획 인원이 모자라면 빈 줄을 새로 만듭니다/.test(front)
    && /필요 없는 빈 줄은 구매일자를 비웁니다/.test(front)
    && /참여자·연락처·주문이 있는 줄과, 계획에 없는 미래 날짜의 준비 줄은 건드리지 않습니다/.test(front));
  ok('연결 상태는 서버가 판정해 내려준다(화면 추정 금지)',
    /worktableLinked: sheetlessLinked/.test(planSrc) && /sheetlessLinked = null;   \/\/ 모르면/.test(planSrc));

  /* ── ③ 표시 기준 통일 ── */
  // ⚠ SELECT 컬럼 목록은 늘어날 수 있다(날짜별 "채워진 줄" 수 집계) — 검사 의미는 **기준(WHERE)** 이다.
  ok('★ 모달 기준선도 active = TRUE 로 센다(그리드·실행과 같은 기준)',
    /FROM campaign_participants\s*\n\s*WHERE sheet_id = \$1 AND tab_name = \$2 AND deleted_at IS NULL AND active = TRUE/.test(src));

  /* 수동 [작업표 재구성]도 증원 행을 만들 수 있다. 삭제된 seq 뒤에 새 행을 만들면
     seq 자체는 일부러 건너뛰므로, 저장 경로처럼 화면 번호를 다시 채워야 한다. */
  const rebuildSrc = planSrc.slice(planSrc.indexOf('async function rebuildWorktableFromPlans'));
  ok('★ 수동 작업표 재구성도 장부 재생성 전에 화면 번호를 정리한다',
    /const \{ renumberTab \} = require\('\.\/rowNumbering\.service'\);/.test(rebuildSrc)
    && rebuildSrc.indexOf('renumberTab({') < rebuildSrc.indexOf('rebuildLedgers({ ...target'));

  console.log(`\nplanWorktableSeqReuse: ${passed} passed`);
  process.exit(0);
})();
