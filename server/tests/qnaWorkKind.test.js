/**
 * qnaWorkKind.test.js — Q&A체험단 1단계 회귀가드 (작업유형 축 `work_kind` 세 번째 값 `qna`)
 * 실행: node tests/qnaWorkKind.test.js
 *
 * 이 변경의 위험은 넷이다.
 *  ① **기존 데이터 재분류** — 운영에 저장된 값은 `''`·`review`·`blog` 뿐이다(2026-11-03 읽기 조회).
 *     이 셋과 사람이 적은 리뷰·블로그 표기의 판정이 한 글자도 바뀌면 안 된다.
 *  ② **조용한 강등** — 모르는 값을 review 로 접던 규칙 때문에 `qna` 가 어디선가 review 로 바뀌면
 *     Q&A 공고에 구매양식·리뷰 검수가 붙는다. 저장·프리필·발행 폼이 qna 를 그대로 지켜야 한다.
 *  ③ **검수 차단** — 결과물이 문의 화면 캡처라 AI 리뷰 형식 판정이 정상 제출을 잠그면 안 된다.
 *  ④ **판정 사본** — 서버 `isQnaKind` 와 프론트 `_woIsQnaKind` 가 같은 표기에 다른 답을 내면 갈라진다.
 *
 * ★ 순수함수는 실제로 실행해 검증한다(문자열 존재만 보는 grep 은 실행경로를 못 본다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ Q&A체험단 1단계 — 작업유형 축(work_kind=qna) 회귀가드\n');

const WK = require('../src/utils/workKind');

/* ── 1) 판정 단일 출처 ─────────────────────────────────────────── */
console.log('1) 판정 단일 출처');
t('표준 목록에 qna = Q&A체험단', WK.WORK_KINDS.some(k => k.key === 'qna' && k.label === 'Q&A체험단'));
t('★★ 운영 저장값 3종의 판정 불변', WK.normalizeWorkKind('') === 'review'
  && WK.normalizeWorkKind('review') === 'review' && WK.normalizeWorkKind('blog') === 'blog'
  && WK.workKindForStore('') === '' && WK.workKindForStore('review') === 'review' && WK.workKindForStore('blog') === 'blog');
t('★ 블로그를 먼저 본다(블로그 표기에 Q&A 가 섞여도 blog)', WK.normalizeWorkKind('네이버 블로그 Q&A') === 'blog');
for (const v of ['qna', 'Q&A체험단', 'q&a', 'Q/A등록작업', 'QnA', 'Q & A', '문의 등록', '큐앤에이']) {
  t(`Q&A 표기 → qna: ${v}`, WK.normalizeWorkKind(v) === 'qna' && WK.workKindForStore(v) === 'qna' && WK.isQnaKind(v));
}
for (const v of ['리뷰체험단', 'quality', 'aqua', 'Q A', 'QA', '포토', null, undefined]) {
  t(`Q&A 아님 → 종전 판정: ${v}`, !WK.isQnaKind(v) && WK.normalizeWorkKind(v) !== 'qna');
}
t('공고 > 탭 우선순위에 qna 도 그대로', WK.resolveWorkKind({ campaignKind: 'qna', tabKind: 'review' }) === 'qna'
  && WK.resolveWorkKind({ campaignKind: '', tabKind: 'qna' }) === 'qna'
  && WK.resolveWorkKind({ campaignKind: 'review', tabKind: 'qna' }) === 'review');
t('★ 공유필드 정규화(CANON)도 qna 를 지킨다', require('../src/utils/sharedFields').CANON.workKind('qna') === 'qna');

/* ── 2) 검수 격리 ──────────────────────────────────────────────── */
console.log('\n2) 검수 격리');
const inspect = require('../src/services/reviewInspect.service');
const otherShot = { kind: 'other', confidence: 0.95 };
t('★★ 1차 필터: qna 는 잠그지 않는다(skip qna_tab)', (() => {
  const v = inspect.precheckPolicy({ classified: otherShot, slotKey: 'review', workKind: 'qna' });
  return v.verdict === 'skip' && v.code === 'qna_tab' && v.blockable === false;
})());
t('블로그 안전핀은 그대로(blog_tab)', inspect.precheckPolicy({ classified: otherShot, workKind: 'blog' }).code === 'blog_tab');
t('미지정은 종전 경로(Q&A·블로그 skip 아님)', !['qna_tab', 'blog_tab'].includes(inspect.precheckPolicy({ classified: otherShot, workKind: null }).code));
const isrc = S('src/services/reviewInspect.service.js');
t('2차: 형식·상품명·본문겹침 skip 갈래에 qna 포함', /const _isBlogTab = exp\.workKind === 'blog' \|\| exp\.workKind === 'qna';/.test(isrc)
  && /reason: exp\.workKind === 'qna' \? 'qna_tab' : 'blog_tab'/.test(isrc));

/* ── 3) 프론트 사본 ≡ 서버 ─────────────────────────────────────── */
console.log('\n3) 프론트 사본 ≡ 서버');
const P = require('../src/utils/woCampaignPrefill.generated');
const samples = ['', 'review', 'blog', 'qna', 'Q&A체험단', 'Q/A등록작업', 'QnA', '문의 등록', '네이버 블로그 Q&A', 'quality', 'QA', '리뷰체험단'];
for (const v of samples) {
  t(`★★ 판정 일치: ${JSON.stringify(v)}`, P._woIsQnaKind(v) === WK.isQnaKind(v) && P._woIsBlogKind(v) === (v !== '' && WK.isBlogKind(v)));
}
t('★★ 프론트 사본의 Q&A 표기 규칙 = 서버 QNA_PATTERN 글자 그대로(표본에 없는 갈래까지 잠금)', (() => {
  const src = S('src/utils/workKind.js').match(/const QNA_PATTERN = (\/.*\/i);/);
  return !!src && P._woIsQnaKind.toString().includes(src[1] + '.test(v)')
    && F('js/work-order-detail.js').includes(src[1] + '.test(v)');
})());
t('★★ Q&A 오더는 리뷰타입을 프리필하지 않는다', (() => {
  const out = P._woCampaignPrefill({ work_kind: 'qna', review_type: '포토', review_type_mix: [{ type: 'photo', count: 3 }] });
  return out.review_type === '' && Array.isArray(out.review_type_mix) && out.review_type_mix.length === 0 && out.work_kind === 'qna';
})());
t('리뷰 오더는 종전대로 리뷰타입을 넘긴다', P._woCampaignPrefill({ work_kind: 'review', review_type: '포토' }).review_type === '포토');

const wodSrc = F('js/work-order-detail.js');
const wodCtx = {};
vm.createContext(wodCtx);
const grab = (src, name) => { const i = src.indexOf('function ' + name + '('); assert(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
vm.runInContext(wodSrc.match(/const WO_KIND_LABELS = \{[^}]*\};/)[0].replace('const ', 'var ')
  + grab(wodSrc, '_woIsBlogKind') + grab(wodSrc, '_woIsQnaKind') + grab(wodSrc, '_woWorkKindLabel'), wodCtx);
t('상세 라벨: qna → Q&A체험단 · 빈 값 → 줄 없음 · 블로그 불변', wodCtx._woWorkKindLabel('qna') === 'Q&A체험단'
  && wodCtx._woWorkKindLabel('') === '' && wodCtx._woWorkKindLabel('blog') === '블로그체험단' && wodCtx._woWorkKindLabel('review') === '리뷰체험단');

/* ── 4) 발행 폼이 qna 를 지운다 → 리뷰 공고로 저장되던 경로 ─────── */
console.log('\n4) 발행 폼 프리필');
const ir = F('js/index-recruit.js');
const irCtx = {};
vm.createContext(irCtx);
vm.runInContext(grab(ir, '_rfPrefillWorkKind'), irCtx);
t('★★ 프리필: qna·blog 는 그대로, 나머지는 리뷰(빈 값)', irCtx._rfPrefillWorkKind('qna') === 'qna'
  && irCtx._rfPrefillWorkKind('blog') === 'blog' && irCtx._rfPrefillWorkKind('review') === ''
  && irCtx._rfPrefillWorkKind('') === '' && irCtx._rfPrefillWorkKind(undefined) === '');
t('작업오더 프리필 자리가 그 함수를 탄다', /_wk\.value = _rfPrefillWorkKind\(prefill\.work_kind\)/.test(ir));
t('편집 로드는 저장된 값을 그대로 둔다(qna 보존)', /_wk\.value = \(c\.work_kind === "blog"\) \? "blog" : \(c\.work_kind \|\| ""\)/.test(ir));

/* ── 5) 구매가 없는 작업에 붙지 않아야 하는 것 ─────────────────── */
console.log('\n5) 구매 전제 기능 제외');
const cr = S('src/routes/campaign.routes.js').split(String.fromCharCode(0)).join('');
t('인당 구매수량 단계 복사 제외', /!\['blog', 'qna'\]\.includes\(workKindForStore\(work_kind\)\)/.test(cr));
const sh = S('src/services/campaignShortage.service.js');
t('미달 연장 팝업 제외(후보 SQL 1곳 + 잠금 재확인·공고>탭 판정 includes 2곳)', /NOT IN \('blog','qna'\)/.test(sh)
  && (sh.match(/NO_DAILY_CARRY_KINDS\.includes\(/g) || []).length === 2);

/* ── 6) 코드 검토가 짚은 막다른 길·새는 자리 ─────────────────── */
console.log('\n6) 막다른 길·새는 자리');
const dg = S('src/routes/diag.routes.js');
t('★★ 업로드 검수: qna 탭의 리뷰 칸은 형식 판정·자동 이동·불일치 알림을 만들지 않는다',
  /_isQnaUpload = require\('\.\.\/utils\/workKind'\)\.isQnaKind\(/.test(dg)
  && /if \(!\(_isQnaUpload && _slotRole === 'review'\)\) verdict = await verifyCapture\(\{/.test(dg)
  && /\} catch \(_\) \{ _isQnaUpload = false; \}/.test(dg));
t('작업보드 「＋ 블로거 추가」: qna 작업에는 안 보인다(서버가 거부하는 버튼)',
  /\['review', 'qna'\]\.includes\(String\(t\.workKind \|\| ''\)\)\) return false;/.test(F('workdesk.html')));
t('★ 발행 폼: qna 는 리뷰타입 카드를 숨기고 저장 때 비운다', /const noReviewType = isBlog \|\| _kind === "qna";/.test(ir)
  && /row\.style\.display = noReviewType \? "none" : ""/.test(ir)
  && /if \(payload\.work_kind === "blog" \|\| payload\.work_kind === "qna"\) \{\s*payload\.review_type = "";/.test(ir));
t('발행 폼 종류 탭: qna 를 리뷰로 켜지 않는다', /t\.dataset\.kind === \(_kind \|\| "review"\)/.test(ir));
t('광고주 포털 작업 종류: Q&A 체험단', /order\.work_kind === 'qna' \? 'Q&A 체험단' : '리뷰 체험단'/.test(S('src/services/advertiserProjection.service.js')));

console.log(`\n✅ ${pass}개 통과\n`);
