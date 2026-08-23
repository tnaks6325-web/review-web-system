/**
 * managerNameCleanup.test.js — 담당자 표기 통일(★ 065 후속) 회귀가드.
 *
 * 사고(2026-08-23 신고): 홈 작업목록 담당자 칩이 **만두 / 망고 / 박세희 / 박은비** 넷으로 갈렸다.
 *   원인 = ① 065 **이전** 접수가 `tab_configs.manager` 에 담당AE 실명을 그대로 넣었고
 *          ② 접수 업서트가 blank-only 라 재접수로도 영영 안 고쳐지며
 *          ③ 탭 설정 저장은 값을 **자유 문자열 그대로** 받았고
 *          ④ 화면은 그 원문을 정규화 없이 distinct 해 칩으로 만든다.
 *
 * 이 가드가 고정하는 것:
 *   A. 저장 직전 정규화(`normalizeManagerForStore`) — 실명은 접고, **모르는 이름은 보존**한다.
 *      (`mapWorkManager` 의 '' fail-safe 를 저장 경로에 쓰면 자유입력 담당자가 조용히 지워진다)
 *   B. 탭 설정 저장 두 경로(본 칸·round_meta)가 그 함수를 통과한다.
 *   C. 일회성 정리 창구 — **미리보기는 쓰기 0**, 실행은 `manager` 한 칸만, 매핑 밖 값 무접촉.
 *   D. 라우터 스택 실검사(원본 + Track B 프록시, 둘 다 admin/master).
 *   E. 화면 배선(설정 패널 등록·경로·확인창).
 *
 * 실행: node tests/managerNameCleanup.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

/* 스텁 pool — 라우트를 **실제로 실행**한다. 정적 검사만으로는 `if (false && …)` 를 통과시킨다. */
const _poolPath = require.resolve('../src/db/pool');
let _calls = [];
let _rowsFor = () => ({ rows: [] });
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      _calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return _rowsFor(String(sql), params);
    },
  },
};

let n = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  n++; console.log('  ✓ ' + name);
};
const writes = () => _calls.filter(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql));

const wm = require('../src/utils/workManager');
const TAB_SRC = read('src/routes/tabconfig.routes.js');
const DIAG = read('src/routes/diag.routes.js');
const TB = read('src/routes/trackB.routes.js');
const AS = readF('js/admin-settings.js');

/** 라우트 본문만 잘라낸다 — 파일 전체로 보면 다른 라우트의 같은 표현이 대신 통과시킨다. */
function routeBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '라우트를 찾지 못함: ' + decl);
  const j = src.indexOf('\nrouter.', i + 10);
  return src.slice(i, j > i ? j : src.length);
}

(async () => {
  // ── A. 저장 직전 정규화(순수함수 실행) ────────────────────────
  console.log('\n[A] normalizeManagerForStore');
  const norm = wm.normalizeManagerForStore;
  ok('박세희 → 만두', norm('박세희') === '만두');
  ok('박은비 → 망고', norm('박은비') === '망고');
  ok('표기 흔들림도 같은 규칙으로 접는다', norm('박 세희') === '만두' && norm('박은비(망고)') === '망고');
  ok('앞뒤 공백 흡수', norm(' 박세희 ') === '만두');
  ok('이미 닉네임이면 그대로', norm('만두') === '만두' && norm('망고') === '망고');
  ok('★★ 모르는 이름은 원문 보존(빈 값으로 접으면 자유입력 담당자가 조용히 지워진다)',
    norm('홍길동') === '홍길동' && norm('이만수') === '이만수');
  ok('★ 빈 값은 빈 값 — 저장에서 \'\' 는 "해제"라는 다른 뜻이다',
    norm('') === '' && norm(null) === '' && norm(undefined) === '' && norm('   ') === '');
  ok('판정 사본 0 — mapWorkManager 를 그대로 쓴다',
    /return mapWorkManager\(v\) \|\| v;/.test(read('src/utils/workManager.js')));

  // ── B. 탭 설정 저장 배선 ─────────────────────────────────────
  console.log('\n[B] 탭 설정 저장이 정규화를 통과한다');
  ok('본 칸(manager) 저장이 normalizeManagerForStore 경유',
    /manager:\s+b\.manager\s+!== undefined \? normalizeManagerForStore\(b\.manager\)/.test(TAB_SRC));
  ok('★ 원문 직행(b.manager 그대로 저장)이 남아 있지 않다',
    !/manager:\s+b\.manager\s+!== undefined \? b\.manager\b/.test(TAB_SRC));
  ok('round_meta 의 담당자도 같은 규칙(사본 금지)',
    /apiKey === 'manager'\) \? normalizeManagerForStore\(b\[apiKey\]\)/.test(TAB_SRC));
  ok('미전송(undefined)은 종전대로 기존값 보존', /b\.manager\s+!== undefined \?/.test(TAB_SRC));

  // ── C. 일회성 정리 창구(실제 실행) ───────────────────────────
  console.log('\n[C] /api/diag/manager-cleanup');
  const diagRouter = require('../src/routes/diag.routes');
  const layer = diagRouter.stack.find(l => l.route && l.route.path === '/manager-cleanup');
  ok('라우트가 등록돼 있다', !!layer);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const run = async (body) => {
    _calls = []; let out = null;
    await handler({ body }, { json: (x) => { out = x; } }, (e) => { throw e; });
    return out;
  };
  /* 실데이터 모양: 실명·닉네임·자유입력이 섞여 있다. */
  _rowsFor = (sql) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [
      { raw: '만두', cnt: 40 }, { raw: '망고', cnt: 31 },
      { raw: '박세희', cnt: 7 }, { raw: '박은비', cnt: 5 }, { raw: '홍길동', cnt: 2 }] };
    if (/FROM recruit_campaigns/.test(sql)) return { rows: [{ raw: '박은비', cnt: 3 }] };
    return { rowCount: 1, rows: [] };
  };
  {
    const r = await run({});                       // 기본 = 미리보기
    ok('기본이 dryRun 이다(명시하지 않아도 미리보기)', r.dryRun === true);
    ok('★★ 미리보기는 쓰기 0건', writes().length === 0, writes().map(w => w.sql));
    ok('대상 집계 = 실명만(닉네임·자유입력 제외)', r.total === 15, r.total);
    ok('두 테이블 모두 훑는다', r.preview.some(p => p.table === 'tab_configs')
      && r.preview.some(p => p.table === 'recruit_campaigns'));
    ok('★ 이미 닉네임인 값은 대상 아님', !r.preview.some(p => p.from === '만두' || p.from === '망고'));
    ok('★★ 모르는 이름은 대상 아님(자유입력 담당자 보호)', !r.preview.some(p => p.from === '홍길동'));
    ok('바뀔 값을 화면이 읽을 수 있게 from/to/cnt 를 준다',
      r.preview.every(p => p.from && p.to && typeof p.cnt === 'number'));
  }
  {
    const r = await run({ dryRun: false });
    const w = writes();
    ok('실행하면 대상 수만큼만 UPDATE(3건)', w.length === 3, w.map(x => x.sql));
    ok('★★ 쓰기 표면 = manager 한 칸 (updated_at 도 안 건드린다)',
      w.every(x => /^UPDATE (tab_configs|recruit_campaigns) SET manager = \$2 WHERE manager = \$1$/.test(x.sql)),
      w.map(x => x.sql));
    ok('★ 정확일치로만 바꾼다(LIKE·ILIKE 금지)', !w.some(x => /LIKE/i.test(x.sql)));
    ok('파라미터가 미리보기와 같은 값', w.some(x => x.params[0] === '박세희' && x.params[1] === '만두')
      && w.some(x => x.params[0] === '박은비' && x.params[1] === '망고'));
    ok('응답이 실제 반영 건수를 말한다', r.dryRun === false && r.updated === 3);
  }
  {
    _rowsFor = () => ({ rows: [{ raw: '만두', cnt: 9 }] });
    const r = await run({ dryRun: false });
    ok('★ 대상 0건이면 실행 요청이어도 쓰기 0건 + 사실을 말한다',
      writes().length === 0 && r.total === 0 && /없습니다/.test(r.note || ''));
  }
  ok('★ 판정은 workManager 단일 출처 — SQL 에 실명을 박지 않았다',
    !/'박세희'|'박은비'/.test(routeBody(DIAG, "router.post('/manager-cleanup'")
      .replace(/^\s*\/\/.*$/gm, '')));   // 주석(배경 설명)은 제외하고 본다

  // ── D. 라우터·권한 ───────────────────────────────────────────
  console.log('\n[D] 권한·프록시');
  ok('원본은 admin/master 전용',
    /router\.post\('\/manager-cleanup', authMiddleware, adminOrMasterMiddleware/.test(DIAG));
  ok('Track B 프록시도 같은 게이트(넓어지지 않는다)',
    /router\.post\('\/settings\/manager-cleanup', authMiddleware, adminOrMasterMiddleware/.test(TB));
  ok('★ 프록시는 원본 핸들러를 그대로 태운다(로직 복제 0)',
    /managerCleanup: _delegate\(require\('\.\/diag\.routes'\), 'post', '\/manager-cleanup'\)/.test(TB));
  {
    const tbRouter = require('../src/routes/trackB.routes');
    const l = tbRouter.stack.find(x => x.route && x.route.path === '/settings/manager-cleanup' && x.route.methods.post);
    ok('Track B 스택에 실제로 올라가 있다', !!l);
  }

  // ── E. 화면 배선 ─────────────────────────────────────────────
  console.log('\n[E] 설정 패널');
  ok('패널·로더·목차에 등록', /managercleanup: _managerCleanupHtml/.test(AS)
    && /managercleanup: loadManagerCleanup/.test(AS) && /managercleanup: \{ ic: '👥'/.test(AS));
  ok('경로는 Track B(양쪽 호스트 공용)', /var MGC_EP = '\/api\/trackb\/settings\/manager-cleanup'/.test(AS));
  ok('★ 적용은 confirm 을 거친다', /if \(!dryRun && !confirm\(/.test(AS));
  ok('★ [적용하기] 는 미리보기 전엔 숨김', /id="mgcApplyBtn" style="display:none"/.test(AS));
  ok('★ 펼칠 때 자동 실행하지 않는다',
    /function loadManagerCleanup\(\) \{ _setNavBadge\('managercleanup', '점검'\); \}/.test(AS));
  ok('전역 노출(onclick 이 부른다)', /window\.managerCleanupRun = managerCleanupRun/.test(AS));
  ok('시트발·DB발 문자열은 escape 해서 그린다', /escHtml\(r\.from\)/.test(AS) && /escHtml\(r\.to\)/.test(AS));
  ok('관리자 화면 두 곳에 패널이 붙는다',
    /'reviewtype','managercleanup'/.test(readF('workdesk.html'))
    && /'reviewtype', 'managercleanup'/.test(readF('admin.html')));

  console.log(`\n✅ managerNameCleanup — ${n} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
