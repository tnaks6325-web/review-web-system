/**
 * workboardReviewerMessage.test.js — 작업보드 우클릭 → 리뷰어에게 메시지 회귀가드.
 *
 * 고정하는 불변식:
 *   A. 수신자 판정(csRecipient) — ① 참여 원장 owner_phone8 > ② 제출 신원 링크 > ③ 본인 명의 >
 *      ④ 타계정 역조회. ★ 이름만으로 추측하지 않는다 · 모호하면 안 보낸다 · 등록 리뷰어가
 *      아니면 안 보낸다 · 사유를 문장으로 말한다.
 *   B. 라우트 — 내부인 전원(광고주 차단, 사용자 확정 2026-08-21) · 미리보기는 **쓰기 0건** ·
 *      같은 본계정은 한 번만 발송 · expect 불일치(TOCTOU)는 미발송 · 실행부는 csBridge 한 벌.
 *   C. 화면 — 광고주 미노출 · body 직속 팝업 · 바깥클릭 미닫힘 · Esc 1회 · IME(재렌더 금지) ·
 *      onclick 문자열 보간 0 · 프론트 판정 사본 0.
 *   D. 인라인 팝오버 + 사진 첨부(사용자 확정 2026-08-21) — 중앙 모달이 아니라 **누른 셀 옆** ·
 *      겉면이 표 조작을 흡수하지 않는다 · 붙여넣기·드래그가 **한 함수**로 수렴 ·
 *      파일 탐색기 창구 없음 · 업로드 인플라이트 중 전송 차단 · 첨부 URL 화이트리스트 **사본 0**.
 *
 * 실행: node tests/workboardReviewerMessage.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readSrv = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0, fail = 0;
const ok = (name, cond, extra) => {
  n++;
  if (cond === undefined || cond) console.log('  ✓ ' + name);
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── 스텁 pool — SQL 조각으로 분기한다.
   ★ 스텁 분기는 **더 좁은 조건을 먼저** 둔다(레포 실측 함정: 넓은 분기가 좁은 쿼리를 가로챈다). */
const poolPath = require.resolve('../src/db/pool');
let RULES = [], SEEN = [];
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => {
      SEEN.push({ sql, params });
      for (const [re, rows] of RULES) if (re.test(sql)) return { rows: rows || [], rowCount: (rows || []).length };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => { throw new Error('connect 불필요'); },
  },
};
function setDb(rules) { RULES = rules || []; SEEN = []; }

const SVC = require('../src/services/csRecipient.service');

/* 재료 조립기 — 한 줄(cp) + 각 근거를 켜고 끄며 우선순위를 본다. */
const CP = (o) => Object.assign({ id: 'p1', seq: 10, rowName: '박은비', rowPhone8: '82217191', orderId: null }, o);
const rules = ({ cp, order, link, revs, subs }) => ([
  [/FROM campaign_participants/, [cp]],
  [/FROM campaign_applications/, order || []],
  [/FROM participation_links/, link || []],
  [/jsonb_array_elements/, subs || []],           // ★ reviewers 보다 좁은 조건이 먼저
  [/FROM reviewers/, revs || []],
]);
const one = async (args) => { setDb(rules(args)); const r = await SVC.resolveRecipients({ sheetId: 's', tabName: 't', participantIds: ['p1'] }); return r[0]; };

(async () => {
  /* ═══ A. 수신자 판정 ═══ */
  console.log('\n[A] 수신자 판정 — 본계정을 찾는다');
  {
    // A1 — 근거가 전부 있을 때 ① 참여 원장이 이긴다
    const r = await one({
      cp: CP({ orderId: 'o1' }),
      order: [{ orderId: 'o1', n: 1, ownerPhone8: '11112222' }],
      link: [{ seq: 10, phone8: '33334444', name: '김소유' }],
      revs: [{ phone8: '11112222', name: '김소유', subAccounts: [{ name: '박은비', phone: '010-8221-7191' }] },
             { phone8: '33334444', name: '다른사람', subAccounts: [] },
             { phone8: '82217191', name: '박은비', subAccounts: [] }],
    });
    ok('★ ① 참여 원장(owner_phone8)이 최우선', r.ok && r.phone8 === '11112222' && r.via === 'owner_order', JSON.stringify(r));
    ok('타계정 명의는 isSub 로 드러난다(화면이 "본계정으로 보냅니다"를 말한다)', r.isSub === true);
  }
  {
    // A2 — 원장이 없으면 ② 신원 링크. 단 그 소유자의 타계정 목록에 그 줄이 있어야 한다.
    const base = { cp: CP({}), link: [{ seq: 10, phone8: '33334444', name: '김소유' }] };
    const good = await one(Object.assign({}, base, {
      revs: [{ phone8: '33334444', name: '김소유', subAccounts: [{ name: '박은비', phone: '01082217191' }] }],
    }));
    ok('② 제출 신원 링크 — 타계정이 등록돼 있으면 채택', good.ok && good.phone8 === '33334444' && good.via === 'owner_link');
    const stale = await one(Object.assign({}, base, {
      revs: [{ phone8: '33334444', name: '김소유', subAccounts: [{ name: '전혀다른명의', phone: '00000000' }] }],
    }));
    ok('★ 이름·번호 어느 것도 안 맞는 stale 링크는 채택하지 않는다(남의 방 열기 차단)',
      !(stale.ok && stale.via === 'owner_link'), JSON.stringify(stale));
  }
  {
    // A3 — 명의 자체가 등록 리뷰어면 그 번호가 곧 로그인 계정
    const r = await one({ cp: CP({}), revs: [{ phone8: '82217191', name: '박은비', subAccounts: [] }] });
    ok('③ 본인 명의(등록 리뷰어) — 그 번호로 보낸다', r.ok && r.phone8 === '82217191' && r.via === 'self');
    ok('본인 명의는 isSub 가 아니다', r.isSub === false);
  }
  {
    // A4 — 등록 안 된 번호지만 누군가의 타계정으로 등록돼 있다
    const r = await one({
      cp: CP({}),
      subs: [{ ownerPhone8: '55556666', subPhone8: '82217191' }],
      revs: [{ phone8: '55556666', name: '김소유', subAccounts: [{ name: '박은비', phone: '01082217191' }] }],
    });
    ok('④ 타계정 역조회(번호 일치) — 소유자 본계정으로', r.ok && r.phone8 === '55556666' && r.via === 'owner_sub');
  }
  {
    // A5 — 같은 번호가 두 소유자의 타계정 → 누구인지 정할 수 없다
    const r = await one({
      cp: CP({}),
      subs: [{ ownerPhone8: '55556666', subPhone8: '82217191' }, { ownerPhone8: '77778888', subPhone8: '82217191' }],
      revs: [{ phone8: '55556666', name: 'A', subAccounts: [] }, { phone8: '77778888', name: 'B', subAccounts: [] }],
    });
    ok('★ 모호하면 보내지 않는다(2명의 타계정)', !r.ok && /특정할 수 없/.test(r.reason || ''), JSON.stringify(r));
  }
  {
    const r = await one({ cp: CP({ rowPhone8: '' }) });
    ok('연락처 없는 줄 — 사유를 구분해 말한다', !r.ok && /연락처가 비어/.test(r.reason || ''), r.reason);
  }
  {
    const r = await one({ cp: CP({}) });   // reviewers 0행
    ok('★ 등록 리뷰어가 아니면 보내지 않는다(로그인 못 하는 방 금지)',
      !r.ok && /등록된 리뷰어를 찾지 못/.test(r.reason || ''), r.reason);
  }
  {
    setDb([[/FROM campaign_participants/, []]]);
    const r = (await SVC.resolveRecipients({ sheetId: 's', tabName: 't', participantIds: ['zz'] }))[0];
    ok('표에 없는 줄(삭제·분리)은 대상 아님', !r.ok && /표에 없는/.test(r.reason || ''));
  }
  {
    // 이름 어긋남은 **막지 않고 밝힌다**
    const r = await one({ cp: CP({ rowName: '수취인이름' }), revs: [{ phone8: '82217191', name: '박은비', subAccounts: [] }] });
    ok('표 이름 ≠ 등록 이름이면 경고만(차단 아님)', r.ok && r.nameMismatch === true);
  }
  {
    setDb(rules({ cp: CP({}) }));
    await SVC.resolveRecipients({ sheetId: 's', tabName: 't', participantIds: ['p1'] });
    ok('★ 판정은 읽기 전용 — INSERT/UPDATE/DELETE 0건',
      !SEEN.some(q => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.sql)), SEEN.map(q => q.sql.slice(0, 30)).join('|'));
    ok('대상 줄은 표와 같은 조건으로 고른다(삭제·분리·비활성 제외)',
      /deleted_at IS NULL[\s\S]*active = TRUE[\s\S]*held_at IS NULL/.test(SEEN[0].sql));
  }

  /* ═══ B. 라우트 ═══ */
  console.log('\n[B] 라우트 — 게이트 · 쓰기 표면 · 중복 발송');
  const router = require('../src/routes/trackB.routes');
  const CSB = require('../src/services/csBridge.service');
  const findLayer = (method, p) => (router.stack || []).find(l => l.route && l.route.path === p && l.route.methods[method]);
  {
    for (const [method, p] of [['get', '/cs/participant-recipients'], ['post', '/cs/notify-participants']]) {
      const layer = findLayer(method, p);
      ok(`${method.toUpperCase()} ${p} 등록`, !!layer);
      const names = layer.route.stack.map(s => s.name);
      ok(`${p} — authMiddleware 를 먼저 탄다`, names[0] === 'authMiddleware', names.join(','));
      ok(`${p} — 내부인 전원(광고주 차단)`, names.includes('internalMiddleware'), names.join(','));
    }
    const src = readSrv('src/routes/trackB.routes.js');
    const i = src.indexOf("router.post('/cs/notify-participants'");
    const body = src.slice(i, src.indexOf('\n/* ═', i));
    ok('★ 실행부는 csBridge 한 벌(방 생성·SSE·닉네임 치환 방어를 복제하지 않는다)',
      /_csBridge\.postAdminNotice\(/.test(body) && !/INSERT INTO cs_/.test(body));
    ok('★ 판정은 서버가 다시 한다(화면이 보낸 번호를 믿지 않는다)',
      /_csRecipient\.resolveRecipients\(/.test(body) && !/b\.phone8/.test(body));
  }
  const fakeRes = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };
  const call = async (method, p, req) => {
    const layer = findLayer(method, p);
    const h = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = fakeRes(); await h(Object.assign({ admin: { role: 'admin', name: '만두' } }, req), res, () => {});
    return res;
  };
  {
    setDb(rules({ cp: CP({}), revs: [{ phone8: '82217191', name: '박은비', subAccounts: [] }] }));
    const res = await call('get', '/cs/participant-recipients', { query: { sheetId: 's', tabName: 't', ids: 'p1' } });
    ok('미리보기 — 받는 사람을 돌려준다', res.body && res.body.ok && res.body.items[0].phone8 === '82217191');
    // ★ 부팅 시 도는 스키마 점검(ALTER/app_settings)은 이 라우트의 일이 아니다 — 도메인 표만 본다.
    const domainWrite = q => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.sql)
      && /cs_threads|cs_messages|campaign_participants|campaign_applications|participation_links|reviewers/i.test(q.sql);
    ok('★ 미리보기는 쓰기 0건', !SEEN.some(domainWrite),
      (SEEN.filter(domainWrite)[0] || {}).sql);
    ok('[문의방 열기] 가능 여부를 서버가 판정(admin)', res.body.canOpenThread === true);
    const res2 = await call('get', '/cs/participant-recipients', { query: { sheetId: 's', tabName: 't', ids: 'p1' }, admin: { role: 'staff', name: 'AE' } });
    ok('★ AE 는 문의방을 열 수 없다(C/S 본문은 master/admin 전용)', res2.body.canOpenThread === false);
  }
  {
    // 같은 리뷰어의 두 줄 → 방은 하나 → **한 번만** 보낸다
    const sentTo = [];
    const orig = CSB.postAdminNotice;
    CSB.postAdminNotice = async (p) => { sentTo.push(p); return { threadId: 'T1', messageId: 'M1' }; };
    setDb([
      [/FROM campaign_participants/, [CP({ id: 'p1', seq: 10 }), CP({ id: 'p2', seq: 11 })]],
      [/jsonb_array_elements/, []],
      [/FROM reviewers/, [{ phone8: '82217191', name: '박은비', subAccounts: [] }]],
    ]);
    const res = await call('post', '/cs/notify-participants', { body: { sheetId: 's', tabName: 't', participantIds: ['p1', 'p2'], content: '안내드립니다' } });
    ok('★ 같은 본계정은 한 번만 보낸다(같은 방에 같은 글 두 번 금지)', sentTo.length === 1, 'calls=' + sentTo.length);
    ok('합쳐진 줄을 조용히 버리지 않고 건수를 말한다', res.body.merged.length === 1);
    /* 받는 사람 확인용 **전체 연락처**(사용자 확정 2026-08-21 — 뒤 4자리로는 누구인지 알 수 없다).
       ★ 내부인 전용 화면이고 작업보드 표에도 연락처가 그대로 보인다(광고주는 라우터가 막는다). */
    ok('보낸 결과에 받는 사람 연락처가 실린다(뒤 4자리는 폴백으로 유지)',
      res.body.sent[0].phone8Tail === '7191' && 'phone' in res.body.sent[0]);

    // expect 불일치 = 미리보기 이후 대상이 바뀜 → 보내지 않는다
    sentTo.length = 0;
    const res2 = await call('post', '/cs/notify-participants', { body: { sheetId: 's', tabName: 't', participantIds: ['p1'], content: 'x', expect: { p1: '99999999' } } });
    ok('★ 미리보기 이후 대상이 바뀌면 보내지 않는다(TOCTOU)', sentTo.length === 0 && res2.body.failed.length === 1);

    // 빈 본문·과길이는 400 + 발송 0
    sentTo.length = 0;
    const r3 = await call('post', '/cs/notify-participants', { body: { sheetId: 's', tabName: 't', participantIds: ['p1'], content: '   ' } });
    ok('빈 내용은 400 · 발송 0', r3.code === 400 && sentTo.length === 0);
    const r4 = await call('post', '/cs/notify-participants', { body: { sheetId: 's', tabName: 't', participantIds: ['p1'], content: 'x'.repeat(1001) } });
    ok('1000자 초과는 400 · 발송 0', r4.code === 400 && sentTo.length === 0);
    CSB.postAdminNotice = orig;
  }

  /* ═══ C. 화면 배선 ═══ */
  console.log('\n[C] 화면 — 우클릭 메뉴 · 팝업');
  {
    const WD = readFront('workdesk.html');
    ok('우클릭 메뉴에 [💬 리뷰어에게 메시지] 항목', /row\('💬',[\s\S]{0,120}openReviewerMsg\(\)/.test(WD));
    ok('★ 광고주에겐 그리지 않는다(_msgCanSend = 내부인 + 열린 작업)',
      /function _msgCanSend\(\)\{ return !!\(STATE\.cur && _isInternalRole\(\)\); \}/.test(WD));
    ok('★ onclick 에 시트발 문자열을 넣지 않는다(인자 없음 — 줄은 선택 상태에서 읽는다)',
      /openReviewerMsg\(\)/.test(WD) && !/openReviewerMsg\('/.test(WD));
    ok('선택 범위의 줄 id 는 화면 순서·중복 없이 모은다', /function _msgRowIds\(\)[\s\S]{0,320}seen\.has\(id\)/.test(WD));
    ok('★ 팝업은 body 직속(뷰 스크롤 컨테이너에 두면 화면 흐름에 섞인다)',
      /id='rmOv'[\s\S]{0,400}document\.body\.appendChild\(ov\)/.test(WD));
    ok('★ 바깥 클릭으로 닫지 않는다(입력한 내용 보호)', !/rmOv[\s\S]{0,200}onclick="_rmClose\(\)"[\s\S]{0,40}wbl-dlg/.test(WD));
    ok('★ Esc 리스너는 최상위 1회', (WD.match(/_rmKeyBound=true/g) || []).length === 1);
    ok('★ 재렌더가 textarea 를 다시 만들지 않는다(한글 IME 조합 파괴 금지)',
      /function _rmPaint\(\)/.test(WD) && !/function _rmPaint\(\)[\s\S]{0,900}rmBody['"]?\)\.innerHTML/.test(WD));
    ok('보낼 수 없는 줄은 사유를 화면이 말한다', /보낼 수 없는 줄/.test(WD));
    ok('★ [문의방 열기]는 canOpen 이고 단건일 때만(AE 막다른 길 금지)',
      /_RM\.canOpen&&sent\.length===1/.test(WD));
    ok('★ 문의방은 목록 행을 눌러서 연다(이름·연락처를 화면에 한 번 더 싣지 않는다)',
      /cs-room-row\[data-tid=/.test(WD) && /row\.click\(\)/.test(WD));
    ok('전송 실패 시 입력 내용을 지우지 않는다', /입력한 내용은 그대로 둔다/.test(WD));
    ok('★ 연락처는 등록 원장 값을 쓴다 — phone8 앞에 010 을 지어내지 않는다',
      /const full=String\(\(x&&x\.phone\)\|\|\(x&&x\.phoneFull\)\|\|''\)/.test(WD)
      && !/'010-'\+.*phone8/.test(WD.slice(WD.indexOf('function _rmPhone'), WD.indexOf('function _rmSendable'))));
    ok('★ 프론트에 판정 사본 0(owner_phone8·participation_links 문자열 없음)',
      !/owner_phone8/.test(WD) && !/participation_links/.test(WD));

    /* ★★ 클래스 이름 충돌 — 실측 사고 2026-08-21.
       `.rmrow` 는 이미 **명단에서 제거 × 버튼**(22×22 고정)이 쓰던 전역 클래스라, 팝업 줄이 그 크기에
       갇혀 글자가 세로로 접히고 겹쳤다. 맨몸 `.why`/`.num`/`.tag` 도 다른 화면이 이미 쓴다.
       → 이 팝업의 클래스는 **전부 `rm` 접두**로 스코프한다(레포 `ad*`·`wbl-` 규율과 같다). */
    const rmJs = WD.slice(WD.indexOf('let _RM=null;'), WD.indexOf('/* ── 관리자 수동 리뷰제출'));
    ok('★ 전역 `.rmrow`(× 버튼)와 겹치는 이름을 쓰지 않는다', !/class="rmrow"/.test(rmJs));
    const bare = (rmJs.match(/class="(why|num|tag|row|item|who)"/g) || []);
    ok('★ 맨몸 클래스(why·num·tag…)를 쓰지 않는다 — 남의 화면 규칙이 흘러든다', !bare.length, bare.join(','));
    // 껍데기(wbl-*)·버튼(btn)은 **의도된 공용 클래스**다. 그 밖에는 전부 rm 접두여야 한다.
    const own = (rmJs.match(/class="([a-z-]+)"/g) || []).filter(c => !/class="(wbl-[a-z]+|btn)"/.test(c));
    ok('팝업 전용 클래스는 전부 rm 접두', own.every(c => /class="rm[a-z]*"/.test(c)), own.join(','));
    ok('★ 전송 실패는 서버가 준 건별 사유를 그대로 보여준다(한 줄로 뭉개지 않는다)',
      /d&&d\.failed/.test(rmJs) && /x\.reason/.test(rmJs));
  }
  /* ═══ D. 인라인 팝오버 + 사진 첨부 (사용자 확정 2026-08-21) ═══ */
  console.log('\n[D] 인라인 팝오버 · 붙여넣기 첨부');
  {
    const WD = readFront('workdesk.html');
    const css = WD.slice(WD.indexOf('#rmOv{'), WD.indexOf('#hbOv table.wbl-t'));
    const rmJs = WD.slice(WD.indexOf('let _RM=null;'), WD.indexOf('/* ── 관리자 수동 리뷰제출'));

    ok('★ 중앙 모달이 아니라 누른 셀 옆에 붙는다(앵커 계산)',
      /function _rmPlace\(\)[\s\S]{0,900}box\.style\.left=/.test(rmJs) && /_selAnchorTd\(\)/.test(rmJs));
    ok('★ 아래 공간이 부족하면 위로 뒤집는다(화면 밖 금지)',
      /a\.top-h-4/.test(rmJs) && /below\s*>=\s*above/.test(rmJs));
    /* ★★ 양쪽 다 좁을 때 화면 위(top:8)로 클램프하면 그건 셀 옆이 아니라 그냥 뜬 창이다
       (실브라우저가 잡았다) — 남은 공간에 맞춰 높이를 주고 **안에서 스크롤**시킨다. */
    ok('★★ 양쪽이 좁으면 더 넓은 쪽에 붙이고 안에서 스크롤(위로 튀지 않는다)',
      /box\.style\.maxHeight=/.test(rmJs) && /Math\.max\(220,/.test(rmJs));
    ok('★★ 겉면이 표 조작을 흡수하지 않는다(pointer-events:none) — 흡수하면 그건 모달이다',
      /#rmOv\{[^}]*pointer-events:none/.test(css) && /\.rmbox\{[^}]*pointer-events:auto/.test(css));
    ok('★ 모달 껍데기(.wbl-dlg)를 쓰지 않는다', !/wbl-dlg/.test(rmJs));
    ok('★ 스크롤·리사이즈에 앵커를 다시 잰다(입력 중이라 닫을 수 없다 — 달력과 다른 점)',
      /window\.addEventListener\('scroll',\(\)=>\{ if\(_RM\) _rmPlace\(\); \},true\)/.test(WD)
      && /el&&el\.isConnected/.test(rmJs));

    ok('★ 붙여넣기(Ctrl+V) 첨부 — 이미지일 때만 가로챈다(텍스트 붙여넣기 기본 동작 보존)',
      /addEventListener\('paste'[\s\S]{0,420}startsWith\('image\/'\)[\s\S]{0,160}e\.preventDefault\(\); _rmTake\(/.test(WD));
    ok('★ 붙여넣기 리스너도 최상위 1회(열 때마다 걸면 겹쳐 쌓인다)',
      (WD.match(/addEventListener\('paste'/g) || []).length >= 1 && (rmJs.match(/_rmKeyBound=true/g) || []).length === 1);
    ok('★★ 붙여넣기·드래그가 **같은 함수**로 수렴(사본을 두면 한쪽만 장수·용량 제한이 풀린다)',
      /drop['"],e=>\{[\s\S]{0,160}_rmTake\(e\.dataTransfer/.test(rmJs) && (rmJs.match(/function _rmTake\(/g) || []).length === 1);
    ok('★ 드래그오버는 **파일 드래그일 때만** 반응(표 안 텍스트 선택과 섞이지 않게)',
      /dataTransfer&&\[\.\.\.e\.dataTransfer\.types\|\|\[\]\]\.includes\('Files'\)/.test(rmJs));
    ok('★ 파일 탐색기 창구를 두지 않는다(붙여넣기·드래그 전용 — [리뷰 대신 제출] 과 같은 규율)',
      !/type=["']file["']/.test(rmJs));
    ok('장수·용량 상한이 한 곳에 있다(5장 · 8MB)',
      /_RM_MAX_FILES=5, _RM_MAX_ONE=8\*1024\*1024/.test(WD));
    ok('★ 상한 초과는 조용히 버리지 않고 사유를 말한다',
      /최대 \$\{_RM_MAX_FILES\}장/.test(rmJs) && /한 장당 8MB/.test(rmJs));
    ok('★★ 업로드가 끝난 것만 보낸다(인플라이트 중 전송 차단)',
      /function _rmSendable\(\)[\s\S]{0,320}files\|\|\[\]\)\.some\(f=>f\.busy\)\) return false/.test(rmJs));
    ok('★ 첨부만 있고 본문이 비어도 보낼 수 있다(사진 안내)',
      /!content && !imageUrls\.length/.test(rmJs));
    ok('★ 첨부 빼기 onclick 은 **인덱스만**(파일명·URL 보간 0)',
      /onclick="_rmDropAt\(\$\{i\}\)"/.test(rmJs) && !/_rmDropAt\('/.test(rmJs));
    ok('전송 payload 에 imageUrls 를 싣는다',
      /notify-participants[\s\S]{0,320}imageUrls,/.test(rmJs));
    ok('★ 팝오버를 닫으면 미리보기 URL 을 반납한다(objectURL 누수 금지)',
      /revokeObjectURL/.test(rmJs));
  }
  {
    /* 업로드 창구 — 실행부는 `/cs/upload` 와 **같은 핸들러**(사본 0), 게이트만 내부인.
       ★ 메시지를 보낼 수 있는 사람은 사진도 붙일 수 있어야 한다(눌러도 403 인 막다른 길 금지). */
    const up = findLayer('post', '/cs/notify-upload');
    ok('업로드 라우트가 등록돼 있다', !!up);
    const names = up.route.stack.map(x => x.handle.name);
    ok('★ 게이트 = 인증 + 내부인(광고주 차단)',
      names.includes('authMiddleware') && names.includes('internalMiddleware') && !names.includes('adminOrMasterMiddleware'),
      names.join(','));
    const src = readSrv('src/routes/trackB.routes.js');
    ok('★ 실행부는 기존 C/S 업로드 핸들러 한 벌(Drive 폴더·8MB·프록시 URL 규칙 복제 0)',
      /notify-upload['"][\s\S]{0,220}_csHandlers\.upload\(req, res, next\)/.test(src));
    const csSrc = readSrv('src/routes/cs.routes.js');
    ok("★ `/cs/upload`도 C/S 공통 게이트(내부인 전원)를 그대로 탄다",
      /router\.use\(authMiddleware, internalMiddleware\)/.test(csSrc)
      && /router\.post\('\/upload', async \(req, res, next\)/.test(csSrc));
  }
  {
    /* ★★ 첨부 URL 화이트리스트는 **단일 출처**(utils/csImageUrls) — 종전엔 같은 정규식이
       cs.routes·reviewer.routes 두 곳에 복사돼 있었고, 한쪽만 넓히면 그 경로로 임의 URL 이 들어온다. */
    const u = require('../src/utils/csImageUrls');
    ok('우리 프록시 주소만 통과',
      u.sanitizeCsImageUrls(['https://x.dev/api/order/guide-image/abcdefghij0123456789']).length === 1
      && u.sanitizeCsImageUrls(['https://evil.example/a.png']).length === 0);
    ok('★ 상한 5장', u.sanitizeCsImageUrls(new Array(9).fill('https://x.dev/api/order/guide-image/abcdefghij0123456789')).length === 5);
    for (const f of ['src/routes/cs.routes.js', 'src/routes/reviewer.routes.js', 'src/services/csBridge.service.js']) {
      const t = readSrv(f);
      ok(`★ 사본 0 — ${f.split('/').pop()} 는 단일 출처를 부른다`,
        /require\((['"]).*csImageUrls\1\)/.test(t) && !/guide-image\\\//.test(t.replace(/utils\/csImageUrls/g, '')),
        (t.match(/api\\\/order\\\/guide-image/g) || []).join(','));
    }
    const cb = readSrv('src/services/csBridge.service.js');
    ok('★ 저장 컬럼도 SQL 에서 접는다(image_urls 도 NOT NULL 계열 — 맨 null 금지)',
      /COALESCE\(\$6::jsonb,\s*'\[\]'::jsonb\)/.test(cb));
    ok('★ SSE 푸시에도 첨부가 실린다(목록 API 만 고치면 실시간 푸시에서 사진이 사라진다)',
      /imageUrls: imgs,/.test(cb));
  }

  {
    const src = readSrv('src/services/csBridge.service.js');
    ok('★ csBridge 는 실패 사유를 호출자에게 흘려보낸다(onError, 가산 옵션)',
      /card, imageUrls, onError \} = \{\}\)/.test(src) && /typeof onError === 'function'/.test(src));
    ok('★ 반환 계약은 그대로(성공 객체 | null) — 기존 호출부의 `if (!out)` 판정 불변',
      /try \{ if \(typeof onError === 'function'\) onError\(err\); \} catch \(_\) \{\}\s*\n\s*return null;/.test(src));
  }

  console.log(`\n${fail ? '✗ 실패 ' + fail + '건 / ' : '✓ '}${n}개 검사 통과`);
  process.exit(fail ? 1 : 0);
})();
