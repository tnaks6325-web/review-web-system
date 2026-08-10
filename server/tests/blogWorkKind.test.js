/**
 * blogWorkKind.test.js — 블로그체험단 지원 M1 회귀가드 (작업유형 축 `work_kind`)
 * 실행: node tests/blogWorkKind.test.js
 *
 * 이 변경의 위험은 다섯이다.
 *  ① **기존 동작 회귀** — 빈 값(=기존 데이터 전부)이 리뷰체험단으로 읽히지 않으면 운영 중인
 *     모든 작업의 진행 방식이 바뀐다. `''`·null·모르는 문자열이 전부 `'review'` 여야 한다.
 *  ② **INSERT 정합** — 컬럼을 중간에 끼워 넣으면 컬럼 수 ≡ 자리표시자 수 ≡ 파라미터 수가
 *     조용히 어긋나 접수·발행이 통째로 죽는다(088·090·097 에서 반복해 밟은 자리).
 *  ③ **조용한 해제** — 체험단 종류 UI 가 없는 화면이 저장할 때 값이 지워지면 안 된다
 *     (미전송=유지 / ''=해제 의 CASE 센티널 — 087 리뷰타입과 같은 규율).
 *  ④ **권한 상승** — 리뷰어앱 스코프 토큰(`via:'reviewer_campaign'`)이 진행 방식을 바꾸면 안 된다.
 *  ⑤ **판정 사본** — 서버/프론트/인트라넷이 각자 "블로그인가"를 판정하면 갈라진다.
 *
 * ★ 순수함수는 **실제로 실행**해 검증한다(문자열 존재만 보는 grep 은 스코프·실행경로를 못 본다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
/** ⚠ campaign.routes.js 는 **의도된 NUL**(복합키 구분자)을 포함한다 — 이스케이프 표기로 제거하고 본다. */
const SNUL = p => S(p).split(String.fromCharCode(0)).join('');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 블로그체험단 M1 — 작업유형 축(work_kind) 회귀가드\n');

const WK = require('../src/utils/workKind');

/* ── 1) 판정 순수함수 (실행) ─────────────────────────────────── */
console.log('1) normalizeWorkKind / resolveWorkKind — 실행 검증');

t('인트라넷 라벨 2종', WK.normalizeWorkKind('리뷰체험단') === 'review'
  && WK.normalizeWorkKind('블로그체험단') === 'blog');

t('코드값 그대로 통과', WK.normalizeWorkKind('review') === 'review'
  && WK.normalizeWorkKind('blog') === 'blog');

t('사람이 적은 표기도 블로그로', WK.normalizeWorkKind('블로그') === 'blog'
  && WK.normalizeWorkKind('네이버 블로그 체험단') === 'blog'
  && WK.normalizeWorkKind('BLOG') === 'blog');

t('★★ 빈 값·null·모르는 문자열 = 리뷰(기존 동작 100%)',
  WK.normalizeWorkKind('') === 'review'
  && WK.normalizeWorkKind(null) === 'review'
  && WK.normalizeWorkKind(undefined) === 'review'
  && WK.normalizeWorkKind('   ') === 'review'
  && WK.normalizeWorkKind('아무거나') === 'review');

t('isBlogKind 는 같은 판정의 지름길',
  WK.isBlogKind('블로그체험단') === true && WK.isBlogKind('') === false
  && WK.isBlogKind('포토') === false);

t('resolveWorkKind — 공고 > 탭 우선순위',
  WK.resolveWorkKind({ campaignKind: 'review', tabKind: 'blog' }) === 'review'
  && WK.resolveWorkKind({ campaignKind: '', tabKind: 'blog' }) === 'blog'
  && WK.resolveWorkKind({ tabKind: 'blog' }) === 'blog'
  && WK.resolveWorkKind({}) === 'review');

t('★★ workKindForStore 는 빈 값을 빈 값으로 둔다(미전송 ≠ 리뷰 지정 — blank-only 전파의 전제)',
  WK.workKindForStore('') === '' && WK.workKindForStore(null) === ''
  && WK.workKindForStore('블로그체험단') === 'blog'
  && WK.workKindForStore('리뷰체험단') === 'review');

t('★ 모르는 문자열은 저장 시 review 로 정규화(원장에 자유 문자열을 남기지 않는다)',
  WK.workKindForStore('무언가') === 'review');

/* ── 2) 마이그레이션 099 ─────────────────────────────────────── */
console.log('\n2) migration 099 — 컬럼 추가만·백필 0·CHECK 없음');

const mig = S('migrations/099_work_kind.sql');

t('세 테이블에 컬럼 추가', /ALTER TABLE work_orders\s+ADD COLUMN IF NOT EXISTS work_kind/.test(mig)
  && /ALTER TABLE tab_configs\s+ADD COLUMN IF NOT EXISTS work_kind/.test(mig)
  && /ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS work_kind/.test(mig));

t('★ TEXT 타입(082 의 FK 타입 사고 계열 회피 — enum·FK 미도입)',
  (mig.match(/work_kind TEXT DEFAULT ''/g) || []).length === 3);

t('★★ DB CHECK 제약 없음(판정을 코드+DB 에 이중화하면 어휘 확장 때 저장이 실패한다)',
  !/CHECK\s*\(/i.test(mig));

t('★★ 백필 없음(UPDATE 문 0 — 기존 행은 빈 값 = 리뷰 = 현행 동작)',
  !/^\s*UPDATE\s/im.test(mig));

/* ── 3) 부팅 프리플라이트 ───────────────────────────────────── */
console.log('\n3) REQUIRED_SCHEMA — 미적용 배포를 부팅에서 막는다');

const idx = S('index.js');
for (const [tbl] of [['work_orders'], ['tab_configs'], ['recruit_campaigns']]) {
  t(`${tbl}.work_kind 등록`,
    new RegExp(`\\['${tbl}',\\s*'work_kind'\\]`).test(idx));
}

/* ── 4) work_orders INSERT 정합 (계수) ──────────────────────── */
console.log('\n4) _insertWorkOrder — 컬럼 수 ≡ 자리표시자 수 ≡ 파라미터 수');

const ord = S('src/routes/order.routes.js');
const mIns = ord.match(/INSERT INTO work_orders\s*\(([^)]*)\)\s*VALUES \(([^)]*)\)/);
t('INSERT 문을 찾았다', !!mIns);

const insCols = mIns[1].split(',').map(x => x.trim()).filter(Boolean);
const insVals = mIns[2].split(',').map(x => x.trim()).filter(Boolean);
const insPh = new Set(insVals.filter(v => v.startsWith('$')));

t('work_kind 가 컬럼 목록에 있다', insCols.includes('work_kind'));
t('★★ 컬럼 수 = VALUES 항목 수', insCols.length === insVals.length);

const maxPh = Math.max(...[...insPh].map(p => Number(p.slice(1))));
const gaps = Array.from({ length: maxPh }, (_, i) => '$' + (i + 1)).filter(p => !insPh.has(p));
t('★★ 자리표시자에 빈 번호가 없다($1..$N 연속)', gaps.length === 0);
t('자리표시자 개수 = 최대 번호(중복 사용 없음)', insPh.size === maxPh);

t('★ 저장은 workKindForStore 를 거친다(원장 표기 통일)',
  /workKindForStore\(b\.work_kind\)/.test(ord));

t('판정 사본 없음 — order.routes 는 utils/workKind 를 import 한다',
  /require\('\.\.\/utils\/workKind'\)/.test(ord));

/* ── 5) 인트라넷 수신·목록 ─────────────────────────────────── */
console.log('\n5) intake 수신·수정·목록');

t('INTAKE_EDITABLE_FIELDS 에 work_kind', /'skip_weekends', 'holidays',[\s\S]{0,200}'work_kind',/.test(ord));

t('★ 수정 경로도 저장 정규화를 거친다',
  /f === 'work_kind'\) vals\.push\(workKindForStore\(b\[f\]\)\)/.test(ord));

t('★ /intake/list SELECT 에 work_kind(빠지면 인트라넷 보낸오더 카드에 안 실린다)',
  /SELECT id, title, status, created_by, recruit_count, start_date,[\s\S]{0,120}work_kind/.test(ord));

t('_ensureTables 안전망 ALTER', /ADD COLUMN IF NOT EXISTS work_kind\s+TEXT DEFAULT ''/.test(ord));

/* ── 6) 접수 → tab_configs 전파 (blank-only) ────────────────── */
console.log('\n6) accept 업서트 — 탭으로 blank-only 전파');

const mTab = ord.match(/INSERT INTO tab_configs\s*\(([\s\S]*?)\)\s*VALUES \(([^)]*)\)/);
t('tab_configs 업서트를 찾았다', !!mTab);
t('컬럼에 work_kind', /work_kind/.test(mTab[1]));

const tabCols = mTab[1].split(',').map(x => x.trim()).filter(Boolean);
const tabVals = mTab[2].split(',').map(x => x.trim()).filter(Boolean);
t('★★ 컬럼 수 = VALUES 항목 수(updated_at/NOW() 포함)', tabCols.length === tabVals.length);

t('★★ blank-only 갱신(관리자가 탭에서 고친 값을 2차 접수가 덮지 않는다)',
  /work_kind\s*=\s*COALESCE\(NULLIF\(tab_configs\.work_kind,''\),\s*EXCLUDED\.work_kind\)/.test(ord));

t('파라미터에 workKindForStore(o.work_kind)', /workKindForStore\(o\.work_kind\)/.test(ord));

/* ── 7) 공고(create/update) ─────────────────────────────────── */
console.log('\n7) 모집공고 — 발행 INSERT · 수정 CASE 센티널');

const camp = SNUL('src/routes/campaign.routes.js');

const mCIns = camp.match(/INSERT INTO recruit_campaigns[\s\S]*?VALUES \(([\s\S]*?)\)\s*RETURNING/);
t('공고 INSERT 를 찾았다', !!mCIns);
// ★ 닫는 괄호로 앵커하지 않는다 — 컬럼이 꼬리에 붙을 때마다 가드가 조용히 빨개진다(101 에서 실측).
t('★ create INSERT 컬럼에 work_kind', /transfer_bank, transfer_memo, review_type, carry_mode, work_kind[,)]/.test(camp));

const cPh = new Set((mCIns[1].match(/\$\d+/g) || []));
const cMax = Math.max(...[...cPh].map(p => Number(p.slice(1))));
const cGaps = Array.from({ length: cMax }, (_, i) => '$' + (i + 1)).filter(p => !cPh.has(p));
t('★★ 공고 INSERT 자리표시자 연속($1..$N)', cGaps.length === 0);

t('★★ update 는 CASE 센티널(null=유지 / ""=해제) — 리뷰타입과 같은 규율',
  /work_kind = CASE WHEN \$41::text IS NULL THEN work_kind ELSE \$41::text END/.test(camp));

t('★ update 값도 null 유지 분기', /\(work_kind === undefined \|\| work_kind === null\) \? null : workKindForStore\(work_kind\)/.test(camp));

t('create/update 구조분해에 work_kind', (camp.match(/^\s+work_kind,/gm) || []).length >= 2);

/* ── 8) 권한 경계 ───────────────────────────────────────────── */
console.log('\n8) 권한 — 스코프 토큰은 진행 방식을 못 바꾼다');

const scoped = camp.match(/async function _scopedCampaignEdit[\s\S]*?\n}/);
t('_scopedCampaignEdit 본문을 찾았다', !!scoped);
t('★★ 스코프 편집 화이트리스트에 work_kind 없음(리뷰타입과 같은 판단 — 진행 방식·검수 정책 보호)',
  !/work_kind/.test(scoped[0]));

const adminEdit = ord.match(/const ADMIN_EDIT_FIELDS = \[([\s\S]*?)\]/);
t('★ 관리자 수동 수정 화이트리스트에도 없음(유형 변경 = 준비 행 기준이 바뀌는 구조 변경)',
  !!adminEdit && !/work_kind/.test(adminEdit[1]));

/* ── 9) 프론트 — 표시·프리필 사본 일치 ─────────────────────── */
console.log('\n9) 프론트 — 라벨 사본 일치 · 블로그면 리뷰타입 미프리필');

const wod = F('js/work-order-detail.js');

t('체험단 종류 줄을 상세에 그린다', /_woKv\("체험단 종류", _woWorkKindLabel\(o\.work_kind\)\)/.test(wod));

t('★ 판정·라벨을 전역에 노출(사본 대신 이것을 쓰게)',
  /_woIsBlogKind: _woIsBlogKind/.test(wod) && /_woWorkKindLabel: _woWorkKindLabel/.test(wod));

// 서버 표 ≡ 프론트 최소 사본 (workManager 사본 규율)
const mLabels = wod.match(/const WO_KIND_LABELS = \{([^}]*)\}/);
t('프론트 라벨 표를 찾았다', !!mLabels);
for (const k of WK.WORK_KINDS) {
  t(`★★ 라벨 일치: ${k.key} = ${k.label}`,
    new RegExp(`${k.key}:\\s*'${k.label}'`).test(mLabels[1]));
}

t('★★ 블로그 오더는 리뷰타입을 프리필하지 않는다(별도 축 — 캡처 검수 개입 차단)',
  /review_type:\s*_woIsBlogKind\(o\.work_kind\) \? "" : \(o\.review_type \|\| ""\)/.test(wod));

t('발행 프리필에 work_kind 동봉', /work_kind:\s*String\(o\.work_kind \|\| ""\)\.trim\(\)/.test(wod));

/* ── 10) 소스 위생 ──────────────────────────────────────────── */
console.log('\n10) 소스 위생');

t('★ 리터럴 NUL 없음(git 이 바이너리로 취급하면 grep 가드가 그 파일에서 무력화된다)',
  !S('src/utils/workKind.js').includes(String.fromCharCode(0))
  && !mig.includes(String.fromCharCode(0)));

console.log(`\n✅ 블로그체험단 M1 회귀가드 통과 — ${pass}케이스\n`);
