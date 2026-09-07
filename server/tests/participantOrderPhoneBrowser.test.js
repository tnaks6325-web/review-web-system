'use strict';

// 실제 Chromium DOM에서 타계정 번호 잠금과 AI 자동입력 방어를 검증한다.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const candidates = [
  process.env.PW_CHROMIUM,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.log('SKIP participant phone browser: installed Chromium not found');
  process.exit(0);
}

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'search-app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'css', 'search.css'), 'utf8');
const lockFunctions = appSource.slice(
  appSource.indexOf('function _lockRegisteredSubPhone'),
  appSource.indexOf('function _reviewerIdentityRequestBody')
);
const applyFunction = appSource.slice(
  appSource.indexOf('function applyCardAiResult'),
  appSource.indexOf('/* ─ 하위호환: 기존 단일 카드 함수명 유지')
);
assert(lockFunctions.includes('participantPhoneLocked'));
assert(applyFunction.includes('participantPhoneLocked'));

const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${cssSource}</style></head><body>
  <main style="width:390px;padding:24px">
    <div class="of-identity-context"><span class="of-identity-kicker">현재 참여 명의</span><strong class="of-identity-name">타계정1</strong><span class="of-identity-kind">타계정</span><span class="of-identity-help">등록된 타계정 번호로만 제출됩니다.</span></div>
    <div class="of-field"><label class="of-label" for="card_phone">연락처</label><input id="card_phone" class="of-input" value=""></div>
    <button id="card_aiApplyBtn"></button><div id="card_aiResult"></div>
  </main>
  <script>
    const _cardAiState = { card: { extracted: { phone: '010-1234-5678' } } };
    const _BATCH = null;
    const _hasIdentityMask = () => false;
    const showToast = () => {};
    ${lockFunctions}
    ${applyFunction}
    _lockRegisteredSubPhone('card', { type:'sub', phone:'010-2222-3333' });
    applyCardAiResult('card');
    const input = document.getElementById('card_phone');
    document.body.dataset.afterAi = input.value;
    document.body.dataset.readonly = String(input.readOnly);
    document.body.dataset.lockBadge = String(!!document.querySelector('.participant-phone-lock-badge'));
    input.value = '010-9999-0000';
    document.body.dataset.payload = _registeredParticipantPhone('card');
    input.value = document.body.dataset.payload;
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'participant-phone-browser-'));
  const screenshotPath = path.join(os.tmpdir(), `participant-phone-browser-${process.pid}.png`);
  try {
    const { stdout } = await execFileAsync(browserPath, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--virtual-time-budget=1000', `--user-data-dir=${profileDir}`,
      '--window-size=430,360', `--screenshot=${screenshotPath}`,
      '--dump-dom', `http://127.0.0.1:${port}/`,
    ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    assert(stdout.includes('data-after-ai="010-2222-3333"'), 'AI가 본계정 번호로 덮지 않아야 한다');
    assert(stdout.includes('data-readonly="true"'), '타계정 전화번호 입력칸은 읽기 전용이어야 한다');
    assert(stdout.includes('data-lock-badge="true"'), '참여번호 고정 배지가 보여야 한다');
    assert(stdout.includes('data-payload="010-2222-3333"'), 'DOM 값을 변조해도 제출값은 등록번호여야 한다');
    assert(fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0, '브라우저 렌더 스크린샷을 생성해야 한다');
    console.log('PASS participant phone browser: real HTTP + Chromium lock and payload guard');
    console.log('SCREENSHOT ' + screenshotPath);
  } finally {
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* Chrome cleanup lag */ }
  }
})().catch((err) => {
  server.close();
  console.error(err.stack || err);
  process.exit(1);
});
