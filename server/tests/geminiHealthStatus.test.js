/**
 * geminiHealthStatus.test.js — /health 의 AI 설정 노출 가드.
 *
 * 배포 후 "GEMINI_API_KEY가 실제로 주입됐는지"를 브라우저에서 확인하기 위해
 * /health 에 ai 블록을 싣는다. ★★ /health 는 **무인증 공개**라
 * 키 값이 한 글자도 응답에 섞이면 안 된다 — 개수·출처 변수명·모델명만 노출.
 *
 * 실행: node tests/geminiHealthStatus.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const SECRET = 'AIzaSyTESTONLY_0123456789';

/* ── 순수함수: 키 해석 규칙 ── */
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
const gem = require('../src/services/gemini.service');

ok('키 미설정이면 configured=false', gem.getGeminiStatus().configured === false);
ok('미설정 상태에서도 개수는 0으로 보고(응답이 깨지지 않음)', gem.getGeminiStatus().keys === 0);

process.env.GEMINI_API_KEY = SECRET;
const single = gem.getGeminiStatus();
ok('단일키 인식 + 출처 표기', single.configured && single.keys === 1 && single.source === 'GEMINI_API_KEY');
ok('★★ 상태 객체에 키 값이 없다', !JSON.stringify(single).includes(SECRET));

process.env.GEMINI_API_KEYS = `${SECRET}, k2 ,k3`;
const multi = gem.getGeminiStatus();
ok('멀티키가 단일키보다 우선 + 공백 정리 후 개수',
  multi.keys === 3 && multi.source === 'GEMINI_API_KEYS');
ok('★★ 멀티키에서도 키 값이 없다', !JSON.stringify(multi).includes(SECRET));

/* ── 실제 /health 응답(런타임 실행 — grep 가드로는 스코프를 못 본다) ── */
const app = require('../src/app');
const server = app.listen(0, async () => {
  const port = server.address().port;
  let failed = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const j = await res.json();
    const raw = JSON.stringify(j);

    ok('/health 가 200을 준다', res.status === 200);
    ok('ai 블록이 실린다', j.ai && typeof j.ai === 'object');
    ok('키가 설정돼 있으면 configured 로 보인다', j.ai.gemini === 'configured');
    ok('키 개수가 함께 보인다(몇 개 넣었는지 확인용)', j.ai.geminiKeys === 3);
    ok('모델명도 함께(모델 오설정 진단)', typeof j.ai.geminiModel === 'string' && j.ai.geminiModel.length > 0);
    ok('캡처 AI 검수 on/off 도 함께 — 키가 있어도 이게 off면 검수는 안 돈다',
      j.ai.captureVerify === 'on' || j.ai.captureVerify === 'off');
    ok('★★ 응답 어디에도 키 값이 없다(무인증 공개 엔드포인트)', !raw.includes(SECRET));
    ok('DB 미연결이어도 헬스체크 자체는 응답한다(fail-soft)', j.ok === true);
  } catch (e) {
    failed = e;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.emit('SIGTERM');
  }
  if (failed) { console.error('❌ ' + failed.message); process.exit(1); }

  /* ── 배선: app.js 가 서비스의 단일 출처를 쓰는가(키 해석 사본 금지) ── */
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  ok('키 해석 규칙을 app.js 가 다시 구현하지 않는다',
    /getGeminiStatus\(\)/.test(appSrc) && !/GEMINI_API_KEYS/.test(appSrc));
  ok('ai 블록 실패가 헬스체크를 죽이지 않는다(fail-soft)',
    /catch \(err\) \{\s*\n\s*ai = \{ gemini: `error/.test(appSrc));

  console.log(`\n✅ geminiHealthStatus: ${n}개 통과`);
  process.exitCode = 0;
});
