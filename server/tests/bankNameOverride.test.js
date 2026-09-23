/**
 * 회귀가드 — 🏦 은행 이름 설정(정식명·자동인식 표기 인라인 관리)
 *
 * 이 기능이 지키는 것은 하나다: **표기 하나가 두 은행을 가리키면 남의 계좌로 돈이 간다.**
 * 그래서 검사도 "규칙이 살아 있는가"에 집중한다.
 *
 *  §1 판정 규칙 불변: 정확일치만 · 모르면 null · 오버레이 미로드 = 기본 동작 100%
 *  §2 오버레이 적용: 표기 추가/삭제/이름변경/신규기관을 **실제 실행**해 확인
 *  §3 겹침 = 저장 차단(유일한 하드블록) — 기본 별칭을 다른 은행에 얹는 "조용한 이동" 금지
 *  §4 서비스: 스텁 pool 로 load/save **실제 실행**(fail-open 유지·stale·이력)
 *  §5 라우트: 라우터 스택 실검사 + adminOrMaster
 *  §6 소비처 배선: 입금대상·서식 생성·계좌 검증이 오버레이를 적용하고 판정한다
 *  §7 프론트: 서브탭·저장 페이로드·IME·onclick 인덱스·정규화 사본 일치
 *
 * 실행: node tests/bankNameOverride.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const SRC = p => path.join(__dirname, '..', 'src', p);
const read = p => fs.readFileSync(SRC(p), 'utf8');
const readRoot = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const noLineComments = s => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

const BC = require(SRC('utils/bankCodes'));
const reset = () => BC.setBankOverrides(null);

/* 스텁 pool 로 서비스 실행 — 서비스는 `require('../db/pool')` 로 직접 받는다. */
async function withStubPool(handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const svcPath = require.resolve(SRC('services/bankNameOverride.service'));
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params, calls) || { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[svcPath];
  // ★ **await 한 뒤** 복원해야 한다 — sync try/finally 는 run 의 첫 await 에서 즉시 finally 로
  //   내려가 스텁·오버레이를 걷어 버려, 테스트가 엉뚱한 이유로 통과·실패한다(이 파일에서 실측).
  try { return await run(require(svcPath), calls); }
  finally {
    delete require.cache[svcPath];
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
    reset();
  }
}

/** workdesk.html 인라인 스크립트에서 함수 블록을 잘라 vm 으로 실행한다. */
function grabFns(src, names) {
  const out = [];
  for (const n of names) {
    const i = src.indexOf('function ' + n + '(');
    assert.ok(i >= 0, n + ' 함수를 찾지 못했습니다');
    let d = 0, started = false, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') { d++; started = true; }
      else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
    }
    out.push(src.slice(i, j));
  }
  return out.join('\n');
}

(async function main() {

/* ══════════════ §1 판정 규칙 불변 ══════════════ */
console.log('\n§1 판정 규칙 — 정확일치만 · 모르면 null · 오버레이 미로드 = 기본 동작');

t('1a 기본 표기는 그대로 해석된다', () => {
  reset();
  assert.deepStrictEqual(BC.resolveBank('신한'), { code: '088', name: '신한은행' });
  assert.deepStrictEqual(BC.resolveBank('카뱅'), { code: '090', name: '카카오뱅크' });
  assert.deepStrictEqual(BC.resolveBank('081'), { code: '081', name: '하나은행' });
});

t('1b ★ 부분일치 금지 — "하나"가 하나증권(270)으로 새지 않는다', () => {
  reset();
  assert.strictEqual(BC.resolveBank('하나').code, '081');
  assert.strictEqual(BC.resolveBank('하나증권').code, '270');
});

t('1c 모르는 표기는 추측하지 않고 null', () => {
  reset();
  assert.strictEqual(BC.resolveBank('대구아이엠뱅크'), null);
  assert.strictEqual(BC.resolveBank('없는은행'), null);
});

t('1d ★ 오버레이 미로드 = 기본 동작 100%(fail-open) — 조회가 죽어도 판정은 산다', () => {
  reset();
  const before = BC.bankTable().length;
  BC.setBankOverrides(undefined);
  assert.strictEqual(BC.bankTable().length, before);
  assert.strictEqual(BC.resolveBank('신한').code, '088');
});

t('1e 제공 엑셀 대조 보강분이 기본 표에 들어 있다(옛 이름 포함)', () => {
  reset();
  const want = {
    '한국씨티': '027', 'HSBC': '054', '도이치': '055', 'BOA': '060', 'BNP파리바': '061',
    '미래에셋': '238', '미래에셋대우': '238', '에스케이증권': '266', '한화증권': '269',
    '동부증권': '279', '메리츠종금': '287', 'LIG투자증권': '292', '펀드온라인코리아': '294',
  };
  for (const [k, code] of Object.entries(want)) {
    const r = BC.resolveBank(k);
    assert.ok(r && r.code === code, `${k} → ${code} 여야 하는데 ${r && r.code}`);
  }
});

t('1f ★ 겹치는 옛 코드 표기는 기본 표에 넣지 않았다(우리 022 · 국민 019 · NH투자 289)', () => {
  reset();
  // 022/019/053/289/271(IBK) 은 같은 말이 두 코드에 걸려 그대로 넣으면 남의 계좌로 간다.
  const src = read('utils/bankCodes.js');
  const aliasBlock = src.slice(src.indexOf('const ALIASES'), src.indexOf('const _byCode'));
  for (const bad of ["'022'", "'019'", "'053'", "'289'"]) {
    assert.ok(!aliasBlock.includes(': ' + bad), `별칭 표에 ${bad} 가 들어갔다 — 겹침 코드는 넣지 않는다`);
  }
});

/* ══════════════ §2 오버레이 적용 ══════════════ */
console.log('\n§2 오버레이 — 표기 추가/삭제 · 이름 변경 · 신규 기관');

t('2a 표기를 추가하면 그 표기로 해석된다', () => {
  reset();
  BC.setBankOverrides({ banks: { '031': { add: ['대구아이엠뱅크'] } } });
  assert.deepStrictEqual(BC.resolveBank('대구아이엠뱅크'), { code: '031', name: '대구은행' });
  reset();
  assert.strictEqual(BC.resolveBank('대구아이엠뱅크'), null, '오버레이를 걷으면 원래대로');
});

t('2b 기본 표기를 지우면 더 이상 해석되지 않는다', () => {
  reset();
  assert.strictEqual(BC.resolveBank('케뱅').code, '089');
  BC.setBankOverrides({ banks: { '089': { del: ['케뱅'] } } });
  assert.strictEqual(BC.resolveBank('케뱅'), null);
  reset();
});

t('2c ★ 이름을 바꾸면 **이체 서식에 나가는 정식명**이 함께 바뀐다', () => {
  reset();
  assert.strictEqual(BC.bankNameByCode('031'), '대구은행');
  BC.setBankOverrides({ banks: { '031': { name: 'iM뱅크' } } });
  assert.strictEqual(BC.bankNameByCode('031'), 'iM뱅크');
  assert.strictEqual(BC.resolveBank('iM뱅크').code, '031', '새 이름으로도 찾힌다');
  assert.strictEqual(BC.resolveBank('대구은행').code, '031', '옛 이름도 계속 찾힌다(같은 코드 = 겹침 아님)');
  reset();
});

t('2d 표에 없는 신규 기관을 추가할 수 있다', () => {
  reset();
  BC.setBankOverrides({ extra: [{ code: '999', name: '테스트은행' }], banks: { '999': { add: ['테스트'] } } });
  assert.deepStrictEqual(BC.resolveBank('테스트'), { code: '999', name: '테스트은행' });
  assert.strictEqual(BC.bankNameByCode('999'), '테스트은행');
  assert.strictEqual(BC.resolveBank('999').code, '999');
  reset();
});

t('2e 화면 목록(bankTable)이 기본/추가 표기를 구분하고 baseAliases 를 함께 준다', () => {
  reset();
  BC.setBankOverrides({ banks: { '089': { add: ['케이비'], del: ['케뱅'] } } });
  const row = BC.bankTable().find(r => r.code === '089');
  assert.ok(row.aliases.some(a => a.v === '케이비' && a.base === false), '추가 표기는 base=false');
  assert.ok(!row.aliases.some(a => a.v === '케뱅'), '지운 기본 표기는 목록에서 빠진다');
  assert.ok(row.baseAliases.includes('케뱅'), '★ baseAliases 에는 남아 있어야 화면이 del 을 계산한다');
  reset();
});

t('2f 형식이 아닌 저장값은 조용히 무시(코드 3자리 아님·이름 빈 값)', () => {
  reset();
  BC.setBankOverrides({ banks: { 'xx': { add: ['아무거나'] } }, extra: [{ code: '12', name: 'x' }] });
  assert.strictEqual(BC.resolveBank('아무거나'), null);
  reset();
});

/* ══════════════ §3 겹침 = 저장 차단 ══════════════ */
console.log('\n§3 겹침 — 저장을 막는 유일한 하드블록');

t('3a 같은 표기를 두 은행에 넣으면 저장 불가', () => {
  const r = BC.validateBankOverrides({ banks: { '088': { add: ['국민'] } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'conflict');
  assert.ok(/국민/.test(r.error) && /004/.test(r.error) && /088/.test(r.error));
});

t('3b ★★ 기본 표기를 다른 은행에 얹는 것은 "조용한 이동"이 아니라 겹침이다(완화 금지)', () => {
  // 오타 한 번으로 '국민'이 통째로 신한을 가리키면 그 리뷰어들 돈이 전부 다른 은행으로 간다.
  const r = BC.validateBankOverrides({ banks: { '088': { add: ['국민'] } } });
  assert.strictEqual(r.ok, false, '이동 허용으로 되돌리면 안 된다');
  const moved = BC.validateBankOverrides({ banks: { '004': { del: ['국민'] }, '088': { add: ['국민'] } } });
  assert.strictEqual(moved.ok, true, '원래 은행에서 먼저 지우면(명시적) 허용');
});

t('3c 이름을 다른 은행 이름과 같게 바꾸면 저장 불가', () => {
  const r = BC.validateBankOverrides({ banks: { '081': { name: '신한은행' } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'conflict');
});

t('3d 신규 기관 이름이 기존 은행과 같아도 저장 불가', () => {
  const r = BC.validateBankOverrides({ extra: [{ code: '999', name: '국민은행' }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'conflict');
});

t('3e 숫자만 있는 표기는 거부(코드 조회가 먼저라 영원히 도달 못 한다)', () => {
  const r = BC.validateBankOverrides({ banks: { '031': { add: ['031'] } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'bad_input');
});

t('3f 표에 없는 코드·이미 있는 코드로 신규 기관을 만들 수 없다', () => {
  assert.strictEqual(BC.validateBankOverrides({ banks: { '777': { add: ['x'] } } }).ok, false);
  assert.strictEqual(BC.validateBankOverrides({ extra: [{ code: '004', name: '뭐든' }] }).ok, false);
});

t('3g 정상 입력은 정규화된 clean 을 돌려준다(중복 표기 접힘)', () => {
  const r = BC.validateBankOverrides({ banks: { '031': { add: ['대구아이엠뱅크', '대구 아이엠뱅크', ''] } } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.clean.banks['031'].add, ['대구아이엠뱅크'], '정규화 동일 표기는 하나만');
});

t('3h 검증은 전역 표를 오염시키지 않는다(적용은 setBankOverrides 로만)', () => {
  reset();
  BC.validateBankOverrides({ banks: { '031': { add: ['대구아이엠뱅크'] } } });
  assert.strictEqual(BC.resolveBank('대구아이엠뱅크'), null, '검증만으로 판정이 바뀌면 안 된다');
});

/* ══════════════ §4 서비스 ══════════════ */
console.log('\n§4 서비스 — load(fail-open) · save(검증·stale·이력)');

await ta('4a 저장값을 읽어 판정 표에 적용한다', async () => {
  await withStubPool(
    (sql) => /SELECT value/.test(sql)
      ? { rows: [{ value: JSON.stringify({ banks: { '031': { add: ['대구아이엠뱅크'] } } }), updated_at: new Date('2026-08-10T00:00:00Z') }] }
      : { rows: [] },
    async (svc) => {
      await svc.ensureBankOverrides(true);
      assert.strictEqual(BC.resolveBank('대구아이엠뱅크').code, '031');
    });
});

await ta('4b ★ 조회 실패는 직전 표를 유지한다(fail-open · throw 금지)', async () => {
  await withStubPool(
    (sql) => { if (/SELECT value/.test(sql)) throw Object.assign(new Error('db down'), { code: '57P01' }); return { rows: [] }; },
    async (svc) => {
      BC.setBankOverrides({ banks: { '031': { add: ['대구아이엠뱅크'] } } });
      await svc.ensureBankOverrides(true);          // 던지면 여기서 실패
      assert.strictEqual(BC.resolveBank('대구아이엠뱅크').code, '031', '실패했다고 표를 비우면 안 된다');
    });
});

await ta('4c 저장 — 겹침이면 쓰기 쿼리 0', async () => {
  await withStubPool(
    (sql) => /SELECT value/.test(sql) ? { rows: [] } : { rows: [] },
    async (svc, calls) => {
      const out = await svc.saveBankOverrides({ payload: { banks: { '088': { add: ['국민'] } } }, by: '테스터' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'conflict');
      assert.strictEqual(calls.filter(c => /INSERT INTO app_settings/i.test(c.sql)).length, 0, '겹침인데 저장했다');
    });
});

await ta('4d 저장 — 검증 통과분만 app_settings 한 키에 쓴다(쓰기 표면)', async () => {
  await withStubPool(
    (sql) => /SELECT value/.test(sql) ? { rows: [] } : { rows: [] },
    async (svc, calls) => {
      const out = await svc.saveBankOverrides({ payload: { banks: { '031': { add: ['대구아이엠뱅크'] } } }, by: '테스터' });
      assert.strictEqual(out.ok, true);
      const writes = calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.sql));
      assert.strictEqual(writes.length, 1, '쓰기는 한 곳뿐이어야 한다: ' + writes.map(w => w.sql.slice(0, 40)));
      assert.ok(/app_settings/.test(writes[0].sql));
      assert.strictEqual(writes[0].params[0], svc.SETTING_KEY);
      const saved = JSON.parse(writes[0].params[1]);
      assert.deepStrictEqual(saved.banks['031'].add, ['대구아이엠뱅크']);
      assert.ok(Array.isArray(saved.log) && saved.log.length >= 1, '이력을 남긴다');
      assert.strictEqual(saved.log[0].by, '테스터');
    });
});

await ta('4e 저장 — 다른 사람이 먼저 저장했으면 거부(stale · 쓰기 0)', async () => {
  await withStubPool(
    (sql) => /SELECT value/.test(sql)
      ? { rows: [{ value: '{}', updated_at: new Date('2026-08-10T05:00:00Z') }] } : { rows: [] },
    async (svc, calls) => {
      const out = await svc.saveBankOverrides({
        payload: { banks: {} }, by: 'B', rev: '2026-08-10T01:00:00.000Z',
      });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'stale');
      assert.strictEqual(calls.filter(c => /INSERT INTO app_settings/i.test(c.sql)).length, 0);
    });
});

t('4f 이력 diff — 추가/삭제/이름변경을 구분해 남긴다', () => {
  const svc = require(SRC('services/bankNameOverride.service'));
  const log = svc._diffLog(
    { banks: { '031': { add: ['가'] } } },
    { banks: { '031': { add: ['나'], del: ['대구'] }, '089': { name: '케이' } } },
    '테스터');
  const acts = log.map(l => l.act).sort();
  assert.deepStrictEqual(acts, ['alias_add', 'alias_remove', 'base_off', 'rename'].sort());
  assert.ok(log.every(l => l.by === '테스터' && l.at));
});

/* ══════════════ §5 라우트 ══════════════ */
console.log('\n§5 라우트 — 경로 + adminOrMaster');

t('5a GET/POST /payment/bank-names 가 adminOrMaster 로 등록돼 있다', () => {
  const router = require(SRC('routes/trackB.routes'));
  const stack = router.stack.filter(l => l.route && l.route.path === '/payment/bank-names');
  assert.strictEqual(stack.length, 2, 'GET·POST 두 개여야 한다');
  const methods = stack.map(l => Object.keys(l.route.methods)[0]).sort();
  assert.deepStrictEqual(methods, ['get', 'post']);
  for (const l of stack) {
    const names = l.route.stack.map(h => h.name);
    assert.ok(names.includes('authMiddleware'), 'authMiddleware 누락 — 역할 미들웨어가 req.admin 을 못 읽는다');
    assert.ok(names.includes('adminOrMasterMiddleware'), 'adminOrMaster 누락 — 잘못 넣으면 남의 계좌로 돈이 간다');
  }
});

/* ══════════════ §6 소비처 배선 ══════════════ */
console.log('\n§6 소비처 — 입금대상 · 서식 생성 · 계좌 검증');

t('6a 세 진입점이 판정 전에 오버레이를 적용한다', () => {
  const src = noLineComments(read('services/payment.service.js'));
  for (const fn of ['listPaymentTargets', 'buildWorkbook', 'saveReviewerAccount']) {
    const i = src.indexOf('async function ' + fn + '(');
    assert.ok(i > 0, fn + ' 없음');
    const head = src.slice(i, i + 900);
    assert.ok(/ensureBankOverrides\(\)/.test(head),
      `${fn} 이 ensureBankOverrides 를 안 부른다 — 화면에서 넣은 표기가 반영되지 않는다`);
  }
});

t('6b 서식의 정식명은 코드에서 파생한다(리뷰어 원문 금지)', () => {
  const src = noLineComments(read('services/payment.service.js'));
  const i = src.indexOf('async function buildWorkbook(');
  const body = src.slice(i, src.indexOf('\nasync function', i + 10));
  assert.ok(/bankFormLabel\(code\)/.test(body), '서식에 bankFormLabel 이 아닌 값이 나가고 있다');
  assert.ok(!/bankNameByCode\(/.test(body),
    '서식이 bankFormLabel 을 우회하면 케이뱅크가 이름을 인식 못 하는 기관(031)이 다시 이름으로 나간다');
});

t('6c bankNameByCode 가 오버레이 이름을 돌려준다(서식이 옛 이름으로 나가지 않게)', () => {
  reset();
  BC.setBankOverrides({ banks: { '031': { name: 'iM뱅크' } } });
  assert.strictEqual(BC.bankNameByCode('031'), 'iM뱅크');
  reset();
});

/* ══════════════════════════════════════════════════════════════
   §6-D ★★ 케이뱅크가 **이름을 인식 못 하는** 기관은 서식에 코드로 나간다
   2026-08-21 실측(사용자): 031 대구은행은 `대구은행`·`대구`·`im뱅크`·`IM뱅크`
   어느 표기로도 업로드가 인식하지 못하고 표준코드 `031` 로만 통과한다.
   ══════════════════════════════════════════════════════════════ */
t('6d ★★ 031 은 서식에 코드로 나간다 — 이름을 고쳐도 코드가 이긴다', () => {
  reset();
  assert.strictEqual(BC.bankFormLabel('031'), '031', '대구은행이 이름으로 나가면 케이뱅크가 거부한다');
  assert.strictEqual(BC.bankFormLabel('31'), '031', '2자리로 들어와도 3자리로 맞춘다');
  BC.setBankOverrides({ banks: { '031': { name: 'iM뱅크' } } });
  assert.strictEqual(BC.bankFormLabel('031'), '031',
    '오버레이 이름이 이기면 막으려던 거부가 그대로 재현된다');
  assert.strictEqual(BC.bankNameByCode('031'), 'iM뱅크', '표시용 이름은 종전대로 오버레이 값');
  reset();
});

t('6e ★ 나머지 기관은 종전대로 이름으로 나간다(예외를 넓히지 않는다)', () => {
  reset();
  assert.strictEqual(BC.FORM_CODE_ONLY.size, 1, '코드로 내보내는 기관이 늘었다 — 은행이 거부한 것만 넣는다');
  for (const [c, n] of BC.BANKS) {
    if (c === '031') continue;
    assert.strictEqual(BC.bankFormLabel(c), n, `${c} ${n} 이 코드로 나간다(확인되지 않은 형식)`);
  }
  BC.setBankOverrides({ banks: { '011': { name: '농협' } } });
  assert.strictEqual(BC.bankFormLabel('011'), '농협', '편집한 이름이 서식에 나가야 한다');
  reset();
});

t('6f 화면 목록이 "코드로 나간다"를 말한다(조용한 no-op 금지)', () => {
  reset();
  const row = BC.bankTable().find(r => r.code === '031');
  assert.strictEqual(row.formCodeOnly, true, 'bankTable 이 formCodeOnly 를 안 준다');
  assert.ok(BC.bankTable().filter(r => r.formCodeOnly).length === 1);
  const wd = readRoot('frontend/workdesk.html');
  assert.ok(/r\.formCodeOnly\?/.test(wd), '화면이 그 사실을 표기하지 않는다 — 이름을 고쳐도 안 바뀌는 이유를 알 수 없다');
  reset();
});

/* ══════════════ §7 프론트 ══════════════ */
console.log('\n§7 프론트 — 서브탭 · 저장 페이로드 · IME · onclick 인덱스');

const WD = readRoot('frontend/workdesk.html');

t('7a 입금관리에 서브탭이 있고 기존 화면은 한 벌 그대로다', () => {
  assert.ok(/_pmTabsHtml/.test(WD) && /_pmSwitch/.test(WD) && /_pmPaint/.test(WD));
  assert.ok(/STATE\.pmSub/.test(WD));
  // 기존 대상표·회차표 렌더러가 그대로 살아 있어야 한다(쪼개지 않았다)
  assert.ok(/function _pmTargetTable\(/.test(WD) && /function _pmBatchTable\(/.test(WD));
});

t('7b ★ 저장 페이로드는 del 을 "기본 표기인데 지금 없는 것"으로 계산한다(정규화 사본 없이)', () => {
  const ctx = { STATE: { bn: { rows: [
    { code: '089', name: '케이뱅크', baseName: '케이뱅크', custom: false,
      baseAliases: ['케이', '케뱅', 'kbank'],
      aliases: [{ v: '케이', base: true }, { v: 'kbank', base: true }, { v: '케이비', base: false }] },
    { code: '031', name: 'iM뱅크', baseName: '대구은행', custom: false, baseAliases: ['대구'],
      aliases: [{ v: '대구', base: true }] },
    { code: '999', name: '테스트은행', baseName: '', custom: true, baseAliases: [], aliases: [] },
  ] } } };
  vm.createContext(ctx);
  vm.runInContext(grabFns(WD, ['_bnPayload']), ctx);
  // ★ vm 컨텍스트 객체는 프로토타입이 달라 deepStrictEqual 이 참조비교에서 걸린다 → 값으로 본다
  const p = JSON.parse(vm.runInContext('JSON.stringify(_bnPayload())', ctx));
  assert.deepStrictEqual(p.banks['089'], { add: ['케이비'], del: ['케뱅'] });
  assert.deepStrictEqual(p.banks['031'], { name: 'iM뱅크' });
  assert.deepStrictEqual(p.extra, [{ code: '999', name: '테스트은행' }]);
  assert.ok(!p.banks['999'] || !p.banks['999'].name, '신규 기관 이름은 extra 한 곳에만');
});

t('7c 겹침 판정이 정식명·표기를 모두 본다', () => {
  const ctx = { STATE: { bn: { rows: [
    { code: '004', name: '국민은행', aliases: [{ v: '국민' }] },
    { code: '088', name: '신한은행', aliases: [{ v: '국민' }] },
    { code: '031', name: '대구은행', aliases: [{ v: '대구' }] },
  ] } } };
  vm.createContext(ctx);
  vm.runInContext(grabFns(WD, ['_bnNorm', '_bnConflicts']), ctx);
  const bad = JSON.parse(vm.runInContext('JSON.stringify([..._bnConflicts()])', ctx));
  assert.deepStrictEqual(bad, ['국민']);
});

t('7d ★ 프론트 정규화가 서버 _norm 과 같은 규칙이다(사본 드리프트 차단)', () => {
  const server = read('utils/bankCodes.js');
  const si = server.indexOf('function _norm(');
  const sbody = server.slice(si, server.indexOf('}', server.indexOf('.trim()', si)));
  const fi = WD.indexOf('function _bnNorm(');
  const fbody = WD.slice(fi, WD.indexOf('}', WD.indexOf('.trim()', fi)));
  const pick = s => (s.match(/replace\([^)]*\)/g) || []).map(x => x.replace(/\s+/g, ''));
  assert.deepStrictEqual(pick(fbody), pick(sbody), '두 정규화가 갈라지면 화면과 서버 판정이 어긋난다');
  assert.ok(/toLowerCase\(\)/.test(fbody) && /toLowerCase\(\)/.test(sbody));
});

t('7e 미인식 큐 — 목록을 못 받으면 0건으로 꾸미지 않는다', () => {
  const ctx = { STATE: {} };
  vm.createContext(ctx);
  vm.runInContext(grabFns(WD, ['_bnNorm', '_bnQueue', '_bnUseCount']), ctx);
  assert.strictEqual(vm.runInContext('_bnQueue()', ctx), null, '목록 미조회 = null(모름)');
  assert.strictEqual(vm.runInContext('_bnUseCount("031")', ctx), null);
  ctx.STATE.pmItems = [
    { issues: ['bank_unknown'], bankName: '대구아이엠뱅크' },
    { issues: ['bank_unknown'], bankName: '대구 아이엠뱅크' },
    { issues: ['no_account'], bankName: '국민' },
    { issues: [], bankCode: '031' },
  ];
  const q = vm.runInContext('_bnQueue()', ctx);
  assert.strictEqual(q.length, 1, '정규화가 같은 표기는 한 줄로 묶는다');
  assert.strictEqual(q[0].n, 2);
  assert.strictEqual(vm.runInContext('_bnUseCount("031")', ctx), 1);
});

t('7f ★ 검색·표기 입력이 IME 를 깨지 않는다 — 입력칸만 바꾸고 표를 통째로 안 갈아엎는다', () => {
  const i = WD.indexOf('function _bnAddKw(');
  const body = WD.slice(i, WD.indexOf('\nfunction ', i + 10));
  assert.ok(/replaceWith\(inp\)/.test(body), '입력칸을 그 자리에만 끼워 넣어야 한다');
  assert.ok(!/oninput=/.test(body), '입력 중 재렌더 금지');
  const si = WD.indexOf('function _bnSearch(');
  const sbody = WD.slice(si, WD.indexOf('\nfunction ', si + 10));
  assert.ok(/selectionStart/.test(sbody) && /focus\(\)/.test(sbody), '검색은 커서 위치를 유지한다');
});

t('7g ★ onclick 에는 인덱스만 넘긴다(은행명·표기 문자열 보간 금지)', () => {
  for (const m of WD.match(/onclick="_bn[A-Za-z]+\([^"]*\)"/g) || []) {
    assert.ok(!/\$\{esc\(/.test(m) && !/\$\{[a-z]+\.(v|name|code)\}/.test(m),
      'onclick 에 문자열을 보간했다: ' + m);
  }
  assert.ok(/onclick="_bnDelKw\(\$\{i\},\$\{ki\}\)"/.test(WD));
  assert.ok(/onclick="_bnLink\(\$\{qi\}\)"/.test(WD));
});

t('7h 겹침이면 저장 버튼을 잠그고 사유를 말한다', () => {
  const i = WD.indexOf('const bar = S.dirty');
  const bar = WD.slice(i, i + 700);
  assert.ok(/conflictN\?'disabled':''/.test(bar.replace(/\s/g, '')), '겹침일 때 저장이 열려 있으면 안 된다');
  assert.ok(/같은 표기가 두 은행에/.test(bar), '왜 못 저장하는지 말해야 한다');
});

t('7i 자리표시자를 깐 함수는 실패해도 화면을 종결한다([다시 시도])', () => {
  const i = WD.indexOf('async function _bnLoad(');
  const body = WD.slice(i, WD.indexOf('\n/* 저장 페이로드', i));
  assert.ok(/catch\s*\(/.test(body) && /다시 시도/.test(body), '무한 "불러오는 중…" 금지');
});

t('7j 신규 은행 추가는 브라우저 prompt 를 쓰지 않는다(인라인 입력)', () => {
  const i = WD.indexOf('function _bnAddBank(');
  const body = WD.slice(i, WD.indexOf('/* 막힌 표기', i));
  assert.ok(!/prompt\(/.test(body), 'prompt 금지 — 코드/이름을 한 화면에서 보고 넣어야 한다');
  assert.ok(/bnNewCode/.test(WD) && /bnNewName/.test(WD));
});

t('7k 저장 후 입금대상을 다시 읽어 보류가 풀렸는지 반영한다(화면 이동 없이)', () => {
  const i = WD.indexOf('async function _bnSave(');
  const body = WD.slice(i, WD.indexOf('\n/* ═', i));
  assert.ok(/payment\/targets/.test(body), '저장하고 끝내면 보류가 그대로인 것처럼 보인다');
  assert.ok(!/_pmPaint\(\)/.test(body), '저장 뒤 화면을 갈아타면 사용자가 하던 자리를 잃는다');
});

t('7l ★★ 편집 입력칸이 열린 채 [저장]을 눌러도 요청이 나간다 (2026-08-19 "정식 명칭 저장 안 됨")', () => {
  // 원인: mousedown → blur → commit → _bnRender() 가 버튼 DOM 을 갈아치워 click 이 아예 발생하지 않았다.
  const bi = WD.indexOf('const bar = S.dirty');
  const bar = WD.slice(bi, bi + 900);
  const btns = bar.match(/<button[^>]*onclick="_bn(Save|Load)\([^"]*\)"/g) || [];
  assert.strictEqual(btns.length, 2, '바의 버튼 2개(저장·되돌리기)를 찾지 못했다');
  for (const b of btns) {
    assert.ok(/onmousedown="event\.preventDefault\(\)"/.test(b),
      'blur 를 막지 않으면 재렌더가 클릭을 먹어 저장이 조용히 안 나간다: ' + b);
  }

  // 저장·연결은 열린 편집을 **먼저 확정**한다(값 누락 방지)
  for (const fn of ['async function _bnSave(', 'async function _bnLink(']) {
    const i = WD.indexOf(fn);
    assert.ok(i > 0, fn + ' 없음');
    // ★ 줄 주석을 지우고 본다 — 주석 안의 호출은 실행되지 않는다(변이시험이 잡은 자리)
    const head = WD.slice(i, i + 320).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(/^\s*_bnFlushEdit\(\);/m.test(head), fn + ' 은 _bnFlushEdit() 로 편집값을 먼저 확정해야 한다');
  }

  // 확정은 **재렌더하지 않는다** — 재렌더가 곧 이 사고의 원인이다
  const fi = WD.indexOf('function _bnFlushEdit(');
  assert.ok(fi > 0, '_bnFlushEdit 없음');
  const fbody = WD.slice(fi, WD.indexOf('\n}', fi));
  assert.ok(/silent\s*:\s*true/.test(fbody), 'silent 확정이어야 한다');
  assert.ok(!/_bnRender\(\)/.test(fbody), '여기서 재렌더하면 같은 사고가 재현된다');

  // 두 편집 진입점이 열린 편집을 등록한다(등록이 빠지면 flush 가 아무 일도 안 한다)
  for (const fn of ['function _bnEditName(', 'function _bnAddKw(']) {
    const i = WD.indexOf(fn);
    const body = WD.slice(i, WD.indexOf('\n}', WD.indexOf("addEventListener('blur'", i)));
    assert.ok(/S\._flush\s*=\s*commit/.test(body), fn + ' 이 열린 편집을 등록하지 않는다');
    assert.ok(/silent/.test(body), fn + ' commit 에 silent 옵션이 없다');
  }
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
})();
