/**
 * rowHideRemoved.test.js — 회귀가드: **행 숨김 기능 폐기** (사용자 확정 2026-08-23)
 * 실행: node tests/rowHideRemoved.test.js
 *
 * 계기(실사고 「0807(올리브영)블랑카우 바디로션 100건」): 작업표에 85줄이 채워져 있는데 상단
 * 진행 현황이 `참여자 82/100` 이었다. 원인은 옛 `_hidden`(행 숨김 오버레이) 3줄 — 화면에서만
 * 줄을 빼는 기능이라 **표의 줄 수 · 진행 현황 · 마감자료가 서로 다른 사실**을 말했다.
 *
 * 고정하는 불변식:
 *   ① 쓰기 표면 0 — `_hidden` 은 편집 화이트리스트에 없다(저장 자체가 거부·쓰기 0건).
 *   ② 읽기 표면 0 — 옛 레코드가 남아 있어도 **행을 감추지 않는다**(작업보드·마감자료 모두).
 *   ③ 응답 표면 0 — `hiddenRows` · `counts.hidden` 이 없다.
 *   ④ 화면 표면 0 — 숨김 칩 · 복원 목록(`showHidden`) 이 없다.
 *   ⑤ ★ write-back 방어 제외는 **유지** — 남아 있는 레거시 레코드가 시트로 나가면 안 된다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SVC = read('src/services/trackB.service.js');
const WD = read('../frontend/workdesk.html');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

console.log('\n[A] 쓰기 표면 0');
{
  const kind = SVC.slice(SVC.indexOf('const _EDIT_FIELD_KIND = {'), SVC.indexOf('};', SVC.indexOf('const _EDIT_FIELD_KIND = {')));
  ok('★ 편집 화이트리스트에 _hidden 이 없다(되살리면 사고가 재현된다)', !/_hidden/.test(kind));
}

console.log('\n[B] 읽기 표면 0 — 옛 레코드가 남아 있어도 행을 감추지 않는다');
{
  ok('★ 작업보드 합성에 숨김 해석이 없다', SVC.indexOf('if (ov._hidden === true)') === -1);
  ok('★ 마감자료(CSV)에도 숨김 제외가 없다', SVC.indexOf('_hidden === true) continue') === -1);
  ok('★ hiddenList / hiddenRows 자체가 없다', !/hiddenList/.test(SVC) && !/res\.hiddenRows/.test(SVC));
  ok('★ counts.hidden 이 없다', !/hidden: hiddenList\.length/.test(SVC));
}

console.log('\n[C] 화면 표면 0');
{
  ok('★ 숨김 칩이 없다', !/숨김 \$\{c\.hidden\}/.test(WD) && !/c\.hidden\s*>\s*0/.test(WD));
  ok('★ 복원 목록(showHidden)이 없다', !/showHidden/.test(WD));
  ok("★ '_hidden' 을 되돌리는 호출이 없다", !/revertEdit\([^)]*_hidden/.test(WD));
}

console.log('\n[D] ★ 레거시 방어는 유지 — 남은 레코드가 시트로 나가지 않는다');
{
  ok("write-back 픽업 SQL 이 여전히 _hidden 을 제외한다", /field <> '_hidden'/.test(SVC));
  ok('이력 화면은 옛 레코드를 읽을 수 있다(라벨 보존)', /'\(행 숨김\)'/.test(SVC));
}

console.log('\n[E] 실행 — 옛 오버레이가 있어도 줄이 남고 응답에 숨김 표면이 없다');
{
  const T = require('../src/services/trackB.service');
  const roster = [1, 2].map(seq => ({
    id: 'r' + seq, seq, name: '참여자' + seq, recipient: '참여자' + seq, phone8: '1111000' + seq,
    round: null, option: null, product: null, submitted: false, paid: false,
    source: 'import', order_submission_id: null, identity_key: 'ik' + seq, row_json: {},
    submit_col: null, submit_col2: null,
  }));
  const edits = [{ anchor_type: 'identity', anchor_value: 'ik2', field: '_hidden', kind: 'bool', value_bool: true, value_text: null }];
  T.__setPoolForTest({
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(q)) return { rows: [{ n: 0 }] };
      if (/FROM campaign_participants/.test(q) && /ORDER BY seq/.test(q)) return { rows: roster };
      if (/FROM participant_edits/.test(q)) return { rows: edits };
      if (/FROM tab_configs/.test(q)) return { rows: [{ campaignName: 'c', displayName: 'd', gid: '' }] };
      return { rows: [] };
    },
  });
  return T.workdeskTab({ sheetId: 's1', tabName: 't1', role: 'master' }).then(res => {
    T.__setPoolForTest(null);
    ok('★ 숨김 표시된 줄도 로스터에 남는다(2줄 그대로)', res.roster.length === 2, String(res.roster.length));
    ok('★ 표의 줄 수 ≡ 게이지 분자 재료(빈 슬롯 아님 → filled 2)', res.counts.filled === 2, String(res.counts.filled));
    ok('★ 응답에 hiddenRows 가 없다', !('hiddenRows' in res));
    ok('★ counts.hidden 이 없다', !('hidden' in res.counts));
    ok('★ 폐기 필드는 편집 배지로 세지 않는다',
      res.roster.every(r => !(r.editedFields || []).includes('_hidden')));
    console.log(`\n✅ rowHideRemoved: ${passed} cases passed`);
    process.exit(0);
  });
}
