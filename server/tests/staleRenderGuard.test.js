'use strict';

/* 화면 오류 기록 2종 회귀가드(사람 피해 없음 · 기록만 쌓이던 것)
   ① 입금관리: 큰 집계(최대 60초)를 기다리는 사이 다른 메뉴로 옮기면 #pmhead/#pmbody 가 사라진다.
      늦게 도착한 응답이 그리기 함수를 부르면 null.innerHTML 예외가 「시스템 오류 기록」에 쌓였다
      (_pmRender · 은행 이름 탭 _bnOpen/_bnRender/_bnLoad 실패 화면).
      → 칸이 없으면 조용히 끝, 칸이 있으면 종전대로 그린다.
   ② 리뷰어 구매양식(search.html): src="" 상품 썸네일의 onerror 가 아직 파싱 안 된 #thumbFallback 을 찾다
      null.classList 예외 → 없으면 건너뛴다(있으면 종전대로 hidden 해제). */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const workdesk = fs.readFileSync(path.join(FRONT, 'workdesk.html'), 'utf8');
const search = fs.readFileSync(path.join(FRONT, 'search.html'), 'utf8');

function grab(src, head) {
  const i = src.indexOf(head);
  assert.ok(i >= 0, head + ' 를 찾지 못함');
  let d = 0, seen = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; seen = true; }
    else if (c === '}') { d--; if (seen && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('끝을 찾지 못함: ' + head);
}

const code = [
  grab(workdesk, 'function _pmRender(){'),
  grab(workdesk, 'async function _bnOpen(){'),
  grab(workdesk, 'async function _bnLoad(force){'),
  grab(workdesk, 'function _bnRender(){'),
].join('\n');

function makeCtx(withEls) {
  const dom = {};
  if (withEls) { dom['#pmhead'] = { innerHTML: '' }; dom['#pmbody'] = { innerHTML: '' }; }
  const defined = new Set([...code.matchAll(/function\s+(\w+)/g)].map(m => m[1]));
  const ctx = {
    STATE: { pmItems: [], pmBatches: [] }, console, Promise, Map, Set, Number, String, Array, Object, JSON,
    $: s => dom[s] || null, esc: s => String(s == null ? '' : s),
    api: async () => ({ ok: true, banks: [], log: [] }),
  };
  for (const m of code.matchAll(/\b(_(?:pm|bn|tck)\w*)\s*\(/g)) {
    const n = m[1];
    if (defined.has(n) || n in ctx) continue;
    ctx[n] = /Items$|Conflicts$|Queue$/.test(n) ? () => [] : (n === '_pmFilterState' ? () => ({}) : () => '');
  }
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, dom };
}

(async () => {
  // ① 칸이 사라진 뒤(다른 메뉴) — 예외 없이 끝난다
  {
    const { ctx } = makeCtx(false);
    assert.doesNotThrow(() => vm.runInContext('_pmRender()', ctx), '입금관리를 떠난 뒤 _pmRender 가 예외를 던지면 안 된다');
    await vm.runInContext('_bnOpen()', ctx);                        // 그리기 전 다른 메뉴로 간 은행 탭
    ctx.STATE.bn = { rows: [], log: [], q: '', filter: 'all', loaded: true };
    assert.doesNotThrow(() => vm.runInContext('_bnRender()', ctx), '_bnRender 도 칸이 없으면 조용히 끝');
    ctx.api = async () => ({ ok: false, error: 'x' });               // 실패 화면 경로
    await vm.runInContext('_bnLoad(true)', ctx);
    ctx.api = async () => { throw new Error('net'); };
    await vm.runInContext('_bnLoad(true)', ctx);
  }
  // ① 칸이 있을 때(입금관리를 보는 중) — 종전대로 그린다
  {
    const { ctx, dom } = makeCtx(true);
    vm.runInContext('_pmRender()', ctx);
    assert.match(dom['#pmhead'].innerHTML, /<h1>입금관리<\/h1>/, '입금관리 머리글을 그대로 그려야 한다');
    assert.match(dom['#pmbody'].innerHTML, /pmbatchpanel/, '입금관리 본문을 그대로 그려야 한다');
    dom['#pmhead'].innerHTML = ''; dom['#pmbody'].innerHTML = '';
    ctx.api = async () => ({ ok: false, error: '테스트실패' });
    await vm.runInContext('_bnOpen()', ctx);
    assert.match(dom['#pmhead'].innerHTML, /은행 이름 설정/, '은행 탭 머리글을 그대로 그려야 한다');
    assert.match(dom['#pmbody'].innerHTML, /은행 목록을 불러오지 못했습니다\. \(테스트실패\)/, '실패 화면을 그대로 그려야 한다');
    ctx.STATE.bn = { rows: [], log: [], q: '', filter: 'all', loaded: true };
    dom['#pmbody'].innerHTML = '';
    vm.runInContext('_bnRender()', ctx);
    assert.match(dom['#pmbody'].innerHTML, /lgwrap/, '_bnRender 도 칸이 있으면 그대로 그린다');
  }

  // ② 구매양식 썸네일 onerror — #thumbFallback 이 아직 없을 때 예외 없이, 있으면 종전대로
  {
    const m = search.match(/<img id="productThumb"[^>]*?onerror="([^"]*)"/);
    assert.ok(m, 'productThumb onerror 를 찾지 못함');
    const run = (fb) => {
      const self = { cls: new Set(), classList: { add(c) { self.cls.add(c); }, remove(c) { self.cls.delete(c); } } };
      const document = { getElementById: id => (id === 'thumbFallback' ? fb : null) };
      new Function('document', m[1]).call(self, document);
      return self;
    };
    let self;
    assert.doesNotThrow(() => { self = run(null); }, '대체 아이콘이 아직 없어도 onerror 가 예외를 던지면 안 된다');
    assert.ok(self.cls.has('hidden'), '깨진 썸네일은 여전히 숨긴다');
    const fbCls = new Set(['hidden']);
    run({ classList: { remove: c => fbCls.delete(c) } });
    assert.ok(!fbCls.has('hidden'), '대체 아이콘이 있으면 종전대로 보이게 한다');
  }
  console.log('staleRenderGuard ok');
})().catch(e => { console.error(e); process.exit(1); });
