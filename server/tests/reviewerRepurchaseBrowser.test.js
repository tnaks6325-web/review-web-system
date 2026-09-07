'use strict';

// 설치된 실제 Chrome/Chromium이 있으면 production campaign-cards.js를 HTTP로 렌더한다.
// 브라우저가 없는 CI에서는 정적 회귀 테스트가 별도로 있으므로 조용히 건너뛴다.
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
const browserPath = candidates.find(candidate => fs.existsSync(candidate));
if (!browserPath) {
  console.log('SKIP reviewer repurchase browser: installed Chromium not found');
  process.exit(0);
}

const cardScript = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-cards.js'));
const campaign = {
  id: 'camp-a', title: '명의별 재참여 테스트 상품', participation_mode: true,
  state: 'open', time_range: '자율주문', daily_limit: 10, todayCount: 1,
  multi_account_mode: true,
  repurchase: { accounts: [
    { type: 'self', displayName: '본계정', phone8: '12345678', status: 'locked', availableFrom: new Date(Date.now() + 10 * 86400000).toISOString() },
    { type: 'sub', displayName: '타계정1', phone8: '22223333', status: 'ready', history: 'none' },
    { type: 'sub', displayName: '타계정2', phone8: '44445555', status: 'ready', history: 'found' },
    { type: 'sub', displayName: '타계정3', phone8: '66667777', status: 'locked', availableFrom: new Date(Date.now() + 12 * 86400000).toISOString() },
  ] },
};

const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{font-family:Arial}.host{width:360px}.pcards-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pcard{border:1px solid #ddd}.pthumb{height:150px;position:relative}.pbody{padding:10px}</style></head><body><div id="host" class="host"></div><script src="/campaign-cards.js"></script><script>
  CampCards.renderInto(document.getElementById('host'), [${JSON.stringify(campaign)}]);
  const card = document.querySelector('.pcard');
  document.body.dataset.rendered = card ? 'yes' : 'no';
  document.body.dataset.sash = card && card.querySelector('.ps-t') ? card.querySelector('.ps-t').textContent.trim() : '';
  document.body.dataset.summary = card && card.querySelector('.rep-acct-count') ? card.querySelector('.rep-acct-count').textContent.trim() : '';
  document.body.dataset.dots = String(card ? card.querySelectorAll('.rep-dot').length : 0);
  document.body.dataset.button = card && card.querySelector('.pbtn') ? card.querySelector('.pbtn').textContent.trim() : '';
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/campaign-cards.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end(cardScript);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repurchase-browser-'));
  const screenshotPath = path.join(os.tmpdir(), `reviewer-repurchase-browser-${process.pid}.png`);
  try {
    const { stdout } = await execFileAsync(browserPath, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--virtual-time-budget=1200', `--user-data-dir=${profileDir}`,
      '--window-size=390,844', `--screenshot=${screenshotPath}`,
      '--dump-dom', `http://127.0.0.1:${port}/`,
    ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    assert(stdout.includes('data-rendered="yes"'), '실제 브라우저에서 카드가 렌더되어야 함');
    assert(stdout.includes('data-sash="✅ 참여 가능 2개 · 제한 중 2개"'), '가능/제한 명의 수 띠가 렌더되어야 함');
    assert(stdout.includes('data-summary="2개 가능"'), '명의별 상태 요약이 렌더되어야 함');
    assert(stdout.includes('data-dots="4"'), '본계정 + 타계정 3개가 각각 표시되어야 함');
    assert(stdout.includes('data-button="명의 선택 · 2개 가능"'), '가능 명의 수가 참여 버튼에 표시되어야 함');
    assert(fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0, '실제 브라우저 스크린샷을 생성해야 함');
    console.log('PASS reviewer repurchase browser: real HTTP + Chromium render');
    console.log('SCREENSHOT ' + screenshotPath);
  } finally {
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* Windows Chrome cleanup lag */ }
  }
})().catch(err => {
  server.close();
  console.error(err.stack || err);
  process.exit(1);
});
