'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveParticipantOrderPhone } = require('../src/utils/participantOrderPhone');
const { checkRepurchaseWindow } = require('../src/utils/repurchaseGuard');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.resolve(root, relative), 'utf8');

(async () => {
  const requestedMain = resolveParticipantOrderPhone({
    requestedPhone: '010-1234-5678',
    participantPhone: '010-2222-3333',
    participantPhone8: '22223333',
    ownerPhone8: '12345678',
    verified: true,
  });
  assert.deepStrictEqual(requestedMain, {
    ok: true,
    phone: '010-2222-3333',
    isSubAccount: true,
    forced: true,
  }, '타계정 참여에 본계정 연락처를 보내도 등록된 타계정 번호만 저장해야 한다');

  const requestedOther = resolveParticipantOrderPhone({
    requestedPhone: '010-9999-0000',
    participantPhone: '010-2222-3333',
    participantPhone8: '22223333',
    ownerPhone8: '12345678',
    verified: true,
  });
  assert.strictEqual(requestedOther.phone, '010-2222-3333', '제3자 번호도 타계정 등록번호로 덮어쓴다');

  const self = resolveParticipantOrderPhone({
    requestedPhone: '010-7777-8888',
    participantPhone: '010-1234-5678',
    participantPhone8: '12345678',
    ownerPhone8: '12345678',
    verified: true,
  });
  assert.strictEqual(self.phone, '010-7777-8888', '본계정의 별도 배송 연락처는 기존처럼 유지한다');
  assert.strictEqual(self.isSubAccount, false);

  const invalid = resolveParticipantOrderPhone({
    requestedPhone: '010-1234-5678',
    participantPhone: '010-9999-0000',
    participantPhone8: '22223333',
    ownerPhone8: '12345678',
    verified: true,
  });
  assert.strictEqual(invalid.ok, false, '신청 phone8과 등록 전체번호가 어긋나면 임의 번호로 제출하지 않는다');
  assert.strictEqual(invalid.code, 'PARTICIPANT_PHONE_INVALID');

  const submit = read('src/routes/submit.routes.js');
  assert.match(submit, /ca\.applicant_phone AS participant_phone/);
  assert.match(submit, /const effectivePhone = participantPhone\.phone/);
  assert.match(submit, /phone: effectivePhone, address/);
  assert.match(submit, /orderData = \{[^\n]*phone: effectivePhone/);
  assert.match(submit, /orderIdentity: \{ phone: effectivePhone \}/);

  const app = read('../frontend/js/search-app.js');
  const css = read('../frontend/css/search.css');
  assert.match(app, /identity\.type !== "sub"/);
  assert.match(app, /input\.dataset\.participantPhoneLocked = "1"/);
  assert.match(app, /등록된 타계정 번호로만 제출됩니다/);
  assert.match(app, /if \(el\.dataset\.participantPhoneLocked === "1"\)[\s\S]{0,120}el\.dataset\.participantPhone/,
    'AI 자동입력이 고정된 타계정 번호를 덮지 않아야 한다');
  assert.match(app, /_registeredParticipantPhone\(cid\) \|\| gv\(cid\+"_phone"\)/,
    '제출 직전에도 화면 편집값보다 등록 타계정 번호를 우선해야 한다');
  assert.match(css, /\.of-input\.participant-phone-locked/);
  assert.match(css, /\.participant-phone-lock-badge/);

  let repurchaseSql = '';
  await checkRepurchaseWindow({ query: async (sql) => {
    repurchaseSql = String(sql);
    return { rows: [] };
  } }, { sheetId: 'sheet-a', tabName: 'A작업', campaignId: 'campaign-a', phone8: '22223333', days: 14 });
  assert.match(repurchaseSql, /identity_ca\.id = os\.campaign_application_id/);
  assert.match(repurchaseSql, /linked_ca\.order_submission_id = os\.id/);
  assert.match(repurchaseSql, /COALESCE\(os\.phone/,
    '공고에 연결되지 않은 레거시 주문만 구매양식 연락처로 폴백해야 한다');

  console.log('PASS registered sub-account phone is the only submitted and repurchase identity');
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
