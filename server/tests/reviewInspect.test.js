/**
 * reviewInspect.test.js — 리뷰 자동검수(M0 1차 필터 + M1 2차 검수) 회귀가드.
 * 실행: node tests/reviewInspect.test.js
 *
 * 왜 이렇게 짜는가
 *  - 이 기능은 **리뷰어의 제출을 막을 수 있는** 유일한 검수다. 정책이 한 칸만 느슨해지면
 *    AI 오판으로 정당한 제출이 차단되고, 그건 "참여 소각"이라 불량 1건을 놓치는 것과
 *    비교가 안 되는 사고다 → 차단 조건·fail-open·우회로를 **순수함수 실행으로** 고정한다.
 *  - grep 가드는 "문자열이 있다"만 본다. 정책 분기는 실제로 호출해서 값을 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const RI = require('../src/services/reviewInspect.service');

/* ═══ ① 1차 필터 정책 — 차단은 한 갈래뿐 ═══════════════════════════ */
console.log('\n▶ 1차 필터 정책');

const cls = (o) => Object.assign({ kind: 'review', confidence: 0.95, channel: '' }, o);

ok('리뷰 화면이면 통과', RI.precheckPolicy({ classified: cls({ channel: 'coupang' }) }).verdict === 'pass');

ok('★ 리뷰 화면이 아니고 확신이 높으면 잠금 — 유일한 차단 조건',
  RI.precheckPolicy({ classified: cls({ kind: 'other', confidence: 0.95 }) }).verdict === 'block');

ok('★★ 확신이 낮으면 잠그지 않는다(모르면 통과)',
  RI.precheckPolicy({ classified: cls({ kind: 'other', confidence: 0.85 }) }).verdict === 'skip');

ok('★★ 채널 불일치는 경고까지만 — 절대 잠그지 않는다',
  (() => {
    const v = RI.precheckPolicy({ classified: cls({ channel: 'naver' }), expectedChannel: 'coupang' });
    return v.verdict === 'warn' && v.blockable === false;
  })());

ok('채널 정보를 모르는 탭은 대조 자체를 생략',
  RI.precheckPolicy({ classified: cls({ channel: 'naver' }), expectedChannel: null }).verdict === 'pass');

ok('★★ 카카오메이커스 작업은 잠금 제외(경고까지만) — 별점 없는 피드형이 공존한다',
  (() => {
    const v = RI.precheckPolicy({ classified: cls({ kind: 'other', confidence: 0.99 }), expectedChannel: 'kakao' });
    return v.verdict === 'warn' && v.blockable === false && v.code === 'not_review_exempt';
  })());

ok('★★ 판정 재료가 없으면 통과 — AI 장애가 제출을 막지 않는다(fail-open)',
  RI.precheckPolicy({ classified: null }).verdict === 'skip'
  && RI.precheckPolicy({ classified: undefined }).verdict === 'skip');

ok('영수증을 리뷰 자리에 올린 건 기존 슬롯 검수 담당 — 여기서 중복 경고하지 않는다',
  RI.precheckPolicy({ classified: cls({ kind: 'receipt', confidence: 0.99 }) }).verdict === 'skip');

ok('1차는 리뷰 슬롯만 — 영수증 슬롯은 대상 아님',
  RI.precheckPolicy({ classified: cls({ kind: 'other', confidence: 0.99 }), slotKey: 'receipt' }).verdict === 'skip');

ok('★ 잠금 제외 채널 목록에 kakao 가 기본 포함',
  RI.BLOCK_EXEMPT_CHANNELS.includes('kakao'));

/* ═══ ② 채널 판정 ═══════════════════════════════════════════════ */
console.log('\n▶ 채널 판정');
ok('버튼값·커스텀 문자열 모두 판정',
  RI.expectedChannelKey('쿠팡') === 'coupang'
  && RI.expectedChannelKey('네이버') === 'naver'
  && RI.expectedChannelKey('올리브영') === 'oliveyoung'
  && RI.expectedChannelKey('카카오메이커스') === 'kakao');
ok('★ 카카오는 "메이커스"를 요구 — 톡스토어·선물하기는 화면이 다르다',
  RI.expectedChannelKey('카카오톡스토어') === null && RI.expectedChannelKey('카카오선물하기') === null);
ok('모르는 채널·빈 값은 null(대조 생략)',
  RI.expectedChannelKey('11번가') === null && RI.expectedChannelKey('') === null
  && RI.expectedChannelKey(null) === null);

/* ═══ ③ 상품명 대조 ═════════════════════════════════════════════ */
console.log('\n▶ 상품명 대조');
ok('정확히 같으면 통과', RI.matchProductName('히말라야 핑크솔트 400g', ['히말라야 핑크솔트 400g']).verdict === 'pass');
ok('★ 부분 포함도 일치 — 쇼핑몰은 상품명을 줄여 쓴다',
  RI.matchProductName('히말라야 핑크솔트', ['히말라야 핑크솔트 400g 대용량']).verdict === 'pass');
ok('공백·괄호·특수문자 차이는 무시',
  RI.matchProductName('[NEW] 블랑카우 모이스처 리페어', ['블랑카우 모이스처리페어']).verdict === 'pass');
ok('다른 상품이면 경고(차단 아님)',
  RI.matchProductName('□□보조배터리 10000mAh', ['히말라야 핑크솔트']).verdict === 'warn');
ok('★★ 기대 상품명이 없으면 대조 안 함 — 판정 불가를 불량으로 취급하지 않는다',
  RI.matchProductName('아무 상품', []).verdict === 'skip'
  && RI.matchProductName('아무 상품', null).verdict === 'skip');
ok('OCR 이 비면 대조 안 함', RI.matchProductName('', ['히말라야 핑크솔트']).verdict === 'skip');

/* ═══ ④ 종합 상태 산출 ═══════════════════════════════════════════ */
console.log('\n▶ 종합 상태');
ok('하나라도 fail 이면 fail',
  RI.computeStatus({ a: { verdict: 'pass' }, b: { verdict: 'fail' }, c: { verdict: 'warn' } }) === 'fail');
ok('fail 없이 warn 이 있으면 suspect',
  RI.computeStatus({ a: { verdict: 'pass' }, b: { verdict: 'warn' } }) === 'suspect');
ok('전부 통과면 pass', RI.computeStatus({ a: { verdict: 'pass' }, b: { verdict: 'skip' } }) === 'pass');
ok('전부 판정 불가면 unverifiable',
  RI.computeStatus({ a: { verdict: 'skip' }, b: { verdict: 'skip' } }) === 'unverifiable');

/* ═══ ⑤ 파일 지문 ═══════════════════════════════════════════════ */
console.log('\n▶ 파일 지문');
ok('같은 내용은 같은 지문', RI.hashBase64('QUJD') === RI.hashBase64('QUJD'));
ok('다른 내용은 다른 지문', RI.hashBase64('QUJD') !== RI.hashBase64('WFla'));
ok('data: 접두가 붙어도 같은 지문(업로드 경로마다 형태가 다르다)',
  RI.hashBase64('data:image/png;base64,QUJD') === RI.hashBase64('QUJD'));
ok('빈 값은 null', RI.hashBase64('') === null && RI.hashBase64(null) === null);

/* ═══ ⑥ 중복·유사도 (스텁 pool 로 실제 실행) ════════════════════ */
console.log('\n▶ 중복·유사도');
let _sql = [];
RI.__setPoolForTest({ query: async (sql, params) => { _sql.push({ sql: String(sql), params }); return { rows: _sql._next || [] }; } });

(async () => {
  // 중복 — 다른 사람의 같은 파일
  _sql = []; _sql._next = [{ file_id: 'F9', sheet_id: 'S', tab_name: '△△탭', row_index: 8, reviewer_name: '박제출' }];
  let d = await RI.findDuplicate({ fileHash: 'h1', fileId: 'F1', sheetId: 'S', tabName: 'T', rowIndex: 12, reviewerName: '김리뷰' });
  ok('같은 지문이 다른 자리에 있으면 불량', d.verdict === 'fail' && d.matchReviewer === '박제출');

  ok('★★ 같은 (탭·행·리뷰어) 재업로드는 중복에서 제외 — 정상 재제출을 불량으로 만들지 않는다',
    /NOT \(sheet_id = \$3 AND tab_name = \$4/.test(_sql[0].sql) && /reviewer_name, ''\) = COALESCE\(\$6/.test(_sql[0].sql));

  _sql = []; _sql._next = [];
  d = await RI.findDuplicate({ fileHash: 'h1', fileId: 'F1', sheetId: 'S', tabName: 'T' });
  ok('겹치는 게 없으면 통과', d.verdict === 'pass');

  d = await RI.findDuplicate({ fileHash: null });
  ok('지문이 없으면 대조 안 함', d.verdict === 'skip');

  // 유사도
  const longText = '아침마다 얼굴에 베개 자국이 오래 남아서 고민하다가 구매했어요. 확실히 바르고 잔 다음 날 피부 탄력이 달라요.';
  _sql = []; _sql._next = [{ file_id: 'F8', reviewer_name: '정리뷰', row_index: 19, score: 0.93 }];
  let s = await RI.findSimilarText({ text: longText, fileId: 'F1', sheetId: 'S', tabName: 'T' });
  ok('임계값 이상이면 의심(경고) — 차단 아님', s.verdict === 'warn' && s.score === 0.93);

  _sql = []; _sql._next = [{ file_id: 'F8', reviewer_name: 'x', row_index: 1, score: 0.31 }];
  s = await RI.findSimilarText({ text: longText, fileId: 'F1', sheetId: 'S', tabName: 'T' });
  ok('임계값 미만이면 통과', s.verdict === 'pass');

  s = await RI.findSimilarText({ text: '맛있어요 재구매', fileId: 'F1', sheetId: 'S', tabName: 'T' });
  ok('★★ 짧은 글은 비교하지 않는다 — 관용구는 누구나 비슷해 오탐이 된다',
    s.verdict === 'skip' && s.reason === 'too_short');

  // fail-soft: 쿼리가 터져도 통과
  RI.__setPoolForTest({ query: async () => { throw new Error('boom'); } });
  ok('★★ 대조 쿼리 실패는 통과 처리(fail-soft)',
    (await RI.findDuplicate({ fileHash: 'h' })).verdict === 'skip'
    && (await RI.findSimilarText({ text: longText })).verdict === 'skip');

  ok('★★ 검수 전체가 터져도 throw 하지 않는다 — 업로드 후처리라 예외가 오르면 제출이 실패로 보인다',
    (await RI.inspectSubmission({ fileId: 'F', sheetId: 'S', tabName: 'T' })) === null
    || true);
  RI.__setPoolForTest(null);

  /* ═══ ⑦ 배선 — 서버 ═══════════════════════════════════════════ */
  console.log('\n▶ 서버 배선');
  const diag = readS('routes/diag.routes.js');
  ok('1차 필터 엔드포인트가 리미터 뒤에 등록',
    /router\.post\('\/review-precheck', imageApiLimiter/.test(diag));
  ok('★ 1차 필터는 Drive·DB 쓰기 0 — 순수 판정만',
    !/review-precheck[\s\S]{0,2200}uploadFileBase64/.test(diag)
    && !/review-precheck[\s\S]{0,2200}INSERT INTO/.test(diag));
  ok('★★ 판정 실패도 200 통과 응답 — 1차 필터 장애가 첨부를 막지 않는다',
    /\[review-precheck\][\s\S]{0,220}verdict: 'skip'/.test(diag));
  ok('업로드 시 파일 지문을 원장에 함께 기록(나중 UPDATE 로 미루지 않는다)',
    /file_hash\)/.test(diag) && /hashBase64\(_b64\)/.test(diag));
  ok('업로드 후 2차 검수 호출', /_inspect\.inspectSubmission\(\{/.test(diag));

  const gem = readS('services/gemini.service.js');
  ok('★★ 기존 슬롯 검수 계약 불변 — kind/confidence/businessNo/amount 그대로 반환',
    /kind,\s*\n\s*confidence: Math\.max/.test(gem) && /businessNo: String\(p\.businessNo/.test(gem)
    && /amount: Math\.max\(0, parseInt/.test(gem));
  ok('★ kind 판정 기준 3줄이 그대로다(이 문구를 바꾸면 오래 검증된 판정이 달라진다)',
    /- "review": 쇼핑몰 리뷰 화면\. 별점\(★\), 리뷰 본문, 상품평 목록, "리뷰 작성 완료" 같은 UI가 보임\./.test(gem)
    && /- "other": 둘 다 아님\(상품 사진, 주문내역, 빈 화면 등\)\./.test(gem));
  // ★ 접두는 kind·필드가 늘 때마다 올라간다(2→3…). 버전 상향은 허용하되
  //   **접두 없는 옛 키로 되돌아가는 것**은 막는다(검사 의미 불변).
  ok('★ 캐시 접두를 올려 옛 캐시(새 필드 없음)가 히트하지 않게 했다',
    /_getCacheKey\('classify[2-9]\d*:'/.test(gem) && !/_getCacheKey\('classify:'/.test(gem));
  ok('채널·본문·상품명·근거 필드 추가', /channel: CH\.includes/.test(gem)
    && /reviewText: String/.test(gem) && /productName: String/.test(gem) && /signals: Array\.isArray/.test(gem));

  ok('마이그레이션 081 존재',
    fs.existsSync(path.join(__dirname, '..', 'migrations', '081_review_inspections.sql')));
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '081_review_inspections.sql'), 'utf8');
  ok('★ 비파괴 — 컬럼 추가·신규 테이블만(DROP·삭제 없음)',
    /ADD COLUMN IF NOT EXISTS file_hash/.test(mig)
    && /CREATE TABLE IF NOT EXISTS review_inspections/.test(mig)
    && !/DROP TABLE/i.test(mig) && !/DELETE FROM/i.test(mig));
  ok('파일 단위 업서트 유니크 + 유사도용 trgm 인덱스',
    /uq_review_inspect_file/.test(mig) && /gin_trgm_ops/.test(mig));

  /* ═══ ⑧ 배선 — 프론트 ═════════════════════════════════════════ */
  console.log('\n▶ 프론트 배선');
  const app = readF('js/search-app.js');
  ok('★ 첨부 경로 3곳 모두 1차 필터를 탄다(한 곳만 걸면 대부분 탭이 필터 밖에 남는다)',
    /_preCheckFiles\('slot:' \+ slotKey/.test(app)     // 캡처 슬롯 모드
    && /_preCheckFiles\('idx:' \+ idx/.test(app)       // 다건 모드
    && /_preCheckFiles\('single'/.test(app));          // 단일 행 모드
  ok('파일을 지워도 판정을 다시 한다(지운 뒤에도 옛 경고가 남지 않게)',
    /function removeFile\(i\) \{[\s\S]{0,220}_preCheckFiles\('single'/.test(app)
    && /function _csRemoveFile[\s\S]{0,260}_preCheckFiles\('slot:'/.test(app));
  ok('★★ 제출 게이트 2곳 — 잠긴 첨부가 남아 있으면 제출하지 않는다',
    (app.match(/if \(_preHasBlock\(\)\) \{/g) || []).length >= 2);
  ok('★★ 우회로가 살아 있다 — 2회 잠기면 "제가 올린 게 맞습니다"',
    /_PRE_BLOCK_LIMIT = 2/.test(app) && /제가 올린 게 맞습니다/.test(app)
    && /function _preOverride/.test(app) && /s\.blocked && !s\.overridden/.test(app));
  ok('★ 미리보기(관리자)에서는 1차 필터를 돌리지 않는다',
    /if \(_PREVIEW_MODE \|\| !Array\.isArray\(fileObjs\)/.test(app));
  ok('★ 네트워크 실패는 무판정 통과(null 반환)',
    /catch \(_\) \{ return null; \}\s*\/\/ 네트워크 실패/.test(app));
  ok('★ 안내문 클릭이 파일 선택창을 열지 않는다(우회 체크를 못 누르는 사고 방지)',
    /addEventListener\('click', \(e\) => e\.stopPropagation\(\)\)/.test(app));
  ok('제출 흐름 초기화 시 1차 필터 상태도 비운다',
    /Object\.keys\(_preState\)\.forEach\(k => delete _preState\[k\]\)/.test(app));

  /* ═══ ⑧-2 기대 상품명 공급 (조건 ② 가 실제로 도는지) ═══════════ */
  console.log('\n▶ 기대 상품명 공급');
  ok('작업오더 JSON 에서 상품명을 뽑는다',
    RI.productNamesFromWorkOrder({ product_options_json: JSON.stringify([{ name: '히말라야 핑크솔트 400g', options: [] }]) })
      .join('|') === '히말라야 핑크솔트 400g');
  ok('자유서술 텍스트도 줄 단위로 뽑는다(구분자 앞이 상품명)',
    RI.productNamesFromWorkOrder({ product_option: 'A상품 - 옵1 - 결제금액 28,900원\n블랑카우 바디로션 / 레드 / 12,000원' })
      .join('|') === 'A상품|블랑카우 바디로션');
  ok('가격 꼬리를 떼어낸다', RI.productNamesFromWorkOrder({ product_option: '힙스 31400원' }).join('|') === '힙스');
  ok('★ "옵션 없음"류 서술은 상품명이 아니다 — 넣으면 아무 리뷰나 통과한다',
    RI.productNamesFromWorkOrder({ product_options_json: JSON.stringify([{ name: '옵션 없음' }, { name: '단일' }, { name: '해당없음' }]) })
      .length === 0);
  ok('JSON·텍스트 양쪽에 같은 상품이 있으면 한 번만',
    RI.productNamesFromWorkOrder({
      product_options_json: JSON.stringify([{ name: '히말라야 핑크솔트' }]),
      product_option: '히말라야 핑크솔트 - 옵1',
    }).length === 1);
  ok('깨진 JSON 도 안전(텍스트 경로로 계속)',
    RI.productNamesFromWorkOrder({ product_options_json: '{{{', product_option: '힙스' }).join('|') === '힙스');
  ok('빈 오더는 빈 배열', RI.productNamesFromWorkOrder(null).length === 0
    && RI.productNamesFromWorkOrder({}).length === 0);

  /* ═══ ⑧-3 검수 탭 라우트 (라우터 스택 실검사) ══════════════════ */
  console.log('\n▶ 검수 탭 배선');
  const tbRouter = require('../src/routes/trackB.routes');
  const riLayers = tbRouter.stack.filter(l => l.route && /review-inspect/.test(l.route.path))
    .map(l => ({ p: l.route.path, m: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
  // ★ 개수가 아니라 **경로별로** 본다 — 라우트를 늘릴 때마다 숫자를 고치는 가드는
  //   결국 숫자만 맞춰 통과시키게 된다(무엇이 있어야 하는지를 고정해야 한다).
  const riHas = (p, m) => riLayers.some(l => l.p === p && l.m.includes(m));
  ok('검수 목록·확인·기대상품명·예시·스윕·CSV 라우트가 모두 등록돼 있다',
    riHas('/review-inspect/list', 'get') && riHas('/review-inspect/resolve', 'post')
    && riHas('/review-inspect/product-names', 'get') && riHas('/review-inspect/product-names', 'post')
    && riHas('/review-inspect/samples', 'get') && riHas('/review-inspect/samples', 'post')
    && riHas('/review-inspect/sweep', 'post') && riHas('/review-inspect/export.csv', 'get'));
  ok('★★ 전부 authMiddleware 뒤 — 무인증 도달 불가',
    riLayers.every(l => l.mw.includes('authMiddleware')));
  ok('★★ 조회 계열은 _reInternal(내부인) — 광고주는 도달 불가',
    riLayers.filter(l => !/samples|sweep/.test(l.p) || l.m.includes('get'))
      .every(l => l.mw.includes('_reInternal') || l.mw.includes('adminOrMasterMiddleware')));
  ok('★ 전사 설정(예시 등록)·스윕 실행은 adminOrMaster — AE 는 못 바꾼다',
    riLayers.filter(l => (l.p === '/review-inspect/samples' && l.m.includes('post')) || l.p === '/review-inspect/sweep')
      .every(l => l.mw.includes('adminOrMasterMiddleware')));
  const tb = readS('routes/trackB.routes.js');
  ok('★ staff 는 담당 탭만 — 스코프 판정 실패는 거절(fail-closed)',
    /_riCanTouch/.test(tb) && /canAccessTab/.test(tb)
    && /return \{ ok: false, code: 503, error: '담당 범위를 확인하지 못했습니다\./.test(tb));
  ok('★ 탭 미지정 staff 는 담당 탭 목록으로 거른다(넓게 보여주지 않는다)',
    /scopedActiveTabs\(\{ role: 'staff'/.test(tb) && /allow\.has\(JSON\.stringify\(\[it\.sheet_id, it\.tab_name\]\)\)/.test(tb));

  const wdk = readF('workdesk.html');
  ok('리뷰웹시스템[3버전]에 리뷰검수 탭 + 뱃지',
    /data-v="inspect"/.test(wdk) && /id="riNavBadge"/.test(wdk)
    && /v==='inspect'\) renderInspectView\(\)/.test(wdk));
  ok('★ 기본 필터가 의심+불량 — 통과 건까지 나열하면 볼 것이 묻힌다',
    /STATE\.riStatus \|\| 'open'/.test(wdk));
  ok('판정 근거를 카드에 문장으로 적는다(열어보지 않고 판단되게)',
    /function _riReasons/.test(wdk) && /같은 파일이 이미 제출됨/.test(wdk) && /본문 \$\{Math\.round/.test(wdk));
  ok('중복 건은 나란히 보기', /risbs/.test(wdk) && /dup\.matchFileId/.test(wdk));
  ok('★ 기대 상품명이 없으면 그 사실을 화면에서 알려준다(조건이 죽어 있는 걸 모르면 안 된다)',
    /비교할 기대 상품명이 없습니다/.test(wdk));
  ok('부팅 시 손볼 건수 뱃지', /_riBootBadge\(\)/.test(wdk));

  /* ═══ ⑧-4 예시이미지 · 배치 스윕 · M4 확장 ══════════════════════ */
  console.log('\n▶ 예시이미지(few-shot)');
  const SAMP = require('../src/utils/reviewSampleChannels');
  ok('9개 화면 유형 슬롯(채널 4종 + 카카오 피드형)',
    SAMP.REVIEW_SAMPLES.length === 9
    && SAMP.REVIEW_SAMPLES.map(s => s.key).includes('kakao_feed'));
  ok('채널별로 골라 온다(9장을 다 보내지 않는다 — 토큰·지연 보호)',
    SAMP.samplesForChannel('coupang').length === 2
    && SAMP.samplesForChannel('kakao').length === 3
    && SAMP.samplesForChannel(null).length === 0);
  ok('app_settings 키 규칙 + 화이트리스트',
    SAMP.sampleSettingKey('kakao_feed') === 'review_inspect_sample_kakao_feed'
    && SAMP.isReviewSampleKey('oy_pc') === true && SAMP.isReviewSampleKey('evil') === false);
  ok('★★ 캐시 키에 예시 지문이 섞인다 — 안 그러면 예시를 등록·교체해도 옛 판정이 히트한다',
    /_getCacheKey\('classify[2-9]\d*:' \+ sampleSig \+ ':' \+ base64Data\)/.test(gem)
    && /sampleSig = samples\.length/.test(gem));
  ok('★★ 두 호출부가 같은 samples 를 넘긴다 — 다르면 같은 이미지에 AI 콜이 두 번',
    /samples: _inspectSamples,/.test(diag)
    && (diag.match(/samples: _inspectSamples/g) || []).length >= 2
    && /classifySubmissionImage\(base64, mimeType, \{ samples \}\)/.test(readS('services/captureVerify.service.js')));
  // ★ 창(window)은 "루프 앞에서 준비한다"를 고정하기 위한 것 — 주석이 늘면 함께 넓힌다
  //   (검사 의미는 불변: 준비 블록과 파일 루프 사이에 다른 준비가 끼어들지 않는다).
  // ★ 창을 3500자로 넓혔다 — 자동 분류(파일 라우팅) 판정 재료 준비가 샘플 준비와 루프 사이에
  //   들어왔다(검사 의미 불변: 샘플 준비는 여전히 루프 앞 1회).
  ok('예시는 파일 루프 밖에서 1회 준비(파일 수만큼 Drive 호출이 늘지 않게)',
    /let _inspectSamples = \[\];[\s\S]{0,3500}for \(let i = 0; i < files\.length/.test(diag));
  // 조립은 submissionSamples 한 곳으로 수렴 — 슬롯 분기는 서비스 안에 있다(검사 의미 불변)
  ok('★ 슬롯에 맞는 예시를 고른다 — 영수증 슬롯엔 현금영수증 예시(리뷰 예시를 주면 판정이 흔들린다)',
    /submissionSamples\(\{ expectedChannel: _expectedChannel, slotKey: slot \}\)/.test(diag)
    && /slotKey === 'receipt'\s*\?\s*await loadReceiptSamplesFor\(expectedChannel\)/.test(readS('services/reviewInspect.service.js')));
  ok('★ 등록된 예시가 없으면 빈 배열 = 오늘과 동작 동일',
    /if \(!SAMPLES_ENABLED \|\| !expectedChannel\) return \[\];/.test(readS('services/reviewInspect.service.js')));

  console.log('\n▶ 배치 스윕(M2)');
  const svcSrc = readS('services/reviewInspect.service.js');
  ok('스윕이 ① pending 재시도 ② 검수 이력 없는 과거분을 함께 본다',
    /i\.status = 'pending' AND COALESCE\(i\.attempts, 0\) < \$2/.test(svcSrc)
    && /LEFT JOIN review_inspections i ON i\.file_id = s\.file_id[\s\S]{0,80}i\.file_id IS NULL/.test(svcSrc));
  ok('★ 재시도 상한 초과는 unverifiable 로 종결(무한 재시도 금지)',
    /_giveUpStale/.test(svcSrc) && /status = 'unverifiable'/.test(svcSrc));
  ok('★ 사이클 캡 — 한 번에 몰아치지 않는다', /Math\.min\(Number\(limit\) \|\| SWEEP_BATCH, 100\)/.test(svcSrc));
  ok('★ 과거분은 지문이 없다 → 이번에 계산해 채운다(이후 중복 대조의 재료)',
    /if \(!t\.file_hash\) await saveFileHash/.test(svcSrc));
  ok('★★ 스윕은 throw 하지 않는다(cron 이 죽으면 안 된다)',
    /async function runInspectSweep[\s\S]{0,2600}catch \(e\) \{\s*\n\s*logger\.warn\(`\[reviewInspect\] 스윕 실패/.test(svcSrc));
  const cronSrc = readS('jobs/cron.js');
  ok('cron 등록 + 멀티 인스턴스 직렬화(jobLock)',
    /review_inspect_sweep/.test(cronSrc) && /withJobLock\('review_inspect_sweep'/.test(cronSrc));
  ok('킬스위치 REVIEW_INSPECT_SWEEP', /REVIEW_INSPECT_SWEEP !== '0'/.test(cronSrc));

  console.log('\n▶ M4 확장');
  ok('전역 유사도 스위치 — 기본은 같은 탭 안에서만',
    /REVIEW_INSPECT_SIM_SCOPE \|\| 'tab'/.test(svcSrc)
    && /\(\$7::boolean OR \(sheet_id = \$2 AND tab_name = \$3\)\)/.test(svcSrc));
  ok('★ 작성자 표기 재사용은 경고 전용 — 실명 대조가 아니다',
    /async function findAuthorReuse/.test(svcSrc)
    && /verdict: 'warn', ocr: a/.test(svcSrc)
    && !/findAuthorReuse[\s\S]{0,900}verdict: 'fail'/.test(svcSrc));
  ok('★ 같은 리뷰어 자신의 제출은 재사용으로 세지 않는다',
    /COALESCE\(reviewer_name,''\) <> COALESCE\(\$3,''\)/.test(svcSrc));
  ok('CSV 내보내기(UTF-8 BOM · 판정사유 문장화)',
    /function inspectionsCsv/.test(svcSrc) && /'\\ufeff'|﻿/.test(svcSrc)
    && /review-inspect\/export\.csv/.test(tb));
  ok('★ 예시이미지 저장은 adminOrMaster(전사 설정이라 AE 가 못 바꾼다)',
    /router\.post\('\/review-inspect\/samples', authMiddleware, adminOrMasterMiddleware/.test(tb)
    && /router\.get\('\/review-inspect\/samples', authMiddleware, _reInternal/.test(tb));
  ok('스윕 수동 실행도 adminOrMaster + 같은 락',
    /router\.post\('\/review-inspect\/sweep', authMiddleware, adminOrMasterMiddleware/.test(tb)
    && /withJobLock\('review_inspect_sweep'/.test(tb));
  ok('프론트 — 예시 등록·과거분 검수·CSV 버튼',
    /riOpenSamples\(\)/.test(wdk) && /riRunSweep\(\)/.test(wdk) && /riExportCsv\(\)/.test(wdk)
    && /riUploadSample/.test(wdk));
  ok('★ 관리자 전용 버튼은 isAdmin 일 때만 렌더(AE 에겐 안 보인다)',
    /\$\{isAdmin\?`<button class="btn" onclick="riOpenSamples\(\)"/.test(wdk));

  /* ═══ ⑨ 진짜 PG 검증 (PGTEST_URL 있을 때만) ══════════════════════
     ★★ 스텁 pool 은 SQL 을 해석하지 않는다 — 유사도 판정식은 **실제로 돌려봐야** 안다.
        개발 중 실측으로 잡은 것: `similarity` 단독은 가장 흔한 복붙 수법
        (원문 + 문장 한두 개 추가)을 0.859 / 0.718 로 놓친다. word_similarity 를 합쳐야
        잡히고, 대신 짧은 문구가 긴 글에 포함될 때 오탐이 나므로 길이비 가드가 필요하다.
        이 조합이 깨지면 기능이 **조용히 무력화**되므로 진짜 PG 로 고정한다.
        (레포 선례: jsonbCellsIndex.test.js — cells->>$n::int 무음 실패) */
  if (process.env.PGTEST_URL) {
    const { Pool } = require('pg');
    const pg = new Pool({ connectionString: process.env.PGTEST_URL });
    const BASE = '아침마다 얼굴에 베개 자국이 오래 남아서 고민하다가 구매했어요 확실히 바르고 잔 다음 날 피부 탄력이 달라요';
    const GENERIC = '배송도 빠르고 상품 상태도 아주 좋았어요 재구매 의사 있습니다';
    try {
      console.log('\n▶ 진짜 PG 검증 (PGTEST_URL)');
      await pg.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await pg.query(`CREATE TABLE IF NOT EXISTS review_inspections (
        file_id TEXT PRIMARY KEY, sheet_id TEXT, tab_name TEXT, row_index INT,
        reviewer_name TEXT, status TEXT, ocr_text TEXT)`);
      await pg.query(`DELETE FROM review_inspections WHERE sheet_id = '__t__'`);
      await pg.query(`INSERT INTO review_inspections (file_id,sheet_id,tab_name,reviewer_name,status,ocr_text)
                      VALUES ('__a__','__t__','T','정리뷰','pass',$1)`, [BASE]);
      await pg.query(`INSERT INTO review_inspections (file_id,sheet_id,tab_name,reviewer_name,status,ocr_text)
                      VALUES ('__b__','__t__','T','한장문','pass',$1)`,
        ['아침마다 얼굴에 베개 자국이 오래 남아서 고민하다가 구매했는데 ' + GENERIC + ' 피부 탄력이 확실히 달라졌고 향도 은은해서 마음에 쏙 들어요']);
      RI.__setPoolForTest(pg);
      const run = (t) => RI.findSimilarText({ text: t, fileId: '__x__', sheetId: '__t__', tabName: 'T' });

      ok('[PG] 완전 동일 → 의심', (await run(BASE)).verdict === 'warn');
      ok('★★ [PG] 복붙 + 한 문장 추가를 잡는다 (similarity 단독이면 0.859 로 놓친다)',
        (await run(BASE + ' 재구매 의사 있어요')).verdict === 'warn');
      ok('★★ [PG] 복붙 + 두 문장 추가도 잡는다 (similarity 단독이면 0.718)',
        (await run(BASE + ' 재구매 의사 있어요 배송도 빨라서 좋았습니다')).verdict === 'warn');
      ok('★★ [PG] 흔한 문구가 긴 글에 포함된 것은 잡지 않는다(길이비 가드) — 오탐 방지',
        (await run(GENERIC)).verdict === 'pass');
      ok('[PG] 전혀 다른 글은 통과',
        (await run('배송이 빠르고 포장이 꼼꼼했으며 가격도 합리적이라 아주 만족합니다 다음에도 이용할게요')).verdict === 'pass');

      await pg.query(`DELETE FROM review_inspections WHERE sheet_id = '__t__'`);

      /* ★★ 작업오더 링크 우선순위 — 실측으로 잡은 버그.
         두 조건을 OR 로만 묶으면 Track B 링크가 있어도 created_at 이 더 최근인
         `work_orders.linked_tab_*` 폴백 오더가 이긴다(= 엉뚱한 상품명으로 대조). */
      await pg.query(`CREATE TABLE IF NOT EXISTS work_orders (id TEXT PRIMARY KEY, title TEXT,
        product_option TEXT DEFAULT '', product_options_json TEXT DEFAULT '',
        linked_tab_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '',
        deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
      await pg.query(`CREATE TABLE IF NOT EXISTS trackb_work_order_links (id BIGSERIAL PRIMARY KEY,
        sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL, work_order_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ)`);
      await pg.query(`CREATE TABLE IF NOT EXISTS tab_configs (sheet_id TEXT, tab_name TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (sheet_id, tab_name))`);
      await pg.query(`ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS inspect_product_names TEXT DEFAULT ''`);
      await pg.query(`CREATE TABLE IF NOT EXISTS recruit_campaigns (id TEXT PRIMARY KEY, channel TEXT DEFAULT '',
        channel_custom TEXT DEFAULT '', linked_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW())`);
      await pg.query(`DELETE FROM work_orders WHERE id LIKE '__wo%'`);
      await pg.query(`DELETE FROM trackb_work_order_links WHERE sheet_id = '__t__'`);
      await pg.query(`DELETE FROM tab_configs WHERE sheet_id = '__t__'`);
      await pg.query(`INSERT INTO tab_configs (sheet_id, tab_name) VALUES ('__t__','TT')`);
      // 폴백 오더가 **더 나중에** 만들어진 상황(= 순서만으로는 이 오더가 이긴다)
      await pg.query(`INSERT INTO work_orders (id,title,product_option,linked_tab_sheet_id,linked_tab_name,created_at)
                      VALUES ('__wo_link__','링크','정답상품','','', NOW() - INTERVAL '1 day'),
                             ('__wo_fall__','폴백','폴백상품','__t__','TT', NOW())`);
      await pg.query(`INSERT INTO trackb_work_order_links (sheet_id,tab_name,work_order_id)
                      VALUES ('__t__','TT','__wo_link__')`);
      const e = await RI.loadTabExpectations({ sheetId: '__t__', tabName: 'TT' });
      ok('★★ [PG] Track B 링크가 work_orders.linked_tab_* 폴백을 이긴다(OR 만으로는 최신 오더가 이긴다)',
        e.productNames.join('|') === '정답상품');

      await pg.query(`DELETE FROM work_orders WHERE id LIKE '__wo%'`);
      await pg.query(`DELETE FROM trackb_work_order_links WHERE sheet_id = '__t__'`);
      await pg.query(`DELETE FROM tab_configs WHERE sheet_id = '__t__'`);

      /* ★ 작성자 표기 재사용 — 본인 재제출을 재사용으로 잡으면 정상 제출이 무더기로 의심된다. */
      await pg.query(`INSERT INTO review_inspections (file_id,sheet_id,tab_name,reviewer_name,status,ocr_text,ocr_author)
                      VALUES ('__au__','__t__','TA','정리뷰','pass',$1,'김**')`, [BASE]);
      const au1 = await RI.findAuthorReuse({ authorMask: '김**', fileId: '__x__', sheetId: '__t__', tabName: 'TA', reviewerName: '박제출' });
      ok('★ [PG] 같은 작성자 표기가 다른 리뷰어 제출에 있으면 경고',
        au1.verdict === 'warn' && (au1.others || []).includes('정리뷰'));
      const au2 = await RI.findAuthorReuse({ authorMask: '김**', fileId: '__x__', sheetId: '__t__', tabName: 'TA', reviewerName: '정리뷰' });
      ok('★★ [PG] 같은 리뷰어 본인 제출은 재사용으로 세지 않는다',
        au2.verdict === 'pass');
      ok('[PG] 너무 짧은 표기는 신호가 못 된다(비교 안 함)',
        (await RI.findAuthorReuse({ authorMask: '*', fileId: '__x__', sheetId: '__t__', tabName: 'TA', reviewerName: 'x' })).verdict === 'skip');
      await pg.query(`DELETE FROM review_inspections WHERE sheet_id = '__t__'`);

      /* ★ 예시이미지 저장·화이트리스트 (app_settings 필요) */
      await pg.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      await RI.saveSample({ key: 'kakao_feed', imageUrl: 'https://x/api/drive/image/' + 'a'.repeat(30) });
      const ss = await RI.sampleSettings();
      ok('[PG] 예시 9슬롯 저장·조회', ss.length === 9 && !!ss.find(x => x.key === 'kakao_feed').imageUrl);
      let threw = false;
      try { await RI.saveSample({ key: 'evil', imageUrl: 'https://x' }); } catch (_) { threw = true; }
      ok('★ [PG] 목록 밖 예시 키는 거부(임의 app_settings 키 생성 차단)', threw);
      await pg.query(`DELETE FROM app_settings WHERE key LIKE 'review_inspect_sample_%'`);
    } finally {
      RI.__setPoolForTest(null);
      await pg.end();
    }
  } else {
    console.log('\n▶ 진짜 PG 검증 — PGTEST_URL 미설정으로 건너뜀');
    console.log('   ⚠ 유사도 판정식은 실제 PG 로만 검증된다: PGTEST_URL=postgres://... node tests/reviewInspect.test.js');
  }

  console.log(`\n✅ reviewInspect: ${n}개 통과`);
  // trackB.routes 를 require 하면 DB 풀·타이머 핸들이 열려 프로세스가 스스로 안 끝난다
  //   (레포 관용구 — reviewerDbTab.test.js 와 동일)
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
