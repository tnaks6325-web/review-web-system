/**
 * reviewerCsInbox.test.js — 리뷰어 1:1 문의 세션·배지·대화 조회 회귀가드
 * 실행: node tests/reviewerCsInbox.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const readFrontend = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const reviewerCs = readFrontend('js/reviewer-cs.js');
const indexHtml = readFrontend('index.html');
const reviewerRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reviewer.routes.js'), 'utf8');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('\n▶ 리뷰어 1:1 문의 배지·대화 조회\n');

ok('대화창은 index.html의 현재 리뷰어 세션 선택기를 쓴다',
  /typeof window\.getSavedUser === "function"/.test(reviewerCs) && /return window\.getSavedUser\(\)/.test(reviewerCs));
ok('독립 폴백도 관리자 바로가기 sessionStorage를 localStorage보다 먼저 읽는다',
  /sessionStorage\.getItem\(HOME_SESSION_KEY\) \|\| localStorage\.getItem\(USER_KEY\)/.test(reviewerCs));
ok('세션 계정이 바뀌면 SSE를 같은 phone8로 다시 연결한다',
  /_ssePhone8 !== phone8/.test(reviewerCs) && /_ssePhone8 = String\(user\.phone8\)/.test(reviewerCs));
ok('하단 1:1문의 배지는 빨간 숫자이고 99+를 상한으로 두는다',
  /id="rcsTabDot"[^>]*background:#EF4444/.test(indexHtml) && /count > 99 \? "99\+" : String\(count\)/.test(reviewerCs));
ok('로그인 완료 즉시 C\/S 세션·배지를 동기화한다',
  /ReviewerCS\.syncSession\(\)/.test(indexHtml) && /refreshUnread\(\);\s*\n\s*}/.test(reviewerCs));
ok('문의 목록에서 대화창으로 threadId를 전달한다',
  /ReviewerCS\.openChat\([^\n]+t\.threadId\)/.test(indexHtml));
ok('메시지 API는 threadId와 phone8을 함께 조건으로 사용한다',
  /WHERE reviewer_phone8 = \$1 AND id = \$2 LIMIT 1/.test(reviewerRoutes));

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const pool = require('../src/db/pool');
const adminNickname = require('../src/services/adminNickname.service');
adminNickname.maskMessages = async (messages) => messages;

const queries = [];
pool.query = async (sql, params) => {
  queries.push({ sql, params });
  if (/FROM cs_threads[\s\S]*id = \$2/.test(sql)) {
    return { rows: params[0] === '85926325' && params[1] === 42
      ? [{ id: 42, campaignLabel: '테스트 문의', status: 'open' }]
      : [] };
  }
  if (/FROM cs_messages/.test(sql)) {
    return { rows: [{ id: 7, senderRole: 'admin', senderName: '관리자', content: '답변', imageUrls: [], createdAt: new Date().toISOString() }] };
  }
  if (/UPDATE cs_threads SET reviewer_unread_count = 0/.test(sql)) return { rows: [] };
  return { rows: [] };
};

const router = require('../src/routes/reviewer.routes');
const layer = router.stack.find((l) => l.route && l.route.path === '/cs/messages' && l.route.methods.get);
assert.ok(layer, 'GET /cs/messages 라우트 없음');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

function call(query) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ query }, res, (err) => resolve({ err }))).catch((err) => resolve({ err }));
  });
}

(async () => {
  const found = await call({ phone8: '85926325', threadId: '42', campaignKey: 'stale-key' });
  ok('런타임: campaignKey가 오래됐어도 목록의 threadId로 실제 메시지를 불러온다',
    found.statusCode === 200 && found.body && found.body.threadId === 42 && found.body.messages.length === 1);
  ok('런타임: threadId 조회에 리뷰어 phone8 소유권이 같이 들어간다',
    queries.some((q) => /reviewer_phone8 = \$1 AND id = \$2/.test(q.sql) && q.params[0] === '85926325' && q.params[1] === 42));

  const foreign = await call({ phone8: '87654321', threadId: '42' });
  ok('런타임: 다른 리뷰어의 threadId로는 메시지를 내주지 않는다',
    foreign.statusCode === 200 && foreign.body && foreign.body.threadId === null && foreign.body.messages.length === 0);

  const invalid = await call({ phone8: '85926325', threadId: 'not-a-number' });
  ok('런타임: 잘못된 threadId는 400으로 거절한다', invalid.statusCode === 400 && invalid.body.ok === false);

  console.log(`\n✅ reviewerCsInbox: ${passed}개 통과\n`);
  process.exit(0);
})().catch((err) => { console.error('\n❌', err); process.exit(1); });
