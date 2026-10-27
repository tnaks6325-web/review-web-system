'use strict';
/* 결정 299 — 입금일 두 칸(제품비 업체 작업): 「업체입금일(제품비)」 + 「리뷰비 입금일(인애드)」 회귀가드. */
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const assert = require('assert');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
let pass = 0; const t = (name, ok, info) => { assert.ok(ok, name + (info ? ' — ' + info : '')); pass++; console.log('  ✓ ' + name); };

console.log('1) 서버 배선');
const blk = SVC.slice(SVC.indexOf('결정 299 — 제품비를 업체가 보내는 작업'), SVC.indexOf('let paymentCellCount = 0;'));
t('★★ 입금 방식 판정은 payoutModeFrom 계열 단일 출처(advertiserGoodsFrom · 공고 → 탭)', /p\.advertiserGoodsFrom\(c && c\.transferBank, meta\[0\]\.tabTransferBank\)/.test(blk));
t('★ 판정 실패(undefined)면 칸을 선언하지 않는다', /c !== undefined && p\.advertiserGoodsFrom/.test(blk));
t('★★ 값 = 우리 이체 회차(payment_batch_items) paid/pending 만 — 시트·입금 칸이 아니다', /FROM payment_batch_items[\s\S]{0,120}status IN \('paid','pending'\)/.test(blk) && !/UPDATE|INSERT/.test(blk));
t('★ 회차 조회 실패 = "확인불가"(빈칸 = 안 보냄으로 꾸미지 않는다)', /feeDep\.unavailable = true/.test(blk) && /return '확인불가'/.test(blk));
t('★★ 줄 번호 + 명의(phone8)로 짝짓는다', /bySeq\.get\(Number\(r\.seq\)\)[\s\S]{0,160}String\(x\.phone8\)\.trim\(\) === p8/.test(blk));
t('★ 마스킹 전에 짝짓는다(업체 응답의 phone8 은 가려진다)', SVC.indexOf('if (feeDep) syn.feeDeposit = _feeDepOf(syn);') < SVC.indexOf('if (maskPII) { syn.phone8 = _mask(syn.phone8)'));
t('응답 선언 = 내부·업체 공통(res 생성 직후 · 역할 분기 밖)', /if \(feeDep\) res\.feeDepositColumn = \{ key: '__feeDeposit', label: '리뷰비 입금일\(인애드\)', paidLabel: '업체입금일\(제품비\)'/.test(SVC));

// _feeDepOf 실제 실행
const fnSrc = blk.slice(blk.indexOf('const _feeDepOf'));
const run = (feeDep, r) => vm.runInNewContext(`(${'(feeDep)=>{' + fnSrc + ' return _feeDepOf;}'})(feeDep)(r)`, { feeDep, r, String, Number });
const fd = { unavailable: false, bySeq: new Map([[3, [{ status: 'paid', d: '10/27', phone8: '12345678' }]], [4, [{ status: 'pending', d: null, phone8: '' }]]]) };
t('입금된 줄 = 날짜', run(fd, { seq: 3, phone8: '12345678' }) === '10/27');
t('★ 명의가 다르면(빈 줄 재배정) 보이지 않는다', run(fd, { seq: 3, phone8: '99999999' }) === '');
t('보내는 중 = "이체 진행 중"', run(fd, { seq: 4, phone8: '1' }) === '이체 진행 중');
t('기록 없음 = 빈칸', run(fd, { seq: 5, phone8: '1' }) === '');
t('조회 실패 = 확인불가', run({ unavailable: true, bySeq: new Map() }, { seq: 3 }) === '확인불가');
t('일반 작업(칸 선언 없음) = 값 없음', run(null, { seq: 3 }) === undefined);

console.log('\n2) 화면');
const grab = (name) => { const i = HTML.indexOf(`function ${name}(`); assert.ok(i > 0, name); for (let k = HTML.indexOf('{', i), d = 0; ; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (!d) return HTML.slice(i, k + 1); } } };
const ctx = { STATE: { wd: null, role: 'admin' }, String };
vm.createContext(ctx);
vm.runInContext(`const _CASH_RECEIPT_COL='__cr';const _PURCHASE_QTY_COL='__purchaseQty';const _FEE_DEPOSIT_COL='__feeDeposit';${grab('_feeDepositPaidHeader')}${grab('_gridSheetCols')}${grab('_colLabel')}`, ctx);
const H = ['수취인', '결제금액', '리뷰', '입금일', '메모'];
ctx.STATE.wd = { feeDepositColumn: { key: '__feeDeposit', label: '리뷰비 입금일(인애드)', paidLabel: '업체입금일(제품비)', paidHeader: '입금일' }, headers: H };
const cols = vm.runInContext('_gridSheetCols(STATE.wd,STATE.wd.headers)', ctx).map(c => c.key);
t('★ 리뷰비 칸은 입금 칸 바로 뒤', cols.indexOf('__feeDeposit') === cols.indexOf('입금일') + 1, cols.join(','));
t('★ 입금 칸 이름표 = 업체입금일(제품비) · 새 칸 = 리뷰비 입금일(인애드)', vm.runInContext("_colLabel('입금일')", ctx) === '업체입금일(제품비)' && vm.runInContext("_colLabel('__feeDeposit')", ctx) === '리뷰비 입금일(인애드)');
t('★ 원본 칸 key 는 그대로(업체 입금 기록·필터가 쓰는 이름 불변)', cols.includes('입금일'));
ctx.STATE.wd = { headers: H };
const cols2 = vm.runInContext('_gridSheetCols(STATE.wd,STATE.wd.headers)', ctx).map(c => c.key);
t('일반 작업 = 종전 표(칸 없음 · 이름표 그대로)', !cols2.includes('__feeDeposit') && vm.runInContext("_colLabel('입금일')", ctx) === '입금일');
t('리뷰비 칸은 읽기 전용 셀(gstatuslock)로 그린다', /c\.kind==='feeDeposit'\)\{[\s\S]{0,700}gstatuslock/.test(HTML));
t('표시값 = 서버가 준 값 그대로', /if\(h===_FEE_DEPOSIT_COL\) return String\(\(r&&r\.feeDeposit\)\|\|''\);/.test(HTML));

console.log(`\n✅ ${pass} 케이스 통과`);
