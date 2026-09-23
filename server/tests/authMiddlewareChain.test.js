/**
 * authMiddlewareChain.test.js — 역할 미들웨어 앞에 authMiddleware가 있는지 고정.
 *
 * ★★ 실측 사고: `router.post('/company-business-no', adminOrMasterMiddleware, ...)` 처럼
 *   authMiddleware 를 빠뜨리면, 역할 미들웨어가 읽는 `req.admin` 이 undefined 라
 *   **마스터를 포함해 전원 403("관리자 권한이 필요합니다")** 이 된다.
 *   토큰이 유효해도 거부되므로 "권한 설정 문제"로 오인하기 쉽다 —
 *   실제로 현금영수증 설정(사업자번호·발행방법 이미지)이 아무도 저장할 수 없는 상태였다.
 *
 * 실행: node tests/authMiddlewareChain.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ═══ 전 라우트 파일 정적 스캔 ═══ */
const routesDir = path.join(__dirname, '..', 'src', 'routes');
const ROLE_MW = '(adminOrMasterMiddleware|masterOnlyMiddleware|internalOnlyMiddleware)';
const offenders = [];
for (const f of fs.readdirSync(routesDir).filter(x => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  // 파일 전체에 authMiddleware를 거는 라우터는 개별 지정이 없어도 안전
  if (/router\.use\((?:[^)]*,\s*)?authMiddleware/.test(src)) continue;
  const re = new RegExp(`router\\.(get|post|put|delete|patch)\\(\\s*['\`][^'\`]*['\`]\\s*,\\s*${ROLE_MW}`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    offenders.push(`${f}:${line} ${m[0].slice(0, 70)}`);
  }
}
ok('★★ 역할 미들웨어 앞에 authMiddleware가 빠진 라우트가 없다'
  + (offenders.length ? '\n      → ' + offenders.join('\n      → ') : ''), offenders.length === 0);

/* ═══ 현금영수증 설정 2종은 명시적으로 확인 ═══ */
{
  const tc = fs.readFileSync(path.join(routesDir, 'tabconfig.routes.js'), 'utf8');
  ok('회사 사업자번호 저장이 authMiddleware + adminOrMaster',
    /router\.post\('\/company-business-no', authMiddleware, adminOrMasterMiddleware/.test(tc));
  ok('현금영수증 발행방법 이미지 저장이 authMiddleware + adminOrMaster',
    /router\.post\('\/cash-receipt-guide', authMiddleware, adminOrMasterMiddleware/.test(tc));
  ok('왜 필요한지 코드에 남아 있다(다음 사람이 또 빠뜨리지 않도록)',
    /빠뜨리면 req\.admin이 undefined라 \*\*마스터를 포함해 아무도\*\*/.test(tc));
}

/* ═══ 실제 서버를 띄워 권한별 응답 확인(런타임 가드 — 정적 검사가 못 보는 것) ═══ */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-authchain';
const app = require('../src/app');
const server = app.listen(0, async () => {
  const port = server.address().port;
  // ★ 이 API의 errorHandler는 DB 오류를 200 + {error} 로 돌려준다(GAS 호환 스타일).
  //   그래서 상태코드만으로 판단하지 않고 **본문에 권한 거부 문구가 있는지**까지 본다.
  const call = (token) => new Promise((resolve) => {
    const body = JSON.stringify({ businessNo: '311-87-02345' });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/tab/company-business-no', method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, denied: /관리자 권한이 필요합니다/.test(d) }));
    });
    req.on('error', () => resolve({ status: 0, denied: false }));
    req.end(body);
  });
  const sign = (role) => jwt.sign({ id: 1, username: 'u', name: 'n', role }, process.env.JWT_SECRET, { expiresIn: '5m' });

  let failed = null;
  try {
    ok('★ 토큰 없으면 401(인증 단계에서 걸린다 — 403이면 체인이 잘못된 것)', (await call(null)).status === 401);
    // DB가 없는 환경에서는 저장이 실패하지만, **권한 거부 문구가 없으면 체인은 통과**한 것이다.
    const admin = await call(sign('admin'));
    ok('★★ admin 이 권한에서 막히지 않는다(사고 재현 지점)', !admin.denied && admin.status !== 401);
    const master = await call(sign('master'));
    ok('master 도 통과', !master.denied && master.status !== 401);
    const staff = await call(sign('staff'));
    ok('staff 는 403 + 권한 문구로 차단(과잉 개방 아님)', staff.status === 403 && staff.denied);
  } catch (e) { failed = e; } finally { server.close(); }
  if (failed) { console.error('❌ ' + failed.message); process.exit(1); }

  console.log(`\n✅ authMiddlewareChain: ${n}개 통과`);
  process.exit(0);
});
