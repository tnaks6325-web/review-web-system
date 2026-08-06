/**
 * inspectTypeActions.test.js — 리뷰검수 유형별 맞춤 조치 + 카드 재디자인 + 중복파일 제거 회귀가드.
 *
 * 고정하는 불변식:
 *   A. 유형별 매트릭스(vm 실행) — 주 유형이 주 버튼을 정한다: 중복=제거만(이동 없음),
 *      리뷰화면아님=AI 추정 종류의 이동, 상품명=별칭 학습, 채널=추정 오인, 본문겹침=나란히 보기.
 *      우선순위 = duplicate > format_fail > product > similarity > channel > author.
 *      ★ [✓ 정상]/[✕ 불량]은 어느 유형에서든 주/보조에 반드시 존재.
 *   B. dedupManual(스텁 실행) — duplicate fail 근거 없으면 거부(휴지통 0), 휴지통만(영구삭제 금지),
 *      원장 slot_key='trashed' + routed_by='dedup:<이름>'.
 *   C. 배선 — dedup-manual 라우트(불량 종결) · 전용 팝업(_rcPopup — confirm 미사용) · [상세] 버튼 제거.
 *
 * 실행: node tests/inspectTypeActions.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* drive.service 스텁 — dedupManual 이 lazy require 하기 전에 주입 */
const drivePath = require.resolve('../src/services/drive.service');
const _trash = [];
require.cache[drivePath] = {
  id: drivePath, filename: drivePath, loaded: true, exports: {
    trashFiles: async (files) => { _trash.push(files); },
    getFileParents: async () => ({ parents: [] }), moveFile: async () => {},
    extractFolderIdFromUrl: () => null, getOrCreateSubFolder: async () => null, downloadFile: async () => null,
  },
};
const FR = require('../src/services/fileRoute.service');

function seqPool(handlers) {
  const calls = []; let i = 0;
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    const h = handlers[Math.min(i, Math.max(handlers.length - 1, 0))]; i++;
    return typeof h === 'function' ? h(sql, params) : (h || { rows: [], rowCount: 0 });
  } };
}

(async () => {
  /* ═══ A. 유형별 매트릭스 — 프론트 함수를 vm 으로 꺼내 실제 실행 ═══ */
  console.log('\nA) 유형별 조치 매트릭스 (vm 실행)');
  {
    // _riIssueTypes / RI_TYPE_META / _riPrimaryIssue / _riTypeLabel / _riCardActions 추출
    const grab = (re) => { const m = re.exec(wd); assert.ok(m, '추출 실패: ' + re); return m[0]; };
    const code =
      grab(/function _riIssueTypes\(r\)\{[\s\S]*?\n\}/) + '\n' +
      grab(/const RI_TYPE_META=\{[\s\S]*?\n\};/) + '\n' +
      grab(/function _riPrimaryIssue\(r\)\{[\s\S]*?\n\}/) + '\n' +
      grab(/function _riTypeLabel\(p,c\)\{[\s\S]*?\n\}/) + '\n' +
      grab(/function _riCardActions\(r,i\)\{[\s\S]*?\n\}/);
    const sb = { esc: (s) => String(s == null ? '' : s) };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const F = { issue: sb._riIssueTypes, prim: sb._riPrimaryIssue, label: sb._riTypeLabel, act: sb._riCardActions };
    const R = (checks, extra) => Object.assign({ file_id: 'F', checks }, extra || {});

    // A1: 우선순위 — 복합 건은 조치가 확실한 것부터
    const multi = R({ duplicate: { verdict: 'fail' }, format: { verdict: 'fail' }, product: { verdict: 'warn' } });
    assert.strictEqual(F.prim(multi), 'duplicate');
    assert.strictEqual(F.prim(R({ format: { verdict: 'fail' }, product: { verdict: 'warn' } })), 'format_fail');
    assert.strictEqual(F.prim(R({ product: { verdict: 'warn' }, similarity: { verdict: 'warn' } })), 'product');
    assert.strictEqual(F.prim(R({ author: { verdict: 'warn' } })), 'author');
    assert.strictEqual(F.prim(R({})), null, '통과 = 주 유형 없음(조치 영역 없음)');
    ok('A1: ★★ 우선순위 duplicate > format_fail > product > similarity > channel > author');

    // A2: ★ 중복 = 제거만 — 주/보조 어디에도 이동 버튼이 없다
    const dupAct = F.act(R({ duplicate: { verdict: 'fail', matchFileId: 'M' } }), 3);
    assert.ok(/riDedupPopup\(3\)/.test(dupAct.main.h), '주 = 🗑 중복파일 제거');
    const dupVisible = [dupAct.main, ...dupAct.subs].map(a => a.h).join('|');
    assert.ok(!/riRouteManual/.test(dupVisible), '★ 중복 카드의 보이는 버튼에 이동 없음(어디로 옮겨도 중복은 남는다)');
    assert.ok(dupAct.more.some(a => /riRouteManual/.test(a.h)), '이동은 [⋯]에 — 선택지 축소가 아니다');
    ok('A2: ★★ 중복 = [🗑 제거]만 노출, 이동은 [⋯]로');

    // A3: 리뷰화면 아님 — AI 추정 종류가 주 이동 버튼을 정한다
    const fmtR = F.act(R({ format: { verdict: 'fail', got: 'receipt' } }), 1);
    assert.ok(/riRouteManual\(1,'receipt'\)/.test(fmtR.main.h), '영수증으로 보임 → 주 = 현금영수증 이동');
    const fmtC = F.act(R({ format: { verdict: 'fail', got: 'order_capture' } }), 1);
    assert.ok(/riRouteManual\(1,'order_capture'\)/.test(fmtC.main.h), '주문내역으로 보임 → 주 = 구매캡처 이동');
    const fmtU = F.act(R({ format: { verdict: 'fail' } }), 1);
    assert.ok(/riBadPopup\(1\)/.test(fmtU.main.h), '종류 불명 → 주 = ✕ 불량(반려 안내 전송)');
    const rcp = F.act(R({ format: { verdict: 'fail', got: 'review' } }, { slot_key: 'receipt' }), 1);
    assert.ok(/riRouteManual\(1,'review'\)/.test(rcp.main.h), '영수증 칸의 리뷰 화면 → 주 = 리뷰로 이동');
    ok('A3: 리뷰화면 아님 — AI got 이 주 이동 버튼을 정한다(불명 = 불량)');

    // A4: 상품명 = 별칭 학습 / 채널 = 추정 오인 / 본문겹침 = 나란히 보기
    const prod = F.act(R({ product: { verdict: 'warn' } }), 2);
    assert.ok(/riResolve\('F','ok'\)/.test(prod.main.h) && /별칭으로 학습/.test(prod.main.t));
    assert.ok(prod.subs.some(a => /riProductNames\(2\)/.test(a.h)), '보조 = ⚙ 기대 상품명');
    const chan = F.act(R({ format: { verdict: 'warn', expectedChannel: 'coupang' } }), 2);
    assert.ok(/riResolve\('F','ok'\)/.test(chan.main.h) && /추정 오인/.test(chan.main.t));
    assert.ok(chan.subs.some(a => /riPromoteSample\(2\)/.test(a.h)), '보조 = 🖼 예시로 등록');
    const sim = F.act(R({ similarity: { verdict: 'warn', score: 0.92 } }), 2);
    assert.ok(/riOpenDetail\(2\)/.test(sim.main.h) && /나란히 보기/.test(sim.main.t), '대조 없는 불량 클릭 방지 배치');
    ok('A4: 상품명=학습 / 채널=오인 정상 / 본문겹침=나란히 보기 우선');

    // A5: ★ 어느 유형이든 [✓ 정상]·[✕ 불량] 모두 도달 가능(주+보조 안에)
    for (const checks of [
      { duplicate: { verdict: 'fail', matchFileId: 'M' } }, { format: { verdict: 'fail', got: 'receipt' } },
      { format: { verdict: 'fail' } }, { product: { verdict: 'warn' } },
      { format: { verdict: 'warn', expectedChannel: 'coupang' } },
      { similarity: { verdict: 'warn' } }, { author: { verdict: 'warn' } },
    ]) {
      const a = F.act(R(checks), 0);
      const all = [a.main, ...a.subs].map(x => (x.h || '') + (x.t || '')).join('|');
      assert.ok(/riResolve\('F','ok'\)|'ok'\)/.test(all), '정상 도달: ' + JSON.stringify(checks));
      assert.ok(/riBadPopup\(0\)/.test(all), '불량 도달: ' + JSON.stringify(checks));
    }
    ok('A5: ★ [✓ 정상]/[✕ 불량] 상시 도달(맞춤 배치 = 빠른 길, 선택지 축소 아님)');

    // A6: 유형 띠 라벨 — got·유사도% 동봉
    assert.ok(/현금영수증으로 보임/.test(F.label('format_fail', { format: { got: 'receipt' } })));
    assert.ok(/92%/.test(F.label('similarity', { similarity: { score: 0.92 } })));
    assert.strictEqual(F.label(null), '이상 없음');
    ok('A6: 유형 띠가 AI 추정 종류·유사도를 말한다');
  }

  /* ═══ B. dedupManual ═══ */
  console.log('\nB) dedupManual (스텁 실행)');
  {
    // B1: 중복 근거 없으면 거부 — 휴지통 호출 0
    _trash.length = 0;
    let p = seqPool([
      { rows: [{ file_id: 'F', file_name: 'f.png', sheet_id: 's', tab_name: 't', row_index: 3, reviewer_name: '김', slot_key: 'review' }] },
      { rows: [{ checks: { format: { verdict: 'fail' } } }] },   // duplicate 근거 없음
    ]);
    FR.__setPoolForTest(p);
    const r1 = await FR.dedupManual({ fileId: 'F', by: '만두' });
    assert.strictEqual(r1.ok, false);
    assert.ok(/중복 근거/.test(r1.error));
    assert.strictEqual(_trash.length, 0, '★ 근거 없으면 휴지통 호출 자체가 없다');
    ok('B1: ★ duplicate fail 근거 없는 파일 = 거부(버튼 없는 유형의 API 직접 호출 차단)');

    // B2: 정상 제거 — 휴지통 + slot_key='trashed' + dedup:<이름> + 대표 재계산 + resolved 로그
    _trash.length = 0;
    p = seqPool([
      { rows: [{ file_id: 'F', file_name: 'f.png', sheet_id: 's', tab_name: 't', row_index: 3, reviewer_name: '김', slot_key: 'review' }] },
      { rows: [{ checks: { duplicate: { verdict: 'fail', matchFileId: 'M' } } }] },
      { rows: [], rowCount: 1 },   // 원장 UPDATE
      { rows: [] },                // recomputePrimary SELECT
      { rows: [], rowCount: 1 },   // review_index 비움
    ]);
    FR.__setPoolForTest(p);
    const r2 = await FR.dedupManual({ fileId: 'F', by: '만두' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.matchFileId, 'M');
    assert.strictEqual(_trash.length, 1, '휴지통 1회(영구삭제 API 미사용)');
    const upd = p.calls.find(q => /slot_key = 'trashed'/.test(q.sql));
    assert.ok(upd && upd.params[1] === 'dedup:만두', "원장 = slot_key 'trashed' + routed_by 'dedup:<이름>'");
    assert.ok(/COALESCE\(routed_from_slot, slot_key\)/.test(upd.sql), '최초 출처 보존');
    ok('B2: 제거 시퀀스 — 휴지통만·원장 trashed·최초 출처 보존');

    // B3: 이미 제거된 파일 재호출 = 거부(멱등 안내)
    p = seqPool([
      { rows: [{ file_id: 'F', slot_key: 'trashed', sheet_id: 's', tab_name: 't' }] },
      { rows: [] },
    ]);
    FR.__setPoolForTest(p);
    assert.ok(/이미 제거된/.test((await FR.dedupManual({ fileId: 'F' })).error));
    ok('B3: 이미 제거된 파일 = 거부(이중 제거 방지)');
    FR.__setPoolForTest(null);
  }

  /* ═══ C. 배선 ═══ */
  console.log('\nC) 배선');
  {
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/'\/review-inspect\/dedup-manual', authMiddleware, _reInternal/.test(tb),
      'dedup 라우트 = 건별 확인과 같은 게이트');
    const dedupBlock = tb.slice(tb.indexOf("'/review-inspect/dedup-manual'"), tb.indexOf("'/review-inspect/route-stats'"));
    assert.ok(/resolution: 'bad'/.test(dedupBlock), '제거 성공 = 불량 맞음(중복 제출) 종결 — #562 확정 기본값');
    ok('C1: dedup-manual 라우트 + 불량 종결');

    assert.ok(/function _rcPopup\(o\)\{/.test(wd) && /function riRcOk\(\)/.test(wd),
      '전용 확인 팝업 공용 골격(_rcPopup) 존재');
    const routeFn = /function riRouteManual\(i, target\)\{[\s\S]*?\n\}/.exec(wd)[0];
    assert.ok(/_rcPopup\(/.test(routeFn) && !/\bconfirm\(/.test(routeFn),
      '★ 이동 확인 = 전용 팝업(시스템 confirm 미사용)');
    const dedupFn = /function riDedupPopup\(i\)\{[\s\S]*?\n\}/.exec(wd)[0];
    assert.ok(/_rcPopup\(/.test(dedupFn) && /matchFileId/.test(dedupFn) && /보존 \(이전 제출\)/.test(dedupFn),
      '중복 제거 팝업 = 두 장 비교(제거/보존 명시)');
    assert.ok(/30일간 복구/.test(dedupFn), '휴지통 복구창 고지');
    ok('C2: 전용 팝업 — 이동(파랑)·제거(빨강, 두 장 비교)');

    /* ── 시안 A(v2) 확정 규칙 — 빨강 채움 금지 · 썸네일 상단 · 정상/불량만은 좌우 반반 ── */
    const css = /\.nc-main\{[\s\S]*?\.nc-main\.m-slate\{[^}]*\}/.exec(wd);
    assert.ok(css, '.nc-main 색 규칙 블록 추출');
    assert.ok(/\.nc-main\{[^}]*border:1px solid/.test(css[0]) && !/\.nc-main\{[^}]*color:#fff/.test(css[0]),
      '★★ 주 조치 = 테두리+틴트(채움·흰 글자 금지 — 빨간 벽 재발 차단)');
    for (const m of ['m-red', 'm-amber', 'm-green', 'm-blue', 'm-vio', 'm-slate']) {
      const rule = new RegExp('\\.nc-main\\.' + m + '\\{([^}]*)\\}').exec(css[0])[1];
      assert.ok(/background:#[EF][0-9A-F]{5}/i.test(rule), `${m} 배경은 틴트(밝은 값)여야 한다: ${rule}`);
      assert.ok(/border-color:/.test(rule) && /color:#[0-9A-F]{6}/i.test(rule), `${m} = 색 글자 + 테두리`);
    }
    ok('C0: ★★ 채움 버튼 금지 — 주 조치 6종 전부 틴트+색 글자+테두리');

    const body = /function _riRenderBody\(\)\{[\s\S]*?\n\}/.exec(wd)[0];
    assert.ok(/const flat = act && \/riBadPopup\\\(\/\.test\(act\.main\.h\)/.test(body),
      '주 조치가 [✕ 불량]뿐인 유형 감지(flat)');
    assert.ok(/\$\{flat\?'':`<button class="nc-main/.test(body),
      '★ flat 이면 전폭 버튼을 만들지 않는다(빨간 벽 방지)');
    assert.ok(/t:'✓ 정상',cls:'ok'\},\{h:act\.main\.h,t:'✕ 불량',cls:'bad'\}/.test(body),
      '★ 정상/불량만 있는 카드 = [✓ 정상] | [✕ 불량] 좌우 반반(사용자 확정)');
    assert.ok(/nc-th" onclick="riOpenDetail\(\$\{i\}\)"/.test(body) && /nc-th .ribdg|<span class="ribdg \$\{cls\}/.test(body),
      '★ 썸네일 상단 전폭(클릭=상세) + 상태 배지 썸네일 안');
    assert.ok(/\.nc-th\{height:150px/.test(wd), '썸네일 높이 150px(시안 v2)');
    assert.ok(!/✕ 불량 \(반려 안내 전송\)/.test(wd), '카드 문구 축약 — 전송 설명은 팝업 담당');
    ok('C0b: ★ 썸네일 상단 150px · flat 카드 좌우 반반 · 문구 축약');

    assert.ok(!/>상세<\/button>/.test(body), '[상세] 버튼 제거 — 카드 본문 클릭이 상세');
    assert.ok(/nc-body" onclick="riOpenDetail\(\$\{i\}\)"/.test(body), '본문 클릭 = 상세');
    assert.ok(/event\.stopPropagation\(\);riFilterTab\(\$\{i\}\)/.test(body), '탭 링크는 상세 진입과 격리');
    assert.ok(/nc-type/.test(body) && /riMoreMenu\(\$\{i\}\)/.test(body), '유형 색 띠 + [⋯] 메뉴');
    ok('C3: 카드 재디자인 — 유형 띠·본문 클릭 상세·[⋯]');
  }

  console.log(`\n✅ inspectTypeActions 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
