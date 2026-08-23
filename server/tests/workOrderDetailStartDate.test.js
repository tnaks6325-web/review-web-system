'use strict';
/**
 * 작업오더 상세 = 시작일 표시 회귀가드 (2026-08-21).
 *
 * 신고: "작업오더 접수일이 8월 19일인데 모집공고 편집에 들어가니 모집시작일이 8월 12일".
 * 원인 조사 결과 **화면 결함이 아니라 관측 결함**이었다 —
 *   · 발행 프리필(`_woCampaignPrefill`)은 `o.start_date` 를 **그대로** 복사한다(파생·보정 0).
 *   · 수정 모달은 공고에 저장된 `c.start_date` 를 그대로 보여준다.
 *   · 서버가 `recruit_campaigns.start_date` 를 쓰는 곳은 create/update 둘뿐이다.
 *   즉 두 값이 다르면 **작업오더의 시작일이 애초에 그 날짜**이거나 사람이 고친 것인데,
 *   그 시작일이 **상세 화면 어디에도 없어서** 대조가 불가능했다.
 * → 상세에 시작일 한 줄을 둔다(경고 아님 — 인트라넷은 시작일을 월/일로 직접 입력하고
 *   [이 오더로 다시 만들기]가 옛 값을 채우므로 접수일과 다른 것이 정상일 수 있다).
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/work-order-detail.js'), 'utf8');

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('ok -', name); } catch (e) { fail++; console.error('NOT OK -', name, '\n   ', e.message); } };
const has = (re, msg) => { if (!re.test(src)) throw new Error(msg || `패턴 없음: ${re}`); };

t('상세에 시작일 줄이 있다', () => {
  has(/_woKv\("시작일", String\(o\.start_date \|\| ""\)\.slice\(0, 10\)\)/,
    '작업오더 상세에 시작일 줄이 없다 — 공고 모집 시작일과 대조할 근거가 사라진다');
});

t('시작일은 일정 묶음(모집인원 바로 위)에 온다', () => {
  const detail = src.slice(src.indexOf('_woSection("상품·옵션"'), src.indexOf('_woKv("구매채널"'));
  const s = detail.indexOf('_woKv("시작일"');
  const r = detail.indexOf('_woKv("모집인원"');
  if (s < 0 || r < 0 || s > r) throw new Error('시작일이 모집인원보다 앞에 있어야 한다(일정 → 수량 순)');
});

t('빈 값은 줄 자체가 안 나온다 — 과거 오더 화면 불변', () => {
  has(/function _woKv\(label, val\) \{\s*\n\s*if \(val == null \|\| val === ""\) return "";/,
    '_woKv 의 빈 값 폐기가 사라지면 값 없는 과거 오더에 빈 줄이 생긴다');
});

t('발행 프리필은 여전히 작업오더 시작일을 그대로 복사한다(파생·보정 0)', () => {
  has(/start_date:\s*\(o\.start_date \|\| ""\)\.slice\(0, 10\),/,
    '프리필이 시작일을 파생·보정하기 시작하면 "공고 시작일이 왜 이 날짜인가"를 추적할 수 없다');
  // 오늘·구매일자 등으로 지어내지 않는다.
  const prefill = src.slice(src.indexOf('function _woCampaignPrefill'), src.indexOf('function _woCampaignPrefill') + 4000);
  if (/start_date:[^,]*Date\(\)/.test(prefill)) throw new Error('시작일을 오늘로 지어내면 안 된다');
});

t('시작일 표시는 경고가 아니다 — 접수일과 달라도 정상일 수 있다', () => {
  const detail = src.slice(src.indexOf('_woKv("시작일"') - 700, src.indexOf('_woKv("시작일"') + 200);
  if (/⚠|경고|불일치/.test(detail.replace(/경고 아님/g, ''))) {
    throw new Error('시작일 줄에 경고를 붙이면 정상 케이스(과거 시작일 오더)가 상시 경고가 된다');
  }
});


// ── 공고 수정 화면: 연결 작업오더 시작일 대조 안내 ──────────────────────────
const recruitSrc = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
const campSrc = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
const rhas = (re, msg) => { if (!re.test(recruitSrc)) throw new Error(msg || `패턴 없음: ${re}`); };

t('서버가 연결 작업오더의 시작일을 대조용으로 함께 내려준다', () => {
  if (!/linkedWorkOrderForCampaign\(rows\[0\], \['review_type_mix', 'inflow_type', 'start_date'\]\)/.test(campSrc))
    throw new Error('시작일을 같은 조회에 합류시키지 않았다 — 사본 조회가 생기면 근거가 갈린다');
  if (!/orderStartDate, roundsLock \}\);/.test(campSrc)) throw new Error('응답에 orderStartDate 가 없다');
  if (!/new Date\(wo\.start_date\)\.toISOString\(\)\.slice\(0, 10\)/.test(campSrc))
    throw new Error('화면과 같은 변환(ISO slice(0,10))을 써야 같은 날짜가 다르게 보이지 않는다');
});

t('저장값을 덮지 않는다 — 별도 필드로만 내려간다', () => {
  // 프리필은 여전히 공고 저장값을 그대로 쓴다.
  rhas(/setV\("rf_start_date", \(c\.start_date \|\| ""\)\.slice\(0, 10\)\);/,
    '시작일 프리필이 공고 저장값을 쓰지 않으면 작업오더 값이 조용히 굳는다');
  if (/setV\("rf_start_date",\s*(json\.)?orderStartDate/.test(recruitSrc))
    throw new Error('작업오더 시작일로 입력칸을 덮으면 안 된다(조용한 자동 적용 금지)');
});

t('값이 같으면 안내를 그리지 않고, 날짜를 고치면 스스로 사라진다', () => {
  rhas(/if \(!wo \|\| !cur \|\| wo === cur\) \{ if \(box\) box\.remove\(\); return; \}/,
    '같은 날짜에도 안내가 남으면 상시 소음이 된다');
  const dates = recruitSrc.slice(recruitSrc.indexOf('function onRecruitDatesChange'), recruitSrc.indexOf('function onRecruitDatesChange') + 900);
  if (!/_renderStartDateOriginNote\(\)/.test(dates))
    throw new Error('날짜 변경 시 안내를 다시 그리지 않으면 고쳐도 안내가 남는다');
});

t('모달을 새로 열면 대조값을 비운다 — 지난 공고 안내 누수 방지', () => {
  rhas(/window\._rfOrderStartDate = '';/, '초기화가 없으면 다른 공고의 시작일 안내가 남는다');
});

t('안내는 날짜 행 바깥에 둔다 — 행에 피커 onclick 이 걸려 있다', () => {
  rhas(/row\.parentNode\.insertBefore\(box, row\.nextSibling\)/,
    '행 안에 두면 안내를 누를 때마다 날짜 피커가 열린다');
});

t('경고가 아니다 — 빨강·⚠ 를 쓰지 않는다', () => {
  const fn = recruitSrc.slice(recruitSrc.indexOf('function _renderStartDateOriginNote'),
                              recruitSrc.indexOf('function _renderInflowOriginNote'));
  if (/⚠|#DC2626|#B91C1C|#EF4444|is-invalid/.test(fn))
    throw new Error('차수 재발행처럼 다른 것이 정상인 경우가 있어 경고로 칠하면 진짜 신호가 묻힌다');
});

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
