/**
 * manualMessageSend.test.js — 작업보드 문자·알림톡 직접 보내기(시안 A, 사용자 확정 2026-09-30).
 *  ① 문자: 발신 전용 안내 + 1:1 문의 주소 자동 첨부 · 같은 번호 한 번만 · 1:1 문의방에도 기록 · 발송 기록
 *  ② 알림톡: 다음 회차만 · 날짜 전(not_due)은 앞당겨 허용 · 기간 지남/3회 완료 등은 막고 사유
 *     · 자동 스위치가 꺼져 있어도 보낸다 · 원장 공유(sendOne)
 *  ③ 라우트: 내부 담당자 전원(광고주 차단) ④ 화면 배선
 * 실행: node tests/manualMessageSend.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const ok = (label, cond) => { assert(cond, label); passed++; console.log('  ✓ ' + label); };

const pool = require('../src/db/pool');
const origQuery = pool.query;
const contact = require('../src/services/reviewerContact.service');
let _contacts = [];
contact.reviewerContactsForRows = async () => ({ items: _contacts });
const solapi = require('../src/services/solapi.service');
const csBridge = require('../src/services/csBridge.service');
const reminder = require('../src/services/reviewReminder.service');
const svc = require('../src/services/manualMessage.service');

const CPS = [
  { id: 'a', seq: 10, rowName: '김리뷰' }, { id: 'b', seq: 11, rowName: '양승호' },
  { id: 'c', seq: 12, rowName: '이중' }, { id: 'd', seq: 13, rowName: '없음' },
];
let logs = [];
pool.query = async (sql, params) => {
  if (/FROM campaign_participants/.test(sql)) return { rows: CPS.filter(c => params[2].includes(c.id)) };
  if (/INSERT INTO manual_message_sends/.test(sql)) { logs.push(params); return { rowCount: 1 }; }
  throw new Error('예상하지 못한 쿼리: ' + sql.slice(0, 80));
};

(async () => {
  console.log('\n▶ ① 문자');
  const full = svc.composeSms('리뷰 부탁드립니다');
  ok('발신 전용 안내와 1:1 문의 주소가 자동으로 붙는다', /발신 전용 번호라 답장을 확인할 수 없습니다/.test(full) && /review-web-system\.pages\.dev\/#cs$/.test(full));
  ok('주소는 설정으로 바꿀 수 있다', svc.homeLink({ REVIEW_WEB_HOME_URL: 'https://x.example/' }) === 'x.example/#cs');
  ok('리뷰어 홈이 #cs 로 들어오면 1:1 문의 탭을 연다', /location\.hash === "#cs"[\s\S]{0,200}switchTab\("cs"\)/.test(read('frontend/index.html')));

  _contacts = [
    { participantId: 'a', ok: true, name: '김리뷰', phoneFull: '01011112222', phone8: '11112222' },
    { participantId: 'b', ok: true, name: '김리뷰', phoneFull: '01011112222', phone8: '11112222', isSub: true },
    { participantId: 'c', ok: true, name: '이중', phoneFull: '', phone8: '33334444' },
    { participantId: 'd', ok: false, reason: '로그인 계정을 찾지 못했습니다' },
  ];
  const origManualPreview = reminder.manualPreview;
  reminder.manualPreview = async () => ({ byRow: new Map() });
  const origStatus = solapi.getSolapiStatus;
  solapi.getSolapiStatus = () => ({ configured: true, missing: [] });
  const sent = []; const rooms = [];
  const origSms = solapi.sendSms; const origNotice = csBridge.postAdminNotice;
  solapi.sendSms = async (a) => { sent.push(a); return { accepted: true, messageId: 'm1', type: 'LMS' }; };
  csBridge.postAdminNotice = async (a) => { rooms.push(a); return { threadId: 't1' }; };

  let r = await svc.sendManualSms({ sheetId: 's', tabName: 't', ids: ['a', 'b', 'c', 'd'], text: '리뷰 부탁드립니다', by: '망고' });
  ok('같은 번호는 한 번만 보낸다', sent.length === 1 && sent[0].to === '01011112222');
  ok('보낸 문자에 안내 문구가 붙어 있다', /발신 전용/.test(sent[0].text));
  ok('1:1 문의방에는 안내 없이 본문만 남긴다', rooms.length === 1 && rooms[0].message === '리뷰 부탁드립니다' && rooms[0].phone8 === '11112222' && rooms[0].by === '망고');
  const by = Object.fromEntries(r.results.map(x => [x.participantId, x]));
  ok('결과: 보냄/중복/번호 모호/대상 없음을 구분해 말한다',
    by.a.sent && by.a.roomOk && by.b.merged && /전체 번호를 특정할 수 없습니다/.test(by.c.reason) && /로그인 계정/.test(by.d.reason));
  ok('발송 기록이 남는다(누가·무엇을)', logs.length === 1 && logs[0][0] === 'sms' && logs[0][13] === '망고' && /발신 전용/.test(logs[0][7]));

  r = await svc.sendManualSms({ sheetId: 's', tabName: 't', ids: ['a'], text: '   ' });
  ok('빈 내용은 거부', r.ok === false && /입력/.test(r.error));
  r = await svc.sendManualSms({ sheetId: 's', tabName: 't', ids: ['a'], text: '가'.repeat(1000) });
  ok('2000바이트 초과는 거부', r.ok === false && /너무 깁니다/.test(r.error));

  solapi.sendSms = async () => ({ accepted: false, reason: '잔액 부족' });
  rooms.length = 0;
  r = await svc.sendManualSms({ sheetId: 's', tabName: 't', ids: ['a'], text: '안내' });
  ok('문자 실패면 문의방에 남기지 않고 사유를 말한다', rooms.length === 0 && r.results[0].sent === false && /잔액 부족/.test(r.results[0].reason));
  ok('문자 바이트: 90 이하 SMS · 초과 LMS 기준', solapi.smsBytes('가'.repeat(45)) === 90 && solapi.smsBytes('a') === 1);

  console.log('\n▶ ② 알림톡(다음 회차)');
  const kst = s => new Date(s + '+09:00');
  const baseRow = { reviewIndexId: 'ri', sheetId: 's', tabName: 't', reviewerName: '김리뷰', productName: '상품',
    orderSubmissionId: 'o', orderPhone: '01011112222', orderedAt: kst('2026-09-01T12:00:00'),
    reviewStatus: 'pending', hasOpenAttempt: false };
  let candRows = [];
  const providerCalls = [];
  const db = { query: async (sql, params) => {
    if (/FROM review_index ri/.test(sql)) {
      ok('수동 발송은 기간 절을 끄고 그 줄만 읽는다', params[1] === null && params[2] === 's' && params[3] === 't' && Array.isArray(params[4]));
      return { rows: candRows };
    }
    if (/FROM review_reminder_deliveries[\s\S]*provider_status = 'accepted' AND provider_message_id IS NOT NULL/.test(sql)) return { rows: [] };
    if (/SELECT is_submitted FROM review_index/.test(sql)) return { rows: [{ is_submitted: false }] };
    if (/FROM review_closed_targets/.test(sql)) return { rows: [] };
    if (/deleted_at IS NOT NULL/.test(sql)) return { rows: [] };
    if (/INSERT INTO review_reminder_states/.test(sql)) return { rowCount: 1 };
    if (/COALESCE\(MAX\(attempt_no\)/.test(sql)) return { rows: [{ n: 1 }] };
    if (/INSERT INTO review_reminder_deliveries/.test(sql)) return { rows: [{ id: 'd1' }] };
    if (/UPDATE review_reminder_deliveries/.test(sql)) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const provider = { sendReviewAlimTalk: async (a) => { providerCalls.push(a); return { accepted: true, messageId: 'mx', statusCode: '2000' }; },
    getMessageStatus: async () => ({ complete: false }) };
  const obligation = require('../src/services/reviewObligation.service');
  const origFul = obligation.isFulfilled, origCan = obligation.canRemind;
  obligation.isFulfilled = async () => false; obligation.canRemind = async () => true;
  const R = reminder.createReviewReminderService({ db, provider });
  const envBefore = process.env.REVIEW_REMINDER_ENABLED;
  process.env.REVIEW_REMINDER_ENABLED = '0';
  Object.assign(process.env, { SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_PF_ID: 'p', SOLAPI_SENDER_NUMBER: '0212345678',
    SOLAPI_REVIEW_TEMPLATE_ID_1: 't1', SOLAPI_REVIEW_TEMPLATE_ID_2: 't2', SOLAPI_REVIEW_TEMPLATE_ID_3: 't3' });

  candRows = [
    { ...baseRow, rowIndex: 10, reminderCount: 0 },                                       // 구매 +3일: 날짜 전 → 앞당겨 허용
    { ...baseRow, rowIndex: 11, reminderCount: 3 },                                       // 3회 완료
    { ...baseRow, rowIndex: 12, reminderCount: 0, orderedAt: kst('2026-08-01T12:00:00') }, // 기간 지남
    { ...baseRow, rowIndex: 13, reminderCount: 1, hasOpenAttempt: true },                 // 결과 확인 중
  ];
  const pv = await R.manualPreview({ sheetId: 's', tabName: 't', rowIndexes: [10, 11, 12, 13], now: kst('2026-09-04T10:00:00') });
  ok('날짜가 안 된 1차는 앞당겨 보낼 수 있다', pv.byRow.get(10).ok && pv.byRow.get(10).reminderNo === 1);
  ok('3회 완료는 막는다', !pv.byRow.get(11).ok && /3회/.test(pv.byRow.get(11).reason));
  ok('기간(구매 후 14일)이 지나면 막고 문자를 권한다', !pv.byRow.get(12).ok && /문자로/.test(pv.byRow.get(12).reason));
  ok('앞 알림 결과 확인 중이면 막는다', !pv.byRow.get(13).ok && /확인/.test(pv.byRow.get(13).reason));

  const out = await R.sendManual({ sheetId: 's', tabName: 't', rowIndexes: [10, 11], now: kst('2026-09-04T10:00:00') });
  ok('자동 스위치가 꺼져 있어도 담당자 발송은 나간다', providerCalls.length === 1 && providerCalls[0].reminderNo === 1);
  ok('보낸 건은 자동 알림 원장(회차)과 같은 경로', out.results[0].sent === true && out.results[0].accepted === true);
  ok('막힌 건은 보내지 않고 사유', out.results[1].sent === false && /3회/.test(out.results[1].reason));

  obligation.isFulfilled = origFul; obligation.canRemind = origCan;
  if (envBefore == null) delete process.env.REVIEW_REMINDER_ENABLED; else process.env.REVIEW_REMINDER_ENABLED = envBefore;

  reminder.sendManual = async ({ rowIndexes }) => ({ ok: true, results: rowIndexes.map(i => ({ rowIndex: i, sent: true, accepted: i === 10, reminderNo: 2, reason: i === 10 ? '' : 'submitted_before_send', targetPhone: '01011112222' })) });
  logs = [];
  const at = await svc.sendManualAlimtalk({ sheetId: 's', tabName: 't', ids: ['a', 'b'], by: '만두' });
  ok('줄 → 표 순번으로 알림톡을 보낸다', at.results[0].sent && at.results[0].reminderNo === 2);
  ok('실패 사유를 사람 말로 바꾼다', /방금 리뷰를 제출/.test(at.results[1].reason));
  ok('알림톡도 발송 기록이 남는다', logs.length === 2 && logs[0][0] === 'alimtalk' && logs[0][9] === 2);

  reminder.manualPreview = origManualPreview; solapi.sendSms = origSms; csBridge.postAdminNotice = origNotice; solapi.getSolapiStatus = origStatus;

  console.log('\n▶ ③ 라우트');
  const tb = read('server/src/routes/trackB.routes.js');
  ok('미리보기·발송 모두 내부 담당자 전원(광고주 차단)',
    /router\.post\('\/workdesk\/manual-send\/preview', authMiddleware, internalMiddleware,/.test(tb)
    && /router\.post\('\/workdesk\/manual-send', authMiddleware, internalMiddleware,/.test(tb));
  ok('보낼 방식이 없으면 400', /보낼 방식\(sms\|alimtalk\)이 필요합니다/.test(tb));
  ok('발송 기록 표 마이그레이션', /CREATE TABLE IF NOT EXISTS manual_message_sends/.test(read('server/migrations/171_manual_message_sends.sql')));

  console.log('\n▶ ④ 화면');
  const wd = read('frontend/workdesk.html');
  ok('우클릭 메뉴에 한 줄 추가(여러 줄이면 인원수)', /row\('📨', msgN>1\?`\$\{msgN\}명에게 문자·알림톡`:'문자·알림톡 보내기', "openManualSend\(\)"/.test(wd));
  const setTab = wd.slice(wd.indexOf('function _msSetTab'), wd.indexOf('async function _msLoad'));
  ok('탭 전환이 입력칸을 다시 만들지 않는다(IME 보호)', !/innerHTML/.test(setTab.replace(/rs\.innerHTML=''/, '')) && /style\.display/.test(setTab));
  ok('팝오버는 body 직속 · Esc 로 닫힘 · 리스너 1회', /document\.body\.appendChild\(ov\);[\s\S]{0,400}_msLoad\(\)/.test(wd) && /window\._msKeyBound/.test(wd));
  ok('시스템 확인창(confirm)을 쓰지 않는다', !/confirm\(`\$\{n\}명에게/.test(wd));
  {
    const vm = require('vm');
    const blk = wd.slice(wd.indexOf('function _msBytes'), wd.indexOf('function openManualSend'))
      + wd.slice(wd.indexOf('function _msPrice'), wd.indexOf('function _msConfirmBack'));
    const S = { esc: x => String(x), _MS: { footer: '', billing: { spendable: 30,
      prices: { ata: { unit: 13, vat: 14.3 }, sms: { unit: 18, vat: 19.8 }, lms: { unit: 45, vat: 49.5 } } } } };
    vm.runInNewContext(blk + '\nthis.h=_msConfirmHtml;', S);
    const ata = S.h(3, 'alimtalk', '');
    ok('확인 화면: 알림톡 1건당 부가세 포함 14.3원 · 별도 13원', /14\.3원/.test(ata) && /부가세 별도 13원/.test(ata));
    ok('확인 화면: 예상 합계 = 건당 × 인원', /42\.9원/.test(ata) && /3명/.test(ata));
    ok('확인 화면: 잔액이 모자라면 경고', /잔액이 예상 합계보다 적습니다/.test(ata));
    ok('문자는 길이로 단문/장문 단가를 고른다', /단문 문자\(SMS\)/.test(S.h(1, 'sms', '짧음')) && /19\.8원/.test(S.h(1, 'sms', '짧음'))
      && /장문 문자\(LMS\)/.test(S.h(1, 'sms', '가'.repeat(60))) && /49\.5원/.test(S.h(1, 'sms', '가'.repeat(60))));
    S._MS.billing = null;
    ok('단가를 못 받으면 금액을 지어내지 않는다', /단가를 불러오지 못했습니다/.test(S.h(1, 'alimtalk', '')) && !/\d원/.test(S.h(1, 'alimtalk', '').replace(/발송에 실패한/, '')));
  }
  ok('단가표: 종류별(알림톡·단문·장문) 부가세 포함 값을 싣는다', /prices: \['ata', 'sms', 'lms'\]/.test(read('server/src/services/solapi.service.js')));
  ok('문자 글자 수는 안내 문구 포함으로 센다', /_msBytes\(String\(ta\.value\|\|''\)\.trim\(\)\+\(_MS\.footer\|\|''\)\)/.test(wd));

  console.log(`\n✅ manualMessageSend: ${passed}개 통과`);
  pool.query = origQuery;
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
