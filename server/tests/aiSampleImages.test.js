/**
 * aiSampleImages.test.js — AI 판별 예시이미지(현금영수증 · 리뷰) 회귀가드.
 *
 * 무엇을 고정하나:
 *  ① 현금영수증 예시는 **발행방법 이미지와 다른 슬롯**이다(리뷰어 안내 ≠ AI 기준).
 *  ② 채널 표는 서버 단일 출처 하나 — 프론트에 사본을 만들지 않는다(설정 화면은 서버 응답을 그린다).
 *  ③ 슬롯에 맞는 예시를 준다 — 영수증 슬롯엔 현금영수증 예시(리뷰 예시를 주면 판정이 흔들린다).
 *  ④ 캐시 지문이 리뷰 예시와 겹치지 않는다(겹치면 다른 예시로 낸 판정이 히트한다).
 *  ⑤ 등록 전이면 빈 배열 = **오늘과 동작 동일**(fail-open).
 *
 * 실행: node tests/aiSampleImages.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const CH = require('../src/utils/cashReceiptChannels');
const RI = require('../src/services/reviewInspect.service');
const set = readF('js/admin-settings.js');
const adm = readF('admin.html');
const wdk = readF('workdesk.html');
const idx = readF('js/index-app.js');
const diag = readS('routes/diag.routes.js');
const gem = readS('services/gemini.service.js');
const svc = readS('services/reviewInspect.service.js');

/* ═══ 1) 키 규칙 — 발행방법과 예시가 절대 같은 칸에 저장되지 않는다 ═══ */
console.log('\n1) 저장 키 분리');
ok('예시 키는 cash_receipt_sample_<채널>',
  CH.cashReceiptSampleSettingKey('coupang') === 'cash_receipt_sample_coupang');
ok('★★ 발행방법(guide) 키와 다르다 — 리뷰어 안내와 AI 기준이 한 칸을 공유하지 않는다',
  CH.cashReceiptSampleSettingKey('naver') !== CH.cashReceiptSettingKey('naver'));
ok('★ 채널 표는 하나 — 채널을 늘리면 발행방법·예시 슬롯이 함께 따라온다',
  CH.CASH_RECEIPT_SAMPLE_SETTING_KEYS.length === CH.CASH_RECEIPT_CHANNELS.length
  && CH.CASH_RECEIPT_SAMPLE_SETTING_KEYS.length === CH.CASH_RECEIPT_SETTING_KEYS.length
  && CH.CASH_RECEIPT_CHANNELS.every(c => CH.CASH_RECEIPT_SAMPLE_SETTING_KEYS.includes(CH.cashReceiptSampleSettingKey(c.key))));
ok('★ 리뷰 예시 키와도 겹치지 않는다(app_settings 한 네임스페이스를 공유한다)',
  CH.CASH_RECEIPT_SAMPLE_SETTING_KEYS
    .every(k => !require('../src/utils/reviewSampleChannels').REVIEW_SAMPLE_KEYS.includes(k)));

/* ═══ 2) 서비스 실행 (스텁 pool) ═══════════════════════════════ */
console.log('\n2) 서비스 실행');
(async () => {
  let _q = [];
  const stub = (rows) => RI.__setPoolForTest({
    query: async (sql, params) => { _q.push({ sql: String(sql), params }); return { rows: rows || [] }; },
  });

  /* 관리자 화면용 목록 — 등록된 값이 그대로 실려 나온다(“기존 등록분 반영”) */
  _q = []; stub([{ key: 'cash_receipt_sample_naver', value: 'https://x/api/drive/image/AAAAAAAAAAAAAAAAAAAAA' }]);
  let list = await RI.receiptSampleSettings();
  ok('현금영수증 예시 목록 = 채널 수만큼, 등록분은 imageUrl 이 채워진다',
    list.length === CH.CASH_RECEIPT_CHANNELS.length
    && list.find(s => s.key === 'naver').imageUrl.includes('/api/drive/image/'));
  ok('★ 미등록 슬롯은 빈 문자열(“없음”과 “못 불러옴”이 구분된다)',
    list.find(s => s.key === 'coupang').imageUrl === '');
  ok('★ 조회는 예시 키만 본다 — 발행방법 값을 예시로 잘못 보여주지 않는다',
    _q[0].params[0].every(k => /^cash_receipt_sample_/.test(k)));

  _q = []; RI.__setPoolForTest({ query: async () => { throw new Error('boom'); } });
  list = await RI.receiptSampleSettings();
  ok('★ 조회 실패는 fail-soft — 화면이 통째로 죽지 않는다(빈 슬롯으로 뜬다)',
    list.length === CH.CASH_RECEIPT_CHANNELS.length && list.every(s => s.imageUrl === ''));

  /* 저장 — 화이트리스트 · https 절대 URL */
  _q = []; stub([]);
  await RI.saveReceiptSample({ channel: 'kakao', imageUrl: 'https://api.example.com/api/drive/image/BBBBBBBBBBBBBBBBBBBBB' });
  // ★ 누적 도입으로 저장 전 현재 목록 SELECT 1회가 추가됐다 — 검사 의미는 불변:
  //   모든 쿼리가 app_settings 만 만지고(운영 테이블 무접촉), 쓰기는 업서트 1회뿐.
  ok('저장은 app_settings 읽기+업서트뿐 — 운영 테이블 무접촉',
    _q.every(q => /app_settings/.test(q.sql))
    && _q.filter(q => /INSERT INTO app_settings/.test(q.sql)).length === 1
    && _q.find(q => /INSERT INTO app_settings/.test(q.sql)).params[0] === 'cash_receipt_sample_kakao');

  let threw = null;
  try { await RI.saveReceiptSample({ channel: 'evil', imageUrl: 'https://x/y' }); } catch (e) { threw = e; }
  ok('★ 채널 화이트리스트 — 목록 밖 키는 거부(임의 app_settings 키 생성 차단)', !!threw);

  threw = null;
  try { await RI.saveReceiptSample({ channel: 'coupang', imageUrl: 'javascript:alert(1)' }); } catch (e) { threw = e; }
  ok('★ https 절대 URL만 — 관리자 화면에 <img src>로 나가므로 자유 문자열 금지', !!threw);

  _q = []; stub([]);
  const cleared = await RI.saveReceiptSample({ channel: 'coupang', imageUrl: '' });
  // 누적 도입 후 반환은 URL 목록(배열) — 빈 값 저장 = 빈 목록 + 업서트 값 ''(검사 의미 불변).
  const _clrUp = _q.find(q => /INSERT INTO app_settings/.test(q.sql));
  ok('빈 값 저장 = 제거(해제 경로가 따로 없다)',
    Array.isArray(cleared) && cleared.length === 0 && _clrUp && _clrUp.params[1] === '');

  /* 로드 — 채널 모르면 미동봉, 등록 전이면 빈 배열 */
  _q = []; stub([]);
  ok('★★ 채널을 모르면 빈 배열(예시 미동봉 — 토큰·지연 보호)',
    (await RI.loadReceiptSamplesFor(null)).length === 0
    && (await RI.loadReceiptSamplesFor('')).length === 0);
  ok('★★ 등록된 예시가 없으면 빈 배열 = 오늘과 동작 동일',
    (await RI.loadReceiptSamplesFor('coupang')).length === 0);
  ok('★ 그 채널 예시 한 칸만 조회한다(4장을 다 보내지 않는다)',
    _q.length && _q[_q.length - 1].params[0].length === 1
    && _q[_q.length - 1].params[0][0] === 'cash_receipt_sample_coupang');
  ok('★ 목록에 없는 채널은 조회조차 하지 않는다',
    (await RI.loadReceiptSamplesFor('gmarket')).length === 0);
  RI.__setPoolForTest(null);

  /* ═══ 3) 캐시 지문 — 리뷰 예시와 겹치지 않는다 ═══════════════ */
  console.log('\n3) 캐시 지문 분리');
  ok('★★ 현금영수증 예시 key 에 receipt_ 접두 — 리뷰 예시(coupang_pc…)와 지문이 갈린다',
    /key: 'receipt_' \+ hit\.key/.test(svc));
  ok('★ classify 캐시 지문은 슬롯 key 로 만들어진다(접두가 갈려야 하는 이유)',
    /sampleSig = samples\.length/.test(gem)
    && /samples\.map\(s => s\.key \|\| s\.label \|\| ''\)/.test(gem));

  /* ═══ 4) 예시 안내문 — 종류에 맞게 소개한다 ═══════════════════ */
  console.log('\n4) 프롬프트 안내문');
  ok('★★ 리뷰 예시만 있을 때의 문장은 그대로(기존 판정 보존)',
    /'아래는 정상 리뷰 화면의 예시입니다\. 이 생김새를 참고해 판별하세요\.'/.test(gem));
  ok('★★ 현금영수증 예시는 "정상 현금영수증 화면" 으로 소개 — 리뷰라고 소개하면 receipt 를 review 로 몬다',
    /'아래는 정상 현금영수증 화면의 예시입니다/.test(gem)
    && /_kinds\.has\('receipt'\) && _kinds\.size === 1/.test(gem));
  ok('★ kind 판정 기준 3줄은 불변 — 오래 검증된 판정을 건드리지 않는다',
    /- "receipt": 현금영수증\/결제 영수증\. 국세청, 현금영수증, 승인번호/.test(gem));

  /* ═══ 5) 소비처 배선 ═════════════════════════════════════════ */
  console.log('\n5) 소비처 배선');
  // 조립이 submissionSamples 한 곳으로 수렴 — 영수증 슬롯 분기는 서비스 안(검사 의미 불변)
  ok('★★ 영수증 슬롯 업로드에 현금영수증 예시가 동봉된다',
    /slot === 'review' \|\| slot === 'receipt'/.test(diag)
    && /submissionSamples\(\{ expectedChannel: _expectedChannel, slotKey: slot \}\)/.test(diag)
    && /slotKey === 'receipt'\s*\?\s*await loadReceiptSamplesFor\(expectedChannel\)/.test(svc));
  ok('★★ 슬롯 검수와 2차 검수가 같은 samples 를 쓴다(같은 이미지에 AI 콜 2번 금지)',
    (diag.match(/samples: _inspectSamples/g) || []).length >= 2);
  ok('★ 채널 판정은 기존 loadTabExpectations 재사용 — 채널 파생 규칙 사본 없음',
    /loadTabExpectations\(\{ sheetId, tabName \}\)/.test(diag));
  ok('★ 리뷰 예시와 현금영수증 예시가 같은 로더를 쓴다(캐시·URL 검증이 갈리지 않게)',
    /_loadSampleSlots\(slots\)/.test(svc)
    && (svc.match(/_loadSampleSlots\(/g) || []).length >= 3);

  /* ═══ 6) 라우트 (라우터 스택 실검사) ═════════════════════════ */
  console.log('\n6) 라우트');
  const tbRouter = require('../src/routes/trackB.routes');
  const layers = tbRouter.stack.filter(l => l.route && l.route.path === '/review-inspect/samples')
    .map(l => ({ m: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
  ok('GET(조회)·POST(저장) 한 창구 — 리뷰/현금영수증 예시가 같은 화면·권한을 쓴다',
    layers.some(l => l.m.includes('get')) && layers.some(l => l.m.includes('post')));
  ok('★★ 저장은 adminOrMaster — 전사 설정이라 AE 는 못 바꾼다',
    layers.filter(l => l.m.includes('post')).every(l => l.mw.includes('adminOrMasterMiddleware')));
  ok('★ 전부 authMiddleware 뒤 — 무인증 도달 불가',
    layers.every(l => l.mw.includes('authMiddleware')));
  const tb = readS('routes/trackB.routes.js');
  // 자동 분류 예시(routeSamples)가 같은 응답에 합류(검사 의미 불변 — 두 목록은 그대로)
  ok('GET 이 두 목록을 함께 반환(설정 화면이 한 번에 그린다)',
    /res\.json\(\{ ok: true, samples, receiptSamples, routeSamples \}\)/.test(tb));
  ok('★ kind 미지정은 기존대로 리뷰 예시 — 리뷰웹시스템[3버전] [🖼 판별 예시] 모달 동작 불변',
    /String\(b\.kind \|\| ''\) === 'receipt'/.test(tb));

  /* ═══ 7) 설정 화면 ═══════════════════════════════════════════ */
  console.log('\n7) 설정 화면');
  ok('설정 패널에 AI 예시 슬롯이 있다(현금영수증 · 리뷰 두 묶음)',
    /_aisamplesHtml/.test(set) && /asSmpReceipt/.test(set) && /asSmpReview/.test(set));
  ok('★★ 슬롯 목록의 사본이 프론트에 없다 — 서버 응답(receiptSamples/samples)을 그대로 그린다',
    /_smpRender\('asSmpReceipt', 'receipt', j\.receiptSamples \|\| \[\]\)/.test(set)
    && /_smpRender\('asSmpReview', 'review', j\.samples \|\| \[\]\)/.test(set)
    && !/cash_receipt_sample_/.test(set) && !/review_inspect_sample_/.test(set));
  ok('★ 경로 재기준 없이 양쪽 호스트에서 닿는 경로 하나(작업표 표준열과 같은 판단)',
    /SMP_EP = '\/api\/trackb\/review-inspect\/samples'/.test(set));
  ok('★ 업로드는 guide-image Drive+프록시 인프라 재사용(신규 저장소 0)',
    /_post\('guideImage'/.test(set) && /aisample_/.test(set));
  // 누적 도입으로 mode:'add' 가 붙었다 — 검사 의미 불변(receipt=channel 저장 창구).
  ok('★ 현금영수증은 channel, 리뷰는 슬롯 key 로 저장한다',
    /\{ kind: 'receipt', channel: key, imageUrl: uj\.url, mode: 'add' \}/.test(set));
  ok('★ 리뷰어에게 나가지 않는다는 사실을 화면이 명시(발행방법 이미지와 혼동 방지)',
    /리뷰어 화면에는 나가지 않습니다/.test(set));
  ok('패널 등록(PANELS/LOADERS) + 전역 노출',
    /aisamples: _aisamplesHtml/.test(set) && /aisamples: loadAiSamples/.test(set)
    && /window\.loadAiSamples = loadAiSamples/.test(set));

  /* ── 크게 보기(등록한 예시를 확인할 수 있어야 한다 — 40px 썸네일로는 불가능했다) ── */
  ok('★ 썸네일 클릭 = 크게 보기(인덱스만 전달 — 문자열 보간 금지)',
    /onclick="_smpZoom\(\\'' \+ escHtml\(kind\) \+ '\\','' \+ escHtml\(s\.key\) \+ '\\',' \+ i \+ '\)"/.test(set)
    || /_smpZoom\(\\'/.test(set));
  ok('★ 크게 보기 URL 출처 = 서버 응답(_smpLast) — 프론트가 URL 사본을 따로 들지 않는다',
    /_smpLast = j;/.test(set) && /function _smpSlotOf\(kind, key\)/.test(set)
    && /_smpUrls\(s\)/.test(set));
  ok('★ onclick 함수는 window 노출(빠지면 클릭이 조용히 ReferenceError)',
    /window\._smpZoom = _smpZoom/.test(set) && /window\._smpZoomStep = _smpZoomStep/.test(set)
    && /window\._smpZoomClose = _smpZoomClose/.test(set) && /window\._smpZoomDel = _smpZoomDel/.test(set));
  ok('★ 오버레이는 body 직속(패널은 스크롤 컨테이너라 화면 흐름에 섞인다)',
    /document\.body\.appendChild\(el\)/.test(set.slice(set.indexOf('function _smpZoomRender'))));
  ok('★ 키 리스너는 최상위 1회 등록 + 입력 중 미가로채기(겹쳐 쌓이면 여러 장 건너뛴다)',
    (set.match(/document\.addEventListener\('keydown'/g) || []).length === 1
    && /tag === 'input' \|\| tag === 'textarea'/.test(set)
    && /if \(!_smpZoomCtx\) return;/.test(set));
  ok('★ 끝에서 순환하지 않는다(어디까지 봤는지 잃지 않게)',
    /if \(n < 0 \|\| n >= c\.urls\.length\) return;/.test(set));
  ok('썸네일 크기 상향(54x70) + 라이트박스 CSS 리터럴 고정',
    /\.as-smpth img\{width:54px;height:70px/.test(set) && /\.as-zoom\{position:fixed;inset:0;z-index:10050/.test(set));
  ok('★ 두 화면 모두 같은 패널을 띄운다(관리자 대시보드 · 리뷰웹시스템[3버전])',
    /panels: \[[^\]]*'aisamples'[^\]]*\], autoload: false/.test(adm)
    && /isAdmin \? \[[^\]]*'aisamples'[^\]]*\]/.test(wdk));
  ok('★ 리뷰웹시스템[3버전]은 관리자에게만 — 저장이 adminOrMaster 라 AE 에겐 막다른 길이 된다',
    !/: \['nickname'[^\]]*'aisamples'/.test(wdk));
  ok('관리자 대시보드 설정 탭 진입 시 값을 불러온다(autoload:false 호스트)',
    /loadAiSamples\(\); \} catch\(_\)\{\}/.test(idx));

  console.log(`\n✅ aiSampleImages: ${n}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ 실패: ' + e.message); process.exit(1); });
