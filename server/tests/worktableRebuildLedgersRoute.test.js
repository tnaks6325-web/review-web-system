/**
 * worktableRebuildLedgersRoute.test.js — 회귀가드: 무시트 장부 재생성 창구
 * 실행: node tests/worktableRebuildLedgersRoute.test.js
 *
 * 배경(운영 실측 2026-08-19 · 장수산업 8/19 다섯 줄): 작업표 줄이 잘못 내려간 뒤 DB 에서
 *   되살려도 **장부(review_index)를 다시 만들 창구가 없어** 리뷰어 검색 명단·리뷰비 입금 대상에
 *   그 줄이 돌아오지 않았다. 재생성은 정리·이관·접수의 부수효과로만 일어났다(복구의 막다른 길).
 *
 * 고정하는 것:
 *  A. 라우터에 실제로 등록돼 있고 게이트가 adminOrMaster (라우터 스택 실검사)
 *  B. 판정 사본 0 — `rebuildLedgers` 를 그대로 부른다(무시트 게이트를 여기서 다시 만들지 않는다)
 *  C. dryRun 기본 — 값이 빠진 요청이 곧바로 실행되지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const PATH = '/worktable/rebuild-ledgers';

console.log('\n[A] 라우터 스택 실검사 — 등록 · 게이트');
{
  const router = require('../src/routes/trackB.routes');
  const layer = (router.stack || []).find(l => l.route && l.route.path === PATH);
  ok('POST ' + PATH + ' 가 등록돼 있다', !!layer);
  ok('POST 메서드', !!(layer.route.methods && layer.route.methods.post));
  const names = layer.route.stack.map(s => s.name);
  ok('authMiddleware 를 먼저 탄다', names[0] === 'authMiddleware', names.join(','));
  ok('adminOrMaster 게이트', names.some(n => /adminOrMaster/i.test(n)), names.join(','));
  ok('★ internal/editorOnly 로 넓히지 않았다(줄 정리와 달리 장부를 통째로 다시 만든다)',
    !names.some(n => /^internalMiddleware$|editorOnly/i.test(n)), names.join(','));
}

console.log('\n[B] 본문 계약 — 판정 사본 0 · dryRun 기본');
{
  const src = read('src/routes/trackB.routes.js');
  const i = src.indexOf(`router.post('${PATH}'`);
  ok('라우트 본문을 찾는다', i > 0);
  const next = src.indexOf('\nrouter.', i + 10);
  const body = src.slice(i, next > 0 ? next : src.length);

  ok('★ rebuildLedgers 를 그대로 부른다', /rebuildLedgers\(\{/.test(body));
  ok('★ 무시트 여부를 라우트에서 다시 판정하지 않는다(사본 0)',
    !/sheetless/i.test(body.replace(/^\s*\/\*[\s\S]*?\*\//, '')) || !/SELECT[\s\S]*sheetless/i.test(body));
  ok('★ dryRun 기본 — 미전송이면 미리보기', /dryRun:\s*b\.dryRun\s*!==\s*false/.test(body));
  ok('LedgerError 는 400 대로 매핑(errorHandler 500 마스킹 방지)',
    /instanceof LedgerError[\s\S]{0,120}status\(400\)/.test(body));
  ok('42P01/42703 은 not_ready 로 안내', /42P01[\s\S]{0,160}not_ready/.test(body));
  ok('★ 이 라우트는 campaign_participants 에 직접 쓰지 않는다',
    !/(UPDATE|DELETE FROM|INSERT INTO)\s+campaign_participants/i.test(body));
}

console.log(`\n✅ worktableRebuildLedgersRoute — ${passed} 케이스 통과`);
process.exit(0);
