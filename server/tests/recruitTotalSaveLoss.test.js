'use strict';
/**
 * 모집공고 수정: 총인원이 조용히 사라지던 세 갈래 회귀가드 (2026-08-21 신고).
 *
 * 신고: 총인원 비어있음 → 200 입력·저장 → 다시 열면 또 비어있음.
 * 실측(실 http 오리진 브라우저 + 실제 라우트 핸들러 실행)으로 갈라 본 원인:
 *   ㉮ 차수 원장(095)이 있으면 서버가 총모집 전송값을 **통째로 무시**한다
 *      (`roundsLockRecruitTotal` → COALESCE(null)). 그런데 그 사실을 저장한 **뒤** 잠깐 뜨는
 *      안내로만 알려 줘서, 화면은 계속 편집 가능한 채로 헛수고를 시켰다.
 *   ㉯ '옵션 없는 작업' 수정 모드에서 캠페인 정원은 **첫 줄 값**만 읽는다
 *      (`_syncPreviewFromOptRows`) — 둘째 줄 총인원에 친 값은 어디에도 닿지 않는다.
 *   ㉰ 상세 응답에 정원이 없으면(공개 화이트리스트 뷰·구버전 백엔드·로드 실패) 화면이
 *      **모르는 값을 0 으로 보내** 총량이 '무제한'으로 리셋된다.
 * 규율: 저장에 닿지 않는 입력칸은 잠그고 사유를 말한다 · 모르는 값은 보내지 않는다.
 */
const fs = require('fs');
const path = require('path');
const routes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
const fe = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('ok -', name); } catch (e) { fail++; console.error('NOT OK -', name, '\n   ', e.message); } };
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg || `패턴 없음: ${re}`); };

/* ── ㉮ 차수 잠금을 열 때부터 안다 ───────────────────────────── */
t('서버가 차수 잠금 상태를 상세 응답에 싣는다', () => {
  has(routes, /FROM campaign_rounds WHERE campaign_id = \$1`, \[id\]\)/, '차수 집계 조회가 없다');
  has(routes, /roundsLock = \{ locked: _n > 0, count: _n, total:/, 'locked/count/total 을 함께 주지 않는다');
  has(routes, /orderStartDate, roundsLock \}\);/, '응답에 roundsLock 이 없다');
});

t('★ 조회 실패·095 미적용은 null(모름) — "잠금 없음"으로 꾸미지 않는다', () => {
  has(routes, /let roundsLock = null;/, '기본값이 null 이어야 한다');
  has(routes, /catch \(_\) \{ \/\* 095 미적용·조회 실패 = 모름\(null\) \*\/ \}/, 'fail-soft 가 사라졌다');
  // 화면도 모름이면 잠겼다고 말하지 않는다.
  has(fe, /const locked = !!\(lock && lock\.locked\);/, '모름(null)을 잠금으로 접으면 없는 잠금을 지어낸다');
});

t('★ 잠긴 공고는 사유를 말한다 — 헛수고 금지', () => {
  has(fe, /🔒 이 공고의 총건수는 <u>차수 원장<\/u>이 관리합니다/, '잠금 문구가 없다');
  has(fe, /if \(lock && lock\.locked\) return "차수 원장이 총건수를 관리합니다/, '칸 툴팁이 사유를 말하지 않는다');
});

t('★★ 입력칸을 읽기 전용으로 잠그지 않는다 (2026-08-19 사용자 확정 — 되돌리기 금지)', () => {
  if (/readOnly\s*=\s*true/.test(fe)) {
    throw new Error('총인원·일건수는 수정 화면에서 고칠 수 있어야 한다(경고 전용) — 잠금은 그 확정을 되돌린다');
  }
});

/* ── ㉯ 첫 줄이 아닌 총인원은 저장에 닿지 않는다 ─────────────── */
t('★ 수정 모드의 캠페인 정원은 첫 행 값이다(그 규칙 자체는 유지)', () => {
  has(fe, /const head = live\[0\] \|\| rows\[0\] \|\| null;/, '첫 행 규칙이 사라졌다(합계 규칙이면 0 리셋이 재현된다)');
});

t('★ 그래서 둘째 줄부터의 총인원은 "저장되지 않는다"고 말한다', () => {
  has(fe, /if \(index > 0\) return "공고 총인원은 첫 줄 값입니다 — 이 칸에 적은 값은 저장되지 않습니다";/, '둘째 줄 안내가 없다');
  has(fe, /상품 줄이 여러 개예요 — <b>공고 총인원은 첫 줄 값<\/b>만 저장됩니다/, '줄이 여러 개일 때 안내 문구가 없다');
});

t('★ 옵션 있는 작업은 대상이 아니다 — 옵션인원은 옵션 원장 값이다', () => {
  has(fe, /function _recruitTotalCellHint\(index\) \{\s*\n\s*if \(!_rfQuotaNotice\(\)\) return "";/, '안내 판정이 수정 모드+옵션 없는 작업에 한정되지 않는다');
  has(fe, /function _rfQuotaNotice\(\) \{ return !!_recruitEditId && _prodMode\(\) !== "opt"; \}/,
    '_rfQuotaNotice 의 의미가 바뀌면 옵션 공고의 옵션인원까지 잠긴다');
});

/* ── ㉰ 모르는 정원은 보내지 않는다 ─────────────────────────── */
t('★ 로드값에 정원이 없으면 payload 에서 뺀다(미전송 = 서버 COALESCE 유지)', () => {
  has(fe, /const _quotaKnown = !_recruitEditId\s*\n\s*\|\| \(!window\._recruitEditLoadFailed && _loaded\s*\n\s*&& _loaded\.recruit_total !== undefined && _loaded\.daily_limit !== undefined\);/,
    '정원 수신 여부 판정이 없다 — 모르는 값을 0 으로 보내면 총량이 리셋된다');
  has(fe, /if \(!_quotaKnown\) \{ \/\* 미전송 = 서버 COALESCE 유지 \*\/ \} else \{/, '미전송 분기가 없다');
});

t('★ 조용히 빼지 않는다 — 저장 안내가 사실을 말한다', () => {
  has(fe, /if \(_quotaSkipped\) \{\s*\n\s*_changed\.unshift\("⚠ 총건수·일건수는 건드리지 않았습니다/, '미전송 사실을 화면이 말하지 않는다');
});

t('★ 신규 발행은 항상 보낸다(로드값이 없는 것이 정상)', () => {
  has(fe, /const _quotaKnown = !_recruitEditId/, '신규 발행에서 정원이 미전송되면 0 으로 만들어진다');
});

t('★ 선언이 사용보다 앞이다 — 참여형 블록 밖에서 읽는다(TDZ 방지)', () => {
  const d = fe.indexOf('let _quotaSkipped');
  const u1 = fe.indexOf('_quotaSkipped = !_quotaKnown');
  const u2 = fe.indexOf('if (_quotaSkipped)');
  if (!(d > 0 && d < u1 && d < u2)) throw new Error('_quotaSkipped 선언이 사용보다 뒤에 있다(ReferenceError)');
});

/* ── 서버 계약 무회귀 ──────────────────────────────────────── */
t('★ 서버의 차수 잠금 자체는 그대로다(총량은 차수 원장이 진실원본)', () => {
  has(routes, /if \(await roundsLockRecruitTotal\(id\)\) \{[\s\S]{0,200}_rtEff = null;/, '차수 잠금이 사라졌다');
  has(routes, /recruit_total = COALESCE\(\$24, recruit_total\)/, '미전송=유지 계약이 깨졌다');
});

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
