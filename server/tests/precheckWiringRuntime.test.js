/**
 * precheckWiringRuntime.test.js — 리뷰 캡처 1차 필터(첨부 즉시 판정) 실행 회귀가드.
 *
 * 왜 "실행"으로 고정하나:
 *   2026-08-06 ~ 2026-09-22 사이 `_preCtx()` 가 `authSession` 을 맨몸으로 참조했다.
 *   그 이름은 구매양식 모드 함수의 **지역 변수**라 이 스코프에는 없어 호출마다
 *   ReferenceError 가 났고, 첨부 경로 3곳이 `_preCheckFiles(..., { ..._preCtx(idx) })`
 *   로 부르므로 **인자 평가 단계에서** 죽었다. 셋 다 async 인데 호출부가 await·catch 를
 *   하지 않아 rejected promise 가 조용히 사라졌고, 파일 첨부·미리보기는 그 앞에서 이미
 *   끝나 **화면은 정상인데 1차 필터만 한 번도 실행되지 않았다**(서버 요청 0건 / 7주).
 *   ⇒ 문자열 grep 은 이 사고를 통과시킨다(배선도 함수도 멀쩡히 "있다").
 *      그래서 sandbox 에 `authSession` 을 **일부러 두지 않고 실제로 돌려 본다**.
 *
 * 고정하는 불변식:
 *   A. `_preCtx` 는 프리변수 없이 실행된다 + 세션을 `_loadAuthSession` 에서 읽는다.
 *   B. `_preCtx` 본문에 맨몸 `authSession` 참조가 없다(부활 차단).
 *   C. `_preCheckFiles` 는 어떤 예외에도 `checking` 을 내린다(제출 영구잠금 방지).
 *   D. 첨부 경로 3곳이 여전히 1차 필터를 부른다.
 *
 * 실행: node tests/precheckWiringRuntime.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'search-app.js'), 'utf8');
let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/** 선언부터 짝이 맞는 닫는 중괄호까지 함수 원문을 잘라낸다. */
function extractFn(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  assert.ok(m, `함수를 찾지 못했습니다: ${name}`);
  let i = m.index + m[0].length, depth = 1;
  while (i < SRC.length && depth > 0) {
    const c = SRC[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const code = SRC.slice(m.index, i);
  new vm.Script(code);   // 잘라낸 조각이 문법적으로 온전한지 확인(경계 오절단 방지)
  return code;
}

(async () => {
  /* ═══ A. _preCtx 실행 — sandbox 에 authSession 을 두지 않는다 ═══ */
  console.log('\nA) _preCtx 는 프리변수 없이 실행된다');
  {
    const sandbox = {
      console,
      S: { selectedRows: [{ sheetId: 'SH', tabName: '탭', rowIndex: 7, name: '행이름' }], selectedRow: null },
      _loadAuthSession: () => ({ name: '로그인이름', phone8: '87654321' }),
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFn('_preCtx'), sandbox);

    const ctx = sandbox._preCtx(0);     // ★ authSession 이 다시 들어오면 여기서 ReferenceError
    assert.strictEqual(ctx.sheetId, 'SH');
    assert.strictEqual(ctx.tabName, '탭');
    assert.strictEqual(ctx.rowIndex, 7);
    ok('행이 있으면 좌표를 그대로 싣는다');

    assert.strictEqual(ctx.phone8, '87654321', 'phone8 은 세션에서 와야 한다');
    ok('연락처는 _loadAuthSession 에서 읽는다(중복 대조의 재료)');

    // 행 이름이 있으면 행 이름 우선, 없으면 세션 이름
    assert.strictEqual(ctx.reviewerName, '행이름');
    sandbox.S.selectedRows = [{ sheetId: 'SH', tabName: '탭', rowIndex: 7 }];
    assert.strictEqual(sandbox._preCtx(0).reviewerName, '로그인이름');
    ok('이름은 행 값 우선, 없으면 세션 이름');
  }
  {
    // 세션 조회가 죽어도 첨부·판정은 계속돼야 한다(fail-open)
    const sandbox = {
      console,
      S: { selectedRows: [], selectedRow: null },
      _loadAuthSession: () => { throw new Error('세션 저장소 접근 불가'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFn('_preCtx'), sandbox);
    const ctx = sandbox._preCtx(0);
    assert.strictEqual(ctx.phone8, '');
    assert.strictEqual(ctx.reviewerName, '');
    assert.strictEqual(ctx.sheetId, '');
    ok('세션 조회 실패는 빈 값으로 접고 던지지 않는다(fail-open)');
  }

  /* ═══ B. 프리변수 부활 차단 ═══ */
  console.log('\nB) authSession 프리변수 부활 차단');
  {
    const body = extractFn('_preCtx');
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\bauthSession\b/.test(stripped),
      '_preCtx 는 authSession 을 참조하면 안 된다 — 그 이름은 다른 함수의 지역 변수다(주석 제외 후 판정)');
    ok('_preCtx 본문에 맨몸 authSession 참조 0');

    // 선언 자체가 전역에 없다는 전제도 함께 고정한다(있으면 이 가드의 의미가 사라진다)
    const decl = /(?:^|\n)\s*(?:let|var|const)\s+authSession\b|window\.authSession\s*=/.test(SRC);
    assert.ok(!decl || /let authSession = _loadAuthSession\(\)/.test(SRC),
      'authSession 이 전역으로 선언되면 이 검사가 무의미해진다 — 지역 변수로만 두거나 이 가드를 고쳐라');
    ok('authSession 은 여전히 지역 변수다(가드 전제 유지)');
  }

  /* ═══ C. 1차 필터는 조용히 사라지지 않는다 ═══ */
  console.log('\nC) 내부 예외에도 제출 잠금이 남지 않는다');
  {
    const sandbox = { console: { warn() {} } };
    vm.createContext(sandbox);
    vm.runInContext('var _preState = {};', sandbox);
    vm.runInContext(extractFn('_preGet'), sandbox);
    vm.runInContext(extractFn('_preCheckFiles'), sandbox);
    let rendered = 0;
    sandbox._preRender = () => { rendered++; };
    sandbox._preCheckFilesInner = async () => { throw new Error('boom'); };

    sandbox._preGet('single').checking = true;
    await sandbox._preCheckFiles('single', 'dropZone', [{ b64: 'AA' }], {});

    assert.strictEqual(sandbox._preGet('single').checking, false,
      'checking 이 true 로 남으면 _preHasBlock() 이 제출을 영구 차단한다');
    ok('예외가 나도 checking 을 내린다');
    assert.ok(rendered > 0, '실패해도 화면을 종결해야 한다');
    ok('실패 시 화면을 다시 그려 상태를 끝낸다');

    // 정상 경로는 그대로 위임된다
    let passed = null;
    sandbox._preCheckFilesInner = async (sc, an) => { passed = sc + '|' + an; };
    await sandbox._preCheckFiles('slot:review', 'csSlot_review', [{ b64: 'AA' }], {});
    assert.strictEqual(passed, 'slot:review|csSlot_review');
    ok('정상 경로는 인자를 그대로 넘긴다');
  }

  /* ═══ D. 첨부 경로 3곳 배선 ═══ */
  console.log('\nD) 첨부 경로 3곳이 1차 필터를 부른다');
  {
    for (const fn of ['addFiles', '_mrAddFiles', '_csAddFiles']) {
      const body = extractFn(fn);
      assert.ok(/_preCheckFiles\s*\(/.test(body), `${fn} 이 1차 필터를 부르지 않는다`);
      assert.ok(/_preCtx\s*\(/.test(body), `${fn} 이 _preCtx 로 문맥을 만들지 않는다`);
      ok(`${fn} → _preCheckFiles(..._preCtx())`);
    }
  }

  console.log(`\n✅ precheckWiringRuntime: ${n}건 통과`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ 실패:', e.message); process.exit(1); });
