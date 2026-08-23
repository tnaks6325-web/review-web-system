/**
 * 저장소 트리 위생 가드 (2026-08-23).
 *
 * 배경: 워크트리에서 테스트를 돌리려고 `node_modules` **심볼릭 링크**를 만들었는데,
 *   `.gitignore` 의 `node_modules/` 는 **디렉터리에만** 걸려 심링크가 그대로 커밋됐다
 *   (merge 7dd58b3). 절대경로를 가리키는 링크라 배포 머신에는 그 경로가 없고,
 *   Railway 서버 서비스 2건이 배포 실패했다. 로컬 테스트는 366개 전부 초록이었다 —
 *   테스트는 트리에 무엇이 들어갔는지 보지 않기 때문이다. 그 사각을 여기서 막는다.
 *
 *   §1 추적되는 파일에 node_modules 경로가 없다
 *   §2 추적되는 심볼릭 링크는 저장소 밖(절대경로)을 가리키지 않는다
 *   §3 .gitignore 규칙이 심링크까지 막는다(슬래시 없이)
 *
 * 실행: node tests/repoTreeHygiene.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 저장소 트리 위생\n');

/** git 이 없는 환경(배포 이미지 등)에서는 §1·§2 를 건너뛴다 — 없는 도구로 빨개지면 안 된다. */
let tracked = null;
try {
  tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-s'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (_) { /* git 없음 */ }

if (tracked) {
  console.log('1) 추적 파일');
  const nm = tracked.filter(l => /(^|\/)node_modules(\/|$)/.test(l.split('\t')[1] || ''));
  t('★★ node_modules 가 트리에 없다 — 들어가면 배포 머신에서 설치가 깨진다',
    nm.length === 0, nm.join(' | '));

  console.log('\n2) 심볼릭 링크');
  // `git ls-files -s` 의 모드 120000 = 심링크. blob 내용이 링크 대상 경로다.
  const links = tracked.filter(l => l.startsWith('120000 '));
  const escaping = links.filter(l => {
    const sha = l.split(/\s+/)[1];
    const target = execFileSync('git', ['-C', ROOT, 'cat-file', '-p', sha], { encoding: 'utf8' });
    return path.isAbsolute(target.trim());
  });
  t('★ 절대경로 심링크가 없다 — 이 머신에만 있는 경로는 다른 머신에서 끊긴 링크가 된다',
    escaping.length === 0, escaping.join(' | '));
} else {
  console.log('1~2) git 없음 — 건너뜀');
}

console.log('\n3) .gitignore');
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
t('★ node_modules 규칙에 슬래시가 없다(디렉터리와 심링크를 함께 막는다)',
  /^node_modules$/m.test(gi) && !/^node_modules\/$/m.test(gi));

console.log(`\n▶ ${pass}건 통과`);
console.log('repoTreeHygiene tests passed');
