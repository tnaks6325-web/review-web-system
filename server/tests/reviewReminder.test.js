'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const solapi = require('../src/services/solapi.service');
const reminder = require('../src/services/reviewReminder.service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

function withSolapiEnv(fn) {
  const keys = {
    SOLAPI_API_KEY: 'test-key',
    SOLAPI_API_SECRET: 'test-secret',
    SOLAPI_PF_ID: 'test-pf',
    SOLAPI_SENDER_NUMBER: '0212345678',
    SOLAPI_REVIEW_TEMPLATE_ID_1: 'tpl-1',
    SOLAPI_REVIEW_TEMPLATE_ID_2: 'tpl-2',
    SOLAPI_REVIEW_TEMPLATE_ID_3: 'tpl-3',
  };
  const before = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]]));
  Object.assign(process.env, keys);
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

(async () => {
  await test('SOLAPI HMAC-SHA256 헤더가 공식 date+salt 규격을 따른다', () => {
    const date = '2026-09-16T01:02:03.000Z';
    const salt = '1234567890123456';
    const expected = crypto.createHmac('sha256', 'secret').update(date + salt).digest('hex');
    assert.strictEqual(
      solapi.createAuthorization('key', 'secret', { date, salt }),
      `HMAC-SHA256 apiKey=key, date=${date}, salt=${salt}, signature=${expected}`
    );
  });

  await test('연도 없는 시트 마감일은 주문일 연도로 해석하고 KST 말일시로 고정한다', () => {
    const full = reminder.parseReviewDeadline('2026-09-16', { orderedAt: '2026-09-01T00:00:00Z' });
    const short = reminder.parseReviewDeadline('9 / 16 (수)', { orderedAt: '2026-09-01T00:00:00Z' });
    assert.strictEqual(full.toISOString(), '2026-09-16T14:59:59.999Z');
    assert.strictEqual(short.toISOString(), full.toISOString());
    assert.strictEqual(reminder.parseReviewDeadline('미정'), null);
  });

  await test('승인 문안의 변수명과 리뷰 링크 형식을 회차별로 정확히 만든다', () => {
    const row = { reviewerName: '홍길동', productName: '샴푸' };
    const due = new Date('2026-09-16T14:59:59.999Z');
    const finalDue = new Date('2026-09-18T14:59:59.999Z');
    assert.deepStrictEqual(reminder.buildTemplateVariables(1, row, due, null, 'review-web-system.pages.dev/search.html'), {
      '#{상품명}': '샴푸', '#{리뷰링크}': 'review-web-system.pages.dev/search.html',
      '#{리뷰어명}': '홍길동', '#{제출기한}': '2026.09.16',
    });
    assert.deepStrictEqual(reminder.buildTemplateVariables(2, row, due, null, 'link'), {
      '#{상품명}': '샴푸', '#{리뷰링크}': 'link', '#{제출기한}': '2026.09.16',
    });
    assert.deepStrictEqual(reminder.buildTemplateVariables(3, row, due, finalDue, 'link'), {
      '#{상품명}': '샴푸', '#{리뷰링크}': 'link', '#{최종기한}': '2026.09.18',
    });
  });

  await test('알림톡은 ATA·SMS 대체발송 금지·승인 템플릿 변수로 접수한다', () => withSolapiEnv(async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          groupInfo: { groupId: 'group-1' },
          messageList: [{ messageId: 'message-1', statusCode: '2000', statusMessage: '정상 접수' }],
        }),
      };
    };
    const result = await solapi.sendReviewAlimTalk({
      to: '010-1234-5678', reminderNo: 2,
      variables: { '#{상품명}': '샴푸', '#{제출기한}': '2026.09.16', '#{리뷰링크}': 'example.com' },
    }, { fetchImpl });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.messageId, 'message-1');
    assert.strictEqual(request.url, 'https://api.solapi.com/messages/v4/send-many/detail');
    const msg = request.body.messages[0];
    assert.strictEqual(msg.type, 'ATA');
    assert.strictEqual(msg.to, '01012345678');
    assert.strictEqual(msg.kakaoOptions.templateId, 'tpl-2');
    assert.strictEqual(msg.kakaoOptions.disableSms, true);
    assert.strictEqual(request.body.strict, true);
  }));

  await test('공급자 처리완료 4000만 성공 수신으로 판정한다', () => withSolapiEnv(async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ messageList: {
        mid: { messageId: 'mid', status: 'COMPLETE', statusCode: '4000', reason: '정상 처리' },
      } }),
    });
    const result = await solapi.getMessageStatus('mid', { fetchImpl });
    assert.deepStrictEqual({ complete: result.complete, success: result.success, statusCode: result.statusCode },
      { complete: true, success: true, statusCode: '4000' });
  }));

  await test('마감 후 대상만 추리고 대기 접수·재시도 유예·3회 완료를 제외한다', () => {
    const now = new Date('2026-09-17T01:00:00Z');
    const config = {
      firstOffsetDays: 0, intervalHours: 24, retryHours: 6,
    };
    const base = {
      endDate: '2026-09-16', orderedAt: '2026-09-01T00:00:00Z', orderPhone: '01012345678',
      reminderCount: 0, reviewStatus: 'pending', hasOpenAttempt: false,
    };
    const rows = [
      { ...base, orderSubmissionId: 'due' },
      { ...base, orderSubmissionId: 'open', hasOpenAttempt: true },
      { ...base, orderSubmissionId: 'cooldown', latestAttemptAt: new Date('2026-09-16T23:00:00Z') },
      { ...base, orderSubmissionId: 'done', reminderCount: 3 },
      { ...base, orderSubmissionId: 'extended', endDate: '2026-09-20', reminderCount: 1,
        lastRemindedAt: new Date('2026-09-15T01:00:00Z') },
    ];
    const preview = reminder._summarizePreview(rows, now, config);
    assert.strictEqual(preview[0].reason, null);
    assert.strictEqual(preview[1].reason, 'provider_result_pending');
    assert.strictEqual(preview[2].reason, 'retry_cooldown');
    assert.strictEqual(preview[3].reason, 'all_reminders_delivered');
    assert.strictEqual(preview[4].reason, 'not_due', '연장된 현재 마감일보다 먼저 2차를 보내면 안 된다');
  });

  await test('성공 결과 조정은 delivery를 delivered로 바꾸고 상태 횟수를 올린다', async () => {
    const queries = [];
    const client = {
      query: async (sql, params) => {
        queries.push({ sql: String(sql), params });
        if (/UPDATE review_reminder_deliveries/.test(sql)) return { rows: [{ order_submission_id: 'order-1' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const db = {
      connect: async () => client,
      query: async (sql) => {
        queries.push({ sql: String(sql) });
        if (/FROM review_reminder_deliveries/.test(sql)) return { rows: [{
          id: 'delivery-1', orderSubmissionId: 'order-1', reminderNo: 1,
          messageId: 'message-1', finalDueAt: null,
        }] };
        return { rows: [], rowCount: 0 };
      },
    };
    const service = reminder.createReviewReminderService({
      db,
      provider: { getMessageStatus: async () => ({ complete: true, success: true, statusCode: '4000', reason: '정상 처리' }) },
    });
    const result = await service.reconcileAccepted(new Date('2026-09-17T01:00:00Z'));
    assert.strictEqual(result.delivered, 1);
    assert.ok(queries.some(q => /provider_status='delivered'/.test(q.sql)));
    assert.ok(queries.some(q => /reminder_count = \$2/.test(q.sql)));
    const stateUpdate = queries.find(q => /reminder_count = \$2/.test(q.sql));
    assert.ok(/ri\.sheet_id=s\.sheet_id[\s\S]*ri\.tab_name=s\.tab_name[\s\S]*ri\.row_index=s\.row_index/.test(stateUpdate.sql),
      '재생성 가능한 review_index UUID 대신 작업 좌표로 현재 행을 찾아야 한다');
    assert.ok(/review_index_id = ri\.id/.test(stateUpdate.sql), '현재 review_index UUID를 상태 원장에 다시 연결해야 한다');
  });

  await test('종결·제출 상태는 LIMIT 전에 후보에서 제외한다', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/reviewReminder.service.js'), 'utf8');
    assert.ok(/COALESCE\(s\.review_status, 'pending'\) = 'pending'[\s\S]*ORDER BY ri\.end_date[\s\S]*LIMIT \$1/.test(source));
  });

  await test('입금대상 양쪽 경로와 마이그레이션에 미작성 종결 방어가 있다', () => {
    const root = path.resolve(__dirname, '..');
    const payService = fs.readFileSync(path.join(root, 'src/services/payment.service.js'), 'utf8');
    const payRoutes = fs.readFileSync(path.join(root, 'src/routes/payment.routes.js'), 'utf8');
    const searchService = fs.readFileSync(path.join(root, 'src/services/search.service.js'), 'utf8');
    const reviewerRoutes = fs.readFileSync(path.join(root, 'src/routes/reviewer.routes.js'), 'utf8');
    const submitRoutes = fs.readFileSync(path.join(root, 'src/routes/submit.routes.js'), 'utf8');
    const diagRoutes = fs.readFileSync(path.join(root, 'src/routes/diag.routes.js'), 'utf8');
    const migration = fs.readFileSync(path.join(root, 'migrations/160_review_reminder_alimtalk.sql'), 'utf8');
    assert.ok(/review_status = 'closed_no_review'/.test(payService));
    assert.ok(/review_status = 'closed_no_review'/.test(payRoutes));
    assert.ok(/OPEN_REVIEW_COND[\s\S]*closed_no_review/.test(searchService));
    assert.ok(/reviewReminderStatus[\s\S]*closed_no_review/.test(reviewerRoutes));
    assert.ok(/review-earnings[\s\S]*review_reminder_states/.test(reviewerRoutes));
    assert.ok(/REVIEW_CLOSED_NO_REVIEW/.test(submitRoutes));
    assert.ok(/REVIEW_CLOSED_NO_REVIEW/.test(diagRoutes));
    assert.ok(/CHECK \(reminder_count BETWEEN 0 AND 3\)/.test(migration));
    assert.ok(/provider_status = 'accepted'/.test(migration));
  });

  await test('알림톡 화면에 나중에 자동 발송을 켤 운영 경로가 남아 있다', () => {
    const simulator = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/docs/review-reminder-alimtalk-simulator.html'),
      'utf8'
    );
    assert.ok(/기본값 OFF/.test(simulator));
    assert.ok(/현재 운영 상태는 Railway 변수에서 확인/.test(simulator));
    assert.ok(/GET \/api\/review-reminders\/status/.test(simulator));
    assert.ok(/POST \/api\/review-reminders\/run/.test(simulator));
    assert.ok(/dryRun/.test(simulator));
    assert.ok(/샘플 시뮬레이션/.test(simulator));
    assert.ok(/REVIEW_REMINDER_ENABLED=1/.test(simulator));
    assert.ok(/railway\.com\/project\/a413cce6-5d9b-4e9a-9bc1-fa2af0088235\/service\/f9445b01-c5d0-4495-a2ea-db11d5f18cbd\/variables/.test(simulator));
    assert.ok(/target="_blank" rel="noopener noreferrer"/.test(simulator));
  });

  console.log(`\n${passed} review reminder tests passed`);
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
