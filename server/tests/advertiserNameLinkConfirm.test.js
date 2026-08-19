
/**
 * 회귀가드: 동일 이름 광고주 충돌 — "사람이 확인하면 연결, 자동 병합은 금지".
 *
 * 2026-08-19 실사고: 업체관리에서 먼저 만든 업체(intranet_advertiser_id 빈 값)와 이름이
 * 겹치면 접수가 영구 409 로 막혔고, 그 연결을 확인해 줄 창구가 화면 어디에도 없었다.
 * 여기서 고정하는 것 = (1) 자동 병합 부재 (2) 충돌 시 후보 동봉 (3) 확인(linkAdvertiserId)이
 * 있을 때만 blank-only 백필 (4) 남의 원본 탈취·경합 fail-closed (5) 화면 배선.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svcPath = path.join(root, 'src', 'services', 'advertiserProjection.service.js');
const svcSrc = fs.readFileSync(svcPath, 'utf8');
const orderRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'order.routes.js'), 'utf8');
const feRoot = path.join(root, '..', 'frontend');
const woDetail = fs.readFileSync(path.join(feRoot, 'js', 'work-order-detail.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(feRoot, 'workdesk.html'), 'utf8');
const indexApp = fs.readFileSync(path.join(feRoot, 'js', 'index-app.js'), 'utf8');

let failed = 0;
function ok(message, condition) {
  if (condition) { console.log('  ✓ ' + message); return; }
  failed++; console.log('  ✗ ' + message);
}

// 스텁 pool: SQL 패턴 -> 응답. 실행된 SQL 을 전부 기록한다.
function stubPool(handlers) {
  const log = [];
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      log.push({ text, params });
      for (const [re, res] of handlers) {
        if (re.test(text)) return typeof res === 'function' ? res(params) : res;
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, log };
}
const ran = (log, re) => log.some(q => re.test(q.text));

const ORDER = {
  id: 'wo_1', title: '작업', recruit_count: 20,
  intranet_advertiser_id: 'iadv_9', intranet_advertiser_name: '유일기획',
  intranet_advertiser_business_number: '000-00-00000', intranet_advertiser_contact: '담당 김씨',
};

console.log('advertiser name conflict - confirm-then-link');

(async () => {
  const { projectIntranetAdvertiser, ADVERTISER_NAME_CONFLICT } = require(svcPath);

  // (1) 원본 ID 미매칭 + 동명 업체 존재 + 확인 없음 -> 충돌(자동 병합·INSERT 금지)
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1/, { rows: [{ id: 'adv_old', intranet_advertiser_id: '' }] }],
      [/FROM advertisers a/, { rows: [{ id: 'adv_old', name: '유일기획', status: 'active', inadPm: '박은비', intranetAdvertiserId: '', businessNumber: '000-00-00000', contact: '', ownedTabs: 3, portalWorks: 1 }] }],
    ]);
    let err = null;
    try { await projectIntranetAdvertiser(ORDER, {}, { pool }); } catch (e) { err = e; }
    ok('동명 업체가 있으면 접수를 멈추고 충돌 코드를 던진다', err && err.code === ADVERTISER_NAME_CONFLICT);
    ok('충돌에는 사람이 판단할 후보(사업자번호·소유 작업 수)가 실린다',
      err && err.detail && err.detail.candidates.length === 1
      && err.detail.candidates[0].id === 'adv_old'
      && err.detail.candidates[0].ownedTabs === 3
      && err.detail.name === '유일기획' && err.detail.intranetAdvertiserId === 'iadv_9');
    ok('자동 병합 금지 - 충돌 시 advertisers INSERT/UPDATE 를 한 줄도 하지 않는다',
      !ran(log, /INSERT INTO advertisers/) && !ran(log, /UPDATE advertisers SET/));
    ok('충돌은 롤백으로 끝난다(부분 반영 없음)', ran(log, /^ROLLBACK$/m) && !ran(log, /COMMIT/));
  }

  // (2) 사람이 확인(linkAdvertiserId) -> blank-only 백필로 기존 업체에 연결
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1/, { rows: [{ id: 'adv_old', intranet_advertiser_id: '' }] }],
      [/FROM advertisers WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'adv_old', name: '유일기획', cur: '' }] }],
      [/UPDATE advertisers SET\s+intranet_advertiser_id/, { rows: [{ id: 'adv_old' }], rowCount: 1 }],
      [/INSERT INTO portal_works/, { rows: [{ id: 'pw_1' }] }],
    ]);
    const out = await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool });
    ok('확인한 기존 업체로 연결되고 포털 작업까지 만들어진다',
      out && out.advertiserId === 'adv_old' && out.portalWorkId === 'pw_1' && out.linkedExisting === true);
    const upd = log.find(q => /UPDATE advertisers SET\s+intranet_advertiser_id/.test(q.text));
    ok('백필은 blank-only - 이미 원본이 있는 업체를 덮지 않는다',
      !!upd && /WHERE id = \$1 AND COALESCE\(intranet_advertiser_id,''\) = ''/.test(upd.text));
    ok('연결 후 새 업체를 만들지 않는다', !ran(log, /INSERT INTO advertisers/));
    ok('작업오더에 업체를 결속하고 커밋한다', ran(log, /UPDATE work_orders SET advertiser_id/) && ran(log, /COMMIT/));
  }

  // (3) 이미 다른 인트라넷 광고주에 연결된 업체는 고를 수 없다(원본 탈취 금지)
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1/, { rows: [{ id: 'adv_old', intranet_advertiser_id: 'iadv_other' }] }],
      [/FROM advertisers WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'adv_old', name: '유일기획', cur: 'iadv_other' }] }],
    ]);
    let err = null;
    try { await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool }); } catch (e) { err = e; }
    ok('다른 원본에 연결된 업체는 거부한다(fail-closed)',
      err && err.code === 'advertiser_already_linked'
      && !ran(log, /UPDATE advertisers SET\s+intranet_advertiser_id/));
  }

  // (4) 화면이 보여준 뒤 이름이 바뀌면 판단 근거가 달라진 것 -> 다시 확인
  {
    const { pool } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1/, { rows: [{ id: 'adv_old', intranet_advertiser_id: '' }] }],
      [/FROM advertisers WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'adv_old', name: '다른회사', cur: '' }] }],
    ]);
    let err = null;
    try { await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool }); } catch (e) { err = e; }
    ok('그 사이 업체명이 바뀌면 연결하지 않는다', err && err.code === 'advertiser_name_changed');
  }

  // (5) 경합(그 사이 다른 세션이 연결) -> 0행 UPDATE 를 성공으로 읽지 않는다
  {
    const { pool } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1/, { rows: [{ id: 'adv_old', intranet_advertiser_id: '' }] }],
      [/FROM advertisers WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'adv_old', name: '유일기획', cur: '' }] }],
      [/UPDATE advertisers SET\s+intranet_advertiser_id/, { rows: [], rowCount: 0 }],
    ]);
    let err = null;
    try { await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool }); } catch (e) { err = e; }
    ok('백필이 0행이면 실패로 처리한다(경합)', err && err.code === 'advertiser_link_race');
  }

  // (6) 원본 ID 로 이미 연결된 업체가 있으면 확인값과 무관하게 그 업체가 이긴다
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [{ id: 'adv_linked', intranet_advertiser_id: 'iadv_9' }] }],
      [/INSERT INTO portal_works/, { rows: [{ id: 'pw_2' }] }],
    ]);
    const out = await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool });
    ok('원본 ID 매칭이 최우선 - 확인값이 있어도 다른 업체로 붙지 않는다',
      out.advertiserId === 'adv_linked' && !ran(log, /FROM advertisers WHERE name = \$1/));
  }

  // (7) 원본 ID 가 없는 오더(구버전·수동 오더)는 종전대로 아무 일도 하지 않는다
  {
    let connected = false;
    const pool = { connect: async () => { connected = true; return { query: async () => ({ rows: [] }), release() {} }; } };
    const out = await projectIntranetAdvertiser({ id: 'wo_2' }, {}, { pool });
    ok('인트라넷 원본 ID 가 없으면 무동작(기존 동작 불변)', out === null && !connected);
  }

  // 라우트·화면 배선
  ok('접수 라우트가 body.linkAdvertiserId 를 서비스로 넘긴다',
    /linkAdvertiserId: String\(\(req\.body \|\| \{\}\)\.linkAdvertiserId \|\| ''\)\.trim\(\)/.test(orderRoute));
  ok('충돌일 때만 후보를 409 응답에 실어 화면이 확인을 받게 한다',
    /ADVERTISER_NAME_CONFLICT/.test(orderRoute)
    && /advertiserNameConflict: projectionErr\.detail/.test(orderRoute));
  ok('확인 팝업은 공유 모듈 한 벌이다(사본 금지)',
    /function woAdvertiserLinkPicker/.test(woDetail)
    && /woAdvertiserLinkPicker: woAdvertiserLinkPicker/.test(woDetail)
    && !/function woAdvertiserLinkPicker/.test(workdesk)
    && !/function woAdvertiserLinkPicker/.test(indexApp));
  ok('팝업은 업체명을 onclick 문자열로 보간하지 않는다(외부 문자열 XSS 규율)',
    !/onclick=/.test(woDetail.slice(woDetail.indexOf('function woAdvertiserLinkPicker'),
                                    woDetail.indexOf('function woAdvertiserLinkPicker') + 6000)));
  ok('이미 연결된 후보는 누를 수 없다(눌러도 서버가 거부하는 버튼을 두지 않는다)',
    /b\.disabled = true;[\s\S]{0,300}다른 인트라넷 광고주에 이미 연결됨/.test(woDetail));
  ok('리뷰웹시스템[3버전] 접수가 충돌 팝업을 열고 확인값으로 재접수한다',
    /r&&r\.advertiserNameConflict&&typeof woAdvertiserLinkPicker/.test(workdesk)
    && /linkAdvertiserId:advId/.test(workdesk)
    && /body\.linkAdvertiserId=opts\.linkAdvertiserId/.test(workdesk));
  ok('관리자 대시보드 접수도 같은 팝업·같은 파라미터를 쓴다',
    /r\.advertiserNameConflict && typeof woAdvertiserLinkPicker === "function"/.test(indexApp)
    && /woAdvertiserLinkPicker\(r, advId => woAccept\(id, pickGid, advId\)\)/.test(indexApp)
    && /payload\.linkAdvertiserId = linkAdvertiserId/.test(indexApp));
  ok('확인 팝업을 거친 재접수는 확인창을 다시 띄우지 않는다',
    /const _confirmed = !!pickGid \|\| !!\(opts&&opts\.linkAdvertiserId\)/.test(workdesk));
  // 사업자번호 줄 — "미등록"과 "원본과 다름"은 다른 신호다(사용자 지적 2026-08-19).
  {
    const vm = require('vm');
    const src = woDetail.slice(woDetail.indexOf('function _woAdvBizLine'),
                               woDetail.indexOf('function woAdvertiserLinkPicker'));
    const sandbox = { };
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.fn = _woAdvBizLine;', sandbox);
    const fn = sandbox.fn;
    const empty = fn('', '365-87-02833');
    ok('리뷰웹에 값이 없으면 "미등록 · 연결하면 채워집니다"로 말한다(대조 실패로 읽히지 않게)',
      empty.tone === 'muted' && /미등록/.test(empty.text) && /채워집니다/.test(empty.text)
      && !/없음/.test(empty.text));
    ok('표기가 달라도 숫자가 같으면 일치로 본다',
      fn('3658702833', '365-87-02833').tone === 'ok');
    ok('값이 있는데 원본과 다르면 경고한다(막지는 않는다)',
      fn('111-11-11111', '365-87-02833').tone === 'warn');
    ok('원본에 사업자번호가 없으면 비교하지 않고 값만 보여준다',
      fn('365-87-02833', '').tone === 'plain');
  }

  const NUL = String.fromCharCode(0);
  ok('소스에 리터럴 NUL 이 없다', !svcSrc.includes(NUL) && !woDetail.includes(NUL));

  console.log(failed ? 'advertiserNameLinkConfirm: FAILED (' + failed + ')' : 'advertiserNameLinkConfirm: passed');
  process.exit(failed ? 1 : 0);
})();
