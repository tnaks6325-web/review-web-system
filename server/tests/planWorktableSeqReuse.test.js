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
  ok('연결 상태는 서버가 판정해 내려준다(화면 추정 금지)',
    /worktableLinked: sheetlessLinked/.test(planSrc) && /sheetlessLinked = null;   \/\/ 모르면/.test(planSrc));

  /* ── ③ 표시 기준 통일 ── */
  ok('★ 모달 기준선도 active = TRUE 로 센다(그리드·실행과 같은 기준)',
    /SELECT row_json FROM campaign_participants\s*\n\s*WHERE sheet_id = \$1 AND tab_name = \$2 AND deleted_at IS NULL AND active = TRUE/.test(src));

  console.log(`\nplanWorktableSeqReuse: ${passed} passed`);
  process.exit(0);
})();
