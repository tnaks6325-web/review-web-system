#!/usr/bin/env node
/**
 * 발행 프리필 규칙(`frontend/js/work-order-detail.js` 의 `_woCampaignPrefill` 과 그 의존 함수)을
 * **글자 그대로** 잘라 서버 모듈 `src/utils/woCampaignPrefill.generated.js` 로 만든다.
 *
 * ★★ 왜 손으로 옮기지 않나 — 양방향 동기화(결정 263)는 "오더 → 공고" 변환을 서버가 해야 한다.
 *    Railway 는 `server/` 만 배포하므로 화면 파일을 실행 시점에 읽을 수 없다. 손 사본은 28개 함수·
 *    545줄이라 한쪽만 고치는 순간 "발행할 때와 동기화할 때 공고가 다르게 나온다" 로 갈린다.
 *    그래서 사본을 **기계가 만든다** — 회귀가드(`tests/woCampaignPrefillGenerated.test.js`)가
 *    이 스크립트를 메모리에서 다시 돌려 저장된 파일과 한 글자라도 다르면 실패한다.
 *
 * 실행: node scripts/gen-wo-campaign-prefill.js          (파일 갱신)
 *       node scripts/gen-wo-campaign-prefill.js --check  (다르면 종료코드 1)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'js', 'work-order-detail.js');
const OUT = path.join(__dirname, '..', 'src', 'utils', 'woCampaignPrefill.generated.js');
const ROOT_FN = '_woCampaignPrefill';

/** 브라우저 전역 자리를 채우는 무해한 가짜 — 화면 파일이 읽기만 해도 터지지 않게. */
function _browserStub() {
  const stub = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}

/**
 * 최상위 선언(function / const / let / var) 이름 → 원문 조각. 첫 선언만 쓴다.
 * ★ 함수 끝은 **글자로 세지 않는다** — 한 줄 함수 뒤의 `}` 나 정규식 속 괄호에 속는다(실제로 한 번 속았다).
 *   화면 파일을 vm 에서 실제로 실행해 V8 이 돌려주는 `Function.prototype.toString`(= 원문 그대로)을 쓴다.
 *   파일 전체가 즉시실행 함수 안이라, 그 끝에 이름표를 꺼내는 한 줄을 끼워 넣는다(원본 파일은 건드리지 않는다).
 * ★ 상수(const)는 실행 값이 아니라 원문이 필요하다 — 괄호 깊이 0 의 `;` 까지 자른다(정규식·함수 없는 표만 있다).
 */
function topLevelDefs(src) {
  const found = [];
  const re = /^(?:function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=)/gm;
  let m;
  while ((m = re.exec(src))) found.push({ name: m[1] || m[2], isFn: !!m[1], start: m.index });
  const tail = src.lastIndexOf('})();');
  if (tail < 0) throw new Error('화면 파일이 즉시실행 함수 형태가 아니다 — 생성기를 고쳐야 한다');
  const names = [...new Set(found.map(f => f.name))];
  const probe = 'globalThis.__woDefs = {' + names.map(n => `${n}: (typeof ${n} !== "undefined" ? ${n} : undefined)`).join(', ') + '};\n';
  const sandbox = { console, window: {}, document: _browserStub(), localStorage: _browserStub(), navigator: _browserStub(), URL, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, tail) + probe + src.slice(tail), sandbox);
  const live = sandbox.__woDefs || {};
  const defs = new Map();
  for (const f of found) {
    if (defs.has(f.name)) continue;
    let body;
    if (f.isFn) {
      if (typeof live[f.name] !== 'function') throw new Error(`${f.name} 원문을 꺼내지 못했다`);
      body = Function.prototype.toString.call(live[f.name]);
      if (src.indexOf(body, f.start) !== f.start) throw new Error(`${f.name} 원문이 파일 글자와 다르다`);
    } else {
      let depth = 0, i = f.start;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth === 0) break;
      }
      body = src.slice(f.start, i + 1);
    }
    defs.set(f.name, { start: f.start, body });
  }
  return defs;
}

/** ROOT_FN 이 직·간접으로 부르는 최상위 선언 전부(원문 순서). */
function closure(defs, root) {
  if (!defs.has(root)) throw new Error(`${root} 를 찾지 못했다 — 화면 파일 구조가 바뀌었다`);
  const need = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const name = queue.pop();
    for (const id of new Set(defs.get(name).body.match(/\b[_A-Za-z]\w*\b/g) || [])) {
      if (id !== name && defs.has(id) && !need.has(id)) { need.add(id); queue.push(id); }
    }
  }
  return [...need].sort((a, b) => defs.get(a).start - defs.get(b).start);
}

function generate() {
  const src = fs.readFileSync(SRC, 'utf8');
  const defs = topLevelDefs(src);
  const names = closure(defs, ROOT_FN);
  const bodies = names.map(n => defs.get(n).body);
  const joined = bodies.join('\n\n');
  // 브라우저 전용 전역을 쓰는 함수가 끼면 서버에서 조용히 다르게 돈다 — 만들지 않는다.
  const browserOnly = joined.match(/\b(document|window|localStorage|sessionStorage|location|navigator|fetch)\b/);
  if (browserOnly) throw new Error(`프리필 의존 함수가 브라우저 전역(${browserOnly[1]})을 쓴다 — 서버 사본을 만들 수 없다`);
  const fnNames = names.filter(n => /^function\s/.test(defs.get(n).body));
  return [
    '/* eslint-disable */',
    "'use strict';   // 원본이 즉시실행 함수 안 \"use strict\" 라 같은 모드로 돈다",
    '// ★★★ 자동 생성 파일 — 손으로 고치지 말 것.',
    '// 원본: frontend/js/work-order-detail.js 의 _woCampaignPrefill 과 의존 선언(글자 그대로).',
    '// 다시 만들기: node scripts/gen-wo-campaign-prefill.js · 가드: tests/woCampaignPrefillGenerated.test.js',
    '',
    joined,
    '',
    `module.exports = { ${fnNames.join(', ')} };`,
    '',
  ].join('\n');
}

if (require.main === module) {
  const next = generate();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (cur !== next) { console.error('woCampaignPrefill.generated.js 가 화면 원본과 다릅니다 — node scripts/gen-wo-campaign-prefill.js'); process.exit(1); }
    console.log('ok');
  } else {
    fs.writeFileSync(OUT, next);
    console.log(`written ${path.relative(process.cwd(), OUT)} (${next.split('\n').length} lines)`);
  }
}

module.exports = { generate, OUT, SRC };
