/**
 * emptySlotCellEdit.test.js — 빈 준비 자리(작업표 슬롯) 셀 편집 회귀가드
 * 실행: node tests/emptySlotCellEdit.test.js
 *
 * 신고(2026-08-19): 택배송장 칸을 우클릭해도 [✏️ 이 셀 편집]이 흐리게만 나온다.
 * 원인 = 아직 아무도 배정되지 않은 줄은 이름·연락처가 없어 identity 앵커를 만들 수 없고,
 *        앵커가 없으면 **그 줄 전체가 편집 잠금**이었다(시트에서 늘 하던 "빈 줄에 미리 적기"가 불가능).
 *
 * 이 가드가 고정하는 것:
 *  ① 앵커 없는 줄은 **물리행 id** 를 앵커로 쓴다(seq·정렬에 기대지 않는다 = 재투영 면역 유지)
 *  ② 나중에 주문이 붙어 앵커가 승격해도 그때 적어 둔 값이 **화면에서 사라지지 않는다**(읽기 합성)
 *  ③ 그때 `_hidden`(빈 자리 제거 표시)까지 따라오지는 않는다(배정된 줄을 숨기면 안 된다)
 *  ④ 되돌리기(↩)는 승격 전 값까지 지운다(안 지우면 눌러도 옛 값이 되살아난다)
 *  ⑤ 중복 줄(ambiguous)은 여전히 잠긴다 — 어느 줄의 편집인지 모르면 어느 줄에도 적용하지 않는다
 *  ⑥ 화면은 잠긴 칸에 **사유**를 말한다(흐린 버튼만 두면 원인을 찾을 데가 없다)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const svc = require('../src/services/trackB.service');
const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

function readPool(scn) {
  return {
    async query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM tab_configs/.test(s)) return { rows: [{ campaignName: 'C' }] };
      if (/FROM participant_edits/.test(s)) return { rows: scn.edits || [] };
      if (/reviewer_name AS name.*FROM campaign_participants.*ORDER BY seq/.test(s)) return { rows: scn.roster || [] };
      return { rows: [] };
    },
  };
}
const slot = (over) => ({
  id: 'p-empty', seq: 7, name: null, recipient: null, phone8: null, round: '', option: '', product: '',
  submitted: false, paid: false, source: 'worktable', order_submission_id: null, identity_key: null, row_json: {}, ...over,
});
const edit = (type, value, field, text) =>
  ({ anchor_type: type, anchor_value: value, field, kind: 'text', value_bool: null, value_text: text });

(async () => {
  console.log('\n▶ 빈 준비 자리 셀 편집 회귀가드\n');
  console.log('1) 읽기(합성)');

  svc.__setPoolForTest(readPool({ roster: [slot()], edits: [edit('manual', 'p-empty', 'col:택배송장번호', '1234')] }));
  let wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  t('★ 배정 전 빈 줄도 편집 가능(물리행 앵커) — 적어 둔 송장이 그대로 보인다', () => {
    assert.strictEqual(wd.roster[0].editable, true, '빈 줄이 잠겨 있으면 송장을 미리 못 적는다');
    assert.strictEqual(wd.roster[0].anchorType, 'manual');
    assert.strictEqual(wd.roster[0].cellEdits['택배송장번호'], '1234');
  });

  // 같은 물리행에 주문이 붙어 order 앵커로 승격한 뒤
  svc.__setPoolForTest(readPool({
    roster: [slot({ name: '홍길동', phone8: '11112222', order_submission_id: 'ord-9', identity_key: 'num:1' })],
    edits: [edit('manual', 'p-empty', 'col:택배송장번호', '1234')],
  }));
  wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  t('★ 주문이 붙어 앵커가 승격해도 미리 적어 둔 값이 사라지지 않는다', () => {
    assert.strictEqual(wd.roster[0].cellEdits['택배송장번호'], '1234');
  });
  t('★ 그 값은 미부착(orphan) 으로 세지 않는다(있지도 않은 유실 경보 금지)', () => {
    assert.strictEqual(wd.orphanEdits.count, 0);
  });

  svc.__setPoolForTest(readPool({
    roster: [slot({ name: '홍길동', phone8: '11112222', order_submission_id: 'ord-9', identity_key: 'num:1' })],
    edits: [
      edit('manual', 'p-empty', 'col:택배송장번호', '옛값'),
      edit('order', 'ord-9', 'col:택배송장번호', '새값'),
    ],
  }));
  wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  t('★ 같은 칸이 겹치면 현재 앵커(주문) 값이 이긴다', () => {
    assert.strictEqual(wd.roster[0].cellEdits['택배송장번호'], '새값');
  });

  svc.__setPoolForTest(readPool({
    roster: [slot({ name: '홍길동', phone8: '11112222', order_submission_id: 'ord-9', identity_key: 'num:1' })],
    edits: [{ anchor_type: 'manual', anchor_value: 'p-empty', field: '_hidden', kind: 'bool', value_bool: true, value_text: null }],
  }));
  wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  t('★ 빈 자리를 치웠던 제거 표시(_hidden)는 승격한 줄까지 숨기지 않는다', () => {
    assert.strictEqual(wd.roster.length, 1, '실제 참여자가 배정된 줄이 사라지면 안 된다');
  });

  svc.__setPoolForTest(readPool({
    roster: [
      slot({ id: 'a1', phone8: '55556666', identity_key: 'phone8:55556666', name: 'C1', source: 'import' }),
      slot({ id: 'a2', seq: 8, phone8: '55556666', identity_key: 'phone8:55556666', name: 'C2', source: 'import' }),
    ],
    edits: [edit('manual', 'a1', 'col:택배송장번호', '번짐금지')],
  }));
  wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  t('★ 중복 줄(ambiguous)은 그대로 잠긴다 — 물리행 값도 적용하지 않는다', () => {
    assert.strictEqual(wd.roster[0].editable, false);
    assert.deepStrictEqual(wd.roster[0].cellEdits, {});
  });

  /* ── 2) 쓰기·되돌리기 ─────────────────────────────────────── */
  console.log('\n2) 쓰기·되돌리기');
  function connPool(row, opts = {}) {
    const calls = [];
    const client = {
      async query(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ s, params });
        if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
        if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) return { rows: row ? [row] : [] };
        if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: opts.dup || 1 }] };
        if (/FROM raw_sheet_tabs/.test(s)) return { rows: [{ detected_headers: ['택배송장번호'] }] };
        if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rows: [], rowCount: opts.revertN == null ? 1 : opts.revertN };
        if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 42 }] };
        return { rows: [] };
      },
      release() {},
    };
    return { calls, async connect() { return client; } };
  }

  let cp = connPool({ id: 'p-empty', source: 'worktable', order_submission_id: null, identity_key: null, phone8: '', recipient_name: null, option_text: null, row_json: {}, tab_gid: '1' });
  svc.__setPoolForTest(cp);
  let r = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'p-empty', field: 'col:택배송장번호', value: '1234' });
  t('★ 빈 줄 저장이 거부되지 않는다(화면은 열렸는데 저장만 실패 = 막다른 길)', () => {
    assert.ok(r.ok, '거부됨: ' + r.error);
    assert.strictEqual(r.anchorType, 'manual');
    const ins = cp.calls.find(c => /INSERT INTO participant_edits/.test(c.s));
    assert.strictEqual(ins.params[3], 'p-empty', '앵커 값은 물리행 id');
  });

  cp = connPool({ id: 'p2', source: 'import', order_submission_id: null, identity_key: 'phone8:55556666', phone8: '55556666', recipient_name: null, option_text: null, row_json: {}, tab_gid: '1' }, { dup: 2 });
  svc.__setPoolForTest(cp);
  r = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'p2', field: 'col:택배송장번호', value: 'x' });
  t('★ 중복 신원 줄은 여전히 거부(완화 금지)', () => {
    assert.ok(!r.ok && r.error === 'ambiguous_identity');
    assert.ok(!cp.calls.some(c => /INSERT INTO participant_edits/.test(c.s)), '거부인데 저장이 나갔다');
  });

  cp = connPool({ id: 'p-empty', source: 'import', order_submission_id: 'ord-9', identity_key: 'num:1', phone8: '1', recipient_name: null, option_text: null, row_json: {} });
  svc.__setPoolForTest(cp);
  r = await svc.revertWorkdeskEdit({ sheetId: 's', tabName: 'T', rowId: 'p-empty', field: 'col:택배송장번호' });
  t('★ 되돌리기는 승격 전(물리행 앵커) 값까지 지운다', () => {
    const manualRevert = cp.calls.filter(c => /UPDATE participant_edits SET reverted_at/.test(c.s))
      .find(c => c.params.includes('p-empty'));
    assert.ok(manualRevert, '물리행 앵커 되돌리기가 없다 — ↩ 를 눌러도 옛 값이 되살아난다');
    assert.ok(r.ok);
  });

  /* ── 3) 화면: 잠긴 사유 ───────────────────────────────────── */
  console.log('\n3) 화면 — 잠긴 사유 표기');
  // ⚠ 이 패턴은 메뉴 항목이 조건부로 바뀔 때마다 드리프트한다(구매일자 달력·리뷰 대신 제출).
  //    검사 의미는 불변: **흐린 편집 항목에는 잠긴 사유가 title 로 붙는다**.
  t('흐린 [이 셀 편집]에 사유가 붙는다', () => {
    assert.match(workdesk, /'이 셀 편집',"_menuEditCell\(\)",!editable,false,editable\?'':_cellLockReason\(td,selectedRow\)/);
  });
  const sandbox = { STATE: { role: 'master', canEdit: true },
    _workdeskStatusKindForField: f => (f === 'col:리뷰제출' ? 'review' : (f === 'col:입금' ? 'payment' : '')) };
  vm.createContext(sandbox);
  const src = workdesk.match(/function _cellLockReason\(td, r\)\{[\s\S]*?\n\}/)[0];
  vm.runInContext(src, sandbox);
  const td = f => ({ getAttribute: k => (k === 'data-field' ? f : null) });
  const reason = (f, r) => vm.runInContext('_cellLockReason', sandbox)(td(f), r);
  t('사유가 칸 성격 → 줄 상태 → 계정 권한 순으로 갈린다', () => {
    assert.match(reason('col:리뷰제출'), /관리자 수동 리뷰제출/);
    assert.match(reason('col:입금'), /입금수정/);
    assert.match(reason('idname'), /실제 제출 리뷰어 정보/);
    assert.match(reason('col:비고', { ambiguous: true }), /중복 줄을 먼저 정리/);
    assert.match(reason('col:비고', { editable: false }), /편집 기준\(주문·신원\)이 없어/);
    assert.match(reason(''), /번호 칸/);
  });
  t('업체 계정에는 "송장 칸만 입력할 수 있다"고 말한다', () => {
    sandbox.STATE = { role: 'advertiser', canEdit: false };
    assert.match(reason('col:주소'), /택배송장 칸만/);
  });

  console.log(`\n✅ 통과 ${pass}건`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
