/**
 * cashReceiptGuide.test.js — 현금영수증 안내(1단계) 회귀가드.
 *
 * 현영 탭 공고에서 리뷰어가 결제 **전에** 지출증빙 발행을 알 수 있어야 한다.
 * 발행 여부의 진실원본은 tab_configs.income_type 하나 — 공고 폼은 읽기 전용 표시만(이중 관리 방지).
 * 실행: node tests/cashReceiptGuide.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const camp = readS('routes/campaign.routes.js');
const tabc = readS('routes/tabconfig.routes.js');
const wd = readF('js/campaign-workdetail.js');
/* 설정탭 슬롯·업로드 로직은 공유 모듈(js/admin-settings.js)로 이관 — 리뷰웹시스템[3버전]과 한 벌.
   admin.html 은 마운트 지점만 들고 있으므로 함께 읽는다(검사 의미 불변). */
const set = readF('js/admin-settings.js');
const adm = readF('js/recruit-modal.js') + '\n' + readF('admin.html') + '\n' + set;
const app = readF('js/index-app.js') + '\n' + set;
const rec = readF('js/index-recruit.js');
const campHtml = readF('campaign.html');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 서버: 판정과 동봉 ── */
ok('현영 판정은 연결 탭의 income_type 하나만 본다(공고 컬럼 신설 없음)',
  /SELECT income_type FROM tab_configs WHERE sheet_id = \$1 AND tab_name = \$2/.test(camp)
  && /incomeType\.includes\('현영'\)/.test(camp));
ok('현영이 아니면 null — 일반 공고는 응답·화면 모두 불변',
  /if \(!incomeType\.includes\('현영'\)\) return null;/.test(camp));
ok('사업자번호 + 채널별 발행방법 이미지를 함께 조회',
  /CASH_RECEIPT_SETTING_KEYS/.test(camp) && /company_business_no/.test(camp));
ok('채널→이미지 선택은 단일 출처 유틸을 쓴다(사본 금지)',
  /require\('\.\.\/utils\/cashReceiptChannels'\)/.test(camp)
  && /cashReceiptChannelKey\(ch\)/.test(camp)
  && /map\[cashReceiptSettingKey\(chKey\)\]/.test(camp));
ok('판정 안 되는 채널은 이미지 없이 문구만(틀린 발행방법을 보여주지 않는다)',
  /chKey \? \(map\[cashReceiptSettingKey\(chKey\)\] \|\| ''\) : ''/.test(camp));
ok('조회 실패는 null 폴백 — 안내 장애가 작업내용 응답을 막지 않는다',
  /async function _cashReceiptInfo[\s\S]{0,1400}catch \(_\) \{\s*\n\s*return null;/.test(camp));
ok('리뷰어 work-detail 응답에 cashReceipt 동봉',
  /cashReceipt: await _cashReceiptInfo\(camp\),\s*\/\/ 현영 탭만/.test(camp));
ok('관리자 미리보기도 같은 값 — 미리보기 = 실제 화면',
  /cashReceipt: await _cashReceiptInfo\(camp\),\s*\/\/ 미리보기/.test(camp));

/* ── 설정: 채널별 이미지 등록 ── */
// ★ authMiddleware 가 반드시 앞에 와야 한다 — 빠지면 req.admin 이 undefined 라 전원 403.
//   (실측 사고: 이 라우트와 company-business-no 가 authMiddleware 없이 등록돼 아무도 저장 못 했다)
ok('발행방법 이미지 저장 엔드포인트(authMiddleware + adminOrMaster)',
  /router\.post\('\/cash-receipt-guide', authMiddleware, adminOrMasterMiddleware/.test(tabc));
ok('채널 화이트리스트 — 목록에 없는 키는 거부(임의 app_settings 키 생성 차단)',
  /if \(!isCashReceiptChannelKey\(channel\)\)/.test(tabc)
  && /res\.status\(400\)/.test(tabc));
ok('★ imageUrl은 https 절대 URL만 — 리뷰어 화면에 <img src>로 나가므로 자유 문자열 금지',
  /!\/\^https:\\\/\\\/\\S\+\$\/i\.test\(imageUrl\)/.test(tabc));
ok('provider-info가 등록된 이미지를 함께 반환(설정탭 프리필 공용)',
  /cashReceiptGuides/.test(tabc));

/* ── 렌더러: 리뷰어가 보는 카드 ── */
ok('현영일 때만 안내 카드 렌더(일반 공고는 미출력)',
  /var cr = d\.cashReceipt;/.test(wd) && /if \(cr && cr\.required\)/.test(wd));
ok('안내에 지출증빙 + 사업자번호 + 발행방법 이미지',
  /지출증빙 현금영수증/.test(wd) && /cr\.businessNo/.test(wd) && /cr\.guideImageUrl/.test(wd));
ok('결제 전 시점에 보이도록 상품 카드 바로 뒤에 배치',
  /상품 · 옵션 · 결제금액[\s\S]{0,700}var cr = d\.cashReceipt/.test(wd));
ok('제출 때 영수증 캡처가 필요하다는 예고 문구',
  /발행 내역 캡처가 필요해요/.test(wd));
ok('리뷰어 페이지가 서버 값을 렌더러에 전달', /cashReceipt: j\.cashReceipt/.test(campHtml));

/* ── 관리자 화면 ── */
/* ── ★ 채널 단일 출처 ↔ 소비처 3곳 정합 ──
   채널 목록이 서버 유틸·프론트 표·admin.html 슬롯에 흩어져 있어서, 하나만 빠뜨리면
   "등록은 되는데 리뷰어에겐 안 보이는" 조용한 사고가 난다(실측: 올리브영·카카오메이커스가
   WO_CHANNEL_HOSTS 에는 있는데 여기엔 없어 이미지가 빈 채로 나갔다). 셋의 일치를 고정한다. */
const chans = require('../src/utils/cashReceiptChannels');
ok('현영 채널 단일 출처에 4채널(쿠팡·네이버·올리브영·카카오메이커스)',
  chans.CASH_RECEIPT_CHANNELS.map(c => c.key).join(',') === 'coupang,naver,oliveyoung,kakao');
ok('★ 판정 우선순위 = 쿠팡 우선(기존 동작 보존 — 커스텀 채널명에 둘이 섞여도 종전과 같은 결과)',
  chans.cashReceiptChannelKey('쿠팡/네이버 병행') === 'coupang');
ok('채널 문자열 판정(버튼값·커스텀 모두)',
  chans.cashReceiptChannelKey('쿠팡') === 'coupang'
  && chans.cashReceiptChannelKey('네이버') === 'naver'
  && chans.cashReceiptChannelKey('올리브영') === 'oliveyoung'
  && chans.cashReceiptChannelKey('카카오메이커스') === 'kakao');
ok('★ 카카오는 "메이커스"를 요구 — 톡스토어·선물하기는 발행방법이 달라 같은 안내를 쓸 수 없다',
  chans.cashReceiptChannelKey('카카오톡스토어') === null
  && chans.cashReceiptChannelKey('카카오선물하기') === null);
ok('판정 실패·빈 값은 null = 이미지 없이 문구만(fail-soft)',
  chans.cashReceiptChannelKey('') === null && chans.cashReceiptChannelKey(null) === null
  && chans.cashReceiptChannelKey('11번가') === null);
ok('app_settings 키 규칙이 저장·조회 공용',
  chans.cashReceiptSettingKey('kakao') === 'cash_receipt_guide_kakao'
  && chans.CASH_RECEIPT_SETTING_KEYS.includes('cash_receipt_guide_oliveyoung'));
ok('화이트리스트가 목록 밖 키를 거부',
  chans.isCashReceiptChannelKey('coupang') === true
  && chans.isCashReceiptChannelKey('kakao') === true
  && chans.isCashReceiptChannelKey('evil') === false
  && chans.isCashReceiptChannelKey('') === false);
ok('★ 프론트 사본(CR_GUIDE_CHANNELS)이 서버 목록과 key·순서까지 일치',
  (() => {
    const m = app.match(/const CR_GUIDE_CHANNELS = \[([\s\S]*?)\];/);
    if (!m) return false;
    const keys = [...m[1].matchAll(/key:\s*'([a-z]+)'/g)].map(x => x[1]);
    return keys.join(',') === chans.CASH_RECEIPT_CHANNELS.map(c => c.key).join(',');
  })());
/* ★ 등록 슬롯은 이제 CR_GUIDE_CHANNELS 표에서 **생성**된다 — 손으로 4칸을 적어 두면
   채널을 늘릴 때 한 칸을 빠뜨리고도 조용히 통과한다(실측: 올리브영·카카오메이커스가 그렇게 빠졌다).
   그래서 "리터럴 id 4개"가 아니라 **표가 슬롯을 만든다**는 구조를 고정한다
   (표 ≡ 서버 목록은 바로 위 케이스가 이미 고정 → 슬롯 존재가 따라온다). */
ok('★ 등록 슬롯을 채널 표에서 생성(하드코딩 4칸 금지 = 채널 추가 시 누락 불가)',
  /crGuideImg\$\{c\.cap\}/.test(set) && /crGuideNone\$\{c\.cap\}/.test(set)
  && /crGuideFile\$\{c\.cap\}/.test(set)
  && /uploadCashReceiptGuide\('\$\{c\.key\}', this\)/.test(set)
  && /clearCashReceiptGuide\('\$\{c\.key\}'\)/.test(set)
  && /CR_GUIDE_CHANNELS\.map\(c =>/.test(set));
ok('★ 채널 표의 모든 항목이 cap(id 접미사)·label·emoji 를 갖는다(생성 시 빈 슬롯 방지)',
  chans.CASH_RECEIPT_CHANNELS.every(c => {
    const cap = c.key.charAt(0).toUpperCase() + c.key.slice(1);
    return new RegExp(`key: '${c.key}',\\s*cap: '${cap}',\\s*label: '[^']+',\\s*emoji: '[^']+'`).test(set);
  }));
ok('설정탭에 채널별 발행방법 이미지 업로드 칸(공유 모듈이 그리고, 두 화면이 마운트한다)',
  /function uploadCashReceiptGuide/.test(app)
  && /id="adminSettingsMount"/.test(readF('admin.html'))
  && /AdminSettings\.mount\('adminSettingsMount'[\s\S]{0,120}'business'/.test(readF('admin.html'))
  && /AdminSettings\.mount\('adminSettingsMount'[\s\S]{0,140}'business'/.test(readF('workdesk.html')));
ok('업로드는 guide-image 인프라 재사용(신규 저장소 없음)',
  /\/api\/order\/guide-image/.test(app) && /cashreceipt_/.test(app));
ok('공고 모달의 현금영수증은 읽기 전용 — 입력 필드가 아니다',
  /id="rf_cashrcpt_ro"/.test(adm) && !/id="rf_income_type"/.test(adm)
  && /탭 설정 · 읽기 전용/.test(adm));
ok('탭을 바꾸면 발행 여부를 다시 판정',
  /refreshRecruitCashReceipt\(\);\s*\/\/ 탭이 바뀌면/.test(rec));

/* ── ★★ 런타임 실행 가드 ──
   위 정적 검사는 "문자열이 있다"만 본다. 채널을 늘렸을 때 실제로 깨지는 곳은
   ① 저장 라우트가 새 채널을 거부하는지 ② provider-info 가 새 채널 키를 응답에 싣는지
   ③ 조회 SQL 이 새 키를 실제로 조회 대상에 넣는지다 — 스텁 pool 로 핸들러를 직접 돌린다. */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const poolPath = require.resolve('../src/db/pool');
let _q = [];
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => {
      _q.push({ sql: String(sql), params });
      if (/FROM app_settings/.test(sql)) {
        return { rows: [
          { key: 'company_business_no', value: '311-87-02345' },
          { key: 'cash_receipt_guide_oliveyoung', value: 'https://x/oy.png' },
          { key: 'cash_receipt_guide_kakao', value: 'https://x/kakao.png' },
        ] };
      }
      return { rows: [] };
    },
  },
};
const tabRouter = require('../src/routes/tabconfig.routes');
const findRoute = (p, m) => tabRouter.stack.find(l => l.route && l.route.path === p && l.route.methods[m]);
const runHandler = async (layer, req) => {
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let out = null, code = 200;
  const res = { json: (o) => { out = o; return res; }, status: (c) => { code = c; return res; } };
  await handler(req, res, (e) => { if (e) throw e; });
  return { out, code };
};

const guideLayer = findRoute('/cash-receipt-guide', 'post');
const infoLayer = findRoute('/provider-info', 'get');
ok('라우트가 실제로 등록돼 있다(정적 grep이 아니라 스택 검사)', !!guideLayer && !!infoLayer);

(async () => {
  // ① 새 채널이 저장 가능한가 / 목록 밖 키는 거부되는가
  for (const key of ['coupang', 'naver', 'oliveyoung', 'kakao']) {
    const r = await runHandler(guideLayer, { body: { channel: key, imageUrl: 'https://x/a.png' }, admin: { role: 'admin' } });
    assert(r.code === 200 && r.out && r.out.ok === true, `${key} 저장이 거부됨`);
    assert(_q.some(q => Array.isArray(q.params) && q.params[0] === `cash_receipt_guide_${key}`),
      `${key} 저장 키가 cash_receipt_guide_${key} 가 아님`);
  }
  n++; console.log('  ✓ ★ 4채널 전부 실제로 저장된다(올리브영·카카오메이커스 포함)');

  const bad = await runHandler(guideLayer, { body: { channel: 'evil', imageUrl: 'https://x/a.png' }, admin: { role: 'admin' } });
  assert(bad.code === 400 && bad.out.ok === false, '목록 밖 채널이 통과됨');
  n++; console.log('  ✓ ★ 목록 밖 채널은 400 — 임의 app_settings 키가 생기지 않는다');

  const noUrl = await runHandler(guideLayer, { body: { channel: 'kakao', imageUrl: 'http://x/a.png' }, admin: { role: 'admin' } });
  assert(noUrl.code === 400, 'https 아닌 URL 이 통과됨');
  n++; console.log('  ✓ https 절대 URL 검증이 새 채널에도 그대로 적용된다');

  // ② provider-info 가 4채널 키를 모두 싣는가 + ③ 조회 SQL 에 새 키가 들어가는가
  _q = [];
  const info = await runHandler(infoLayer, { query: {} });
  assert(info.out && info.out.ok, 'provider-info 응답 실패');
  const g = info.out.cashReceiptGuides || {};
  assert.deepStrictEqual(Object.keys(g).sort(), ['coupang', 'kakao', 'naver', 'oliveyoung'],
    'provider-info 응답에 4채널 키가 모두 있어야 한다');
  n++; console.log('  ✓ ★ provider-info 가 4채널 키를 모두 반환(설정탭 프리필 누락 차단)');

  assert(g.oliveyoung === 'https://x/oy.png' && g.kakao === 'https://x/kakao.png',
    '저장된 값이 채널 키에 매핑되지 않음');
  assert(g.coupang === '' && g.naver === '', '미등록 채널은 빈 문자열이어야 한다');
  n++; console.log('  ✓ ★ 저장값이 올바른 채널에 매핑되고, 미등록은 빈 값');

  const sel = _q.find(q => /FROM app_settings/.test(q.sql));
  assert(sel && Array.isArray(sel.params) && Array.isArray(sel.params[0]), '조회가 배열 파라미터를 쓰지 않음');
  assert(sel.params[0].includes('cash_receipt_guide_oliveyoung')
      && sel.params[0].includes('cash_receipt_guide_kakao')
      && sel.params[0].includes('company_business_no'),
    '조회 키 목록에 새 채널이 빠졌다 — 등록해도 화면에 안 뜬다');
  n++; console.log('  ✓ ★ 조회 SQL 이 새 채널 키를 실제로 포함(등록했는데 안 보이는 사고 차단)');

  console.log(`\n✅ cashReceiptGuide: ${n}개 통과`);
})().catch(e => { console.error('\n❌ 런타임 가드 실패:', e.message); process.exit(1); });
