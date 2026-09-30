/**
 * 모집공고 회수·혼합 부속 컬럼 저장 배선(migration 135 · 사용자 확정 2026-08-24).
 *
 * 배경: 135 가 `recruit_campaigns` 에 세 칸을 만들었지만 **쓰는 곳도 읽는 곳도 없었다** —
 *   발행 모달에 입력칸이 없고, 저장 payload 에도 안 실리고, INSERT/SET 목록에도 없었다.
 *   그래서 회수택배사·배송 조합이 공고 쪽에는 한 글자도 남지 않았다.
 *
 * 이 가드가 고정하는 것
 *   ① 저장 배선(INSERT 칸 ≡ 자리 ≡ 파라미터 / SET 센티널 / 미전송=유지)
 *   ② 기본형을 벗어나면 부속정보를 **비운다**(유형 전환 시 옛 조합 잔류 차단)
 *   ③ 작업표 부속 열 보장 훅(fail-soft · 열 이름·자리·배분 사본 0)
 *   ④ 권한 경계 — 스코프 편집(리뷰어앱)은 이 값을 못 바꾼다
 *   ⑤ 화면 배선 — 입력칸·토글·합계 상태·미전송 원칙
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const FE = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');

const camp = read(path.join(ROOT, 'src/routes/campaign.routes.js'));
const svc = read(path.join(ROOT, 'src/services/worktableDeliveryColumn.service.js'));
const modal = read(path.join(FE, 'js/recruit-modal.js'));
const front = read(path.join(FE, 'js/index-recruit.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + e.message); }
}

/** 최상위 콤마로 항목을 센다(문자열·중첩 괄호 무시, 꼬리 콤마 보정). */
function topLevelItems(src) {
  let depth = 0, count = 1, inS = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inS) { if (c === '\\') i++; else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) count++;
  }
  const b = src.trim();
  return b.endsWith(',') ? count - 1 : count;
}
function paramsAfter(from) {
  const aStart = camp.indexOf('[', from);
  let d = 0, aEnd = aStart;
  for (let i = aStart; i < camp.length; i++) {
    const c = camp[i];
    if (c === '[') d++;
    else if (c === ']') { d--; if (!d) { aEnd = i; break; } }
  }
  return topLevelItems(camp.slice(aStart + 1, aEnd).replace(/\/\/[^\n]*/g, ''));
}

console.log('\n[A] 발행(create) INSERT 정합');
t('세 칸이 INSERT 목록에 있다', () => {
  const i = camp.indexOf('INSERT INTO recruit_campaigns');
  const cols = camp.slice(camp.indexOf('(', i), camp.indexOf('VALUES', i));
  ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach(c =>
    assert.ok(cols.includes(c), c + ' 가 INSERT 목록에 없다'));
});
t('★ 컬럼 수 ≡ 자리표시자 ≡ 파라미터 수', () => {
  const i = camp.indexOf('INSERT INTO recruit_campaigns');
  const colsEnd = camp.indexOf('VALUES', i);
  const colsRaw = camp.slice(camp.indexOf('(', i) + 1, colsEnd).replace(/--[^\n]*/g, '');
  const nCols = topLevelItems(colsRaw.replace(/\)\s*$/, '').trim());
  const rEnd = camp.indexOf('RETURNING', colsEnd);
  const ph = [...new Set(camp.slice(colsEnd, rEnd).match(/\$\d+/g) || [])].map(x => +x.slice(1));
  const maxPh = Math.max(...ph);
  const nParams = paramsAfter(rEnd);
  assert.strictEqual(nCols, maxPh, `컬럼 ${nCols} ≠ 자리표시자 ${maxPh}`);
  assert.strictEqual(maxPh, nParams, `자리표시자 ${maxPh} ≠ 파라미터 ${nParams}`);
});

console.log('\n[B] 수정(update) SET 센티널 — 미전송 = 유지');
t('세 칸 모두 CASE 센티널(null=유지)이다', () => {
  assert.ok(/delivery_type_mix = CASE WHEN \$\d+::jsonb IS NULL THEN delivery_type_mix/.test(camp),
    'delivery_type_mix 가 COALESCE·직접대입이면 부속칸 없는 화면이 값을 지운다');
  assert.ok(/recall_courier = CASE WHEN \$\d+::text IS NULL THEN recall_courier/.test(camp));
  assert.ok(/recall_product = CASE WHEN \$\d+::text IS NULL THEN recall_product/.test(camp));
});
t('★ SET 자리표시자 ≡ 파라미터 수 (번호 충돌 없음)', () => {
  const i = camp.lastIndexOf('UPDATE recruit_campaigns SET', camp.indexOf('recall_product = CASE'));
  const rEnd = camp.indexOf('RETURNING *', i);
  const sql = camp.slice(i, rEnd).replace(/--[^\n]*/g, '');
  const ph = [...new Set(sql.match(/\$\d+/g) || [])].map(x => +x.slice(1)).sort((a, b) => a - b);
  const maxPh = Math.max(...ph);
  for (let k = 1; k <= maxPh; k++) assert.ok(ph.includes(k), `$${k} 가 빠졌다`);
  assert.strictEqual(maxPh, paramsAfter(rEnd), '자리표시자와 파라미터 수가 다르다');
});
t('미전송이면 null 을 넘긴다(=유지)', () => {
  assert.ok(/deliveryMixForStore === null \? null : JSON\.stringify\(deliveryMixForStore\)/.test(camp));
  assert.ok(/let deliveryMixForStore = null/.test(camp));
  assert.ok(/let recallCourierForStore = null/.test(camp));
});

console.log('\n[C] 기본형을 벗어나면 비운다 (유형 전환 시 잔류 차단)');
t('발행: 혼합/회수가 아니면 []·\'\' 로 저장', () => {
  assert.ok(/const storeDeliveryMix = deliveryBase === '혼합' \? \(deliveryMixState\.mix \|\| \[\]\) : \[\]/.test(camp));
  assert.ok(/const storeRecallCourier = deliveryBase === '회수' \? String\(recall_courier \|\| ''\)\.trim\(\) : ''/.test(camp));
});
t('수정: 기본형을 벗어나면 함께 지운다', () => {
  assert.ok(/if \(effDeliveryBase !== '혼합'\) deliveryMixForStore = \[\]/.test(camp));
  assert.ok(/if \(effDeliveryBase !== '회수'\) \{ recallCourierForStore = ''; recallProductForStore = ''; \}/.test(camp));
});
t('★ 합계 = 총 건수 검증을 태운다(발행·수정 양쪽)', () => {
  const hits = camp.match(/validateDeliveryTypeMix\(/g) || [];
  assert.ok(hits.length >= 2, `검증 호출이 ${hits.length}회 — 발행·수정 둘 다 태워야 한다`);
});

console.log('\n[D] 작업표 부속 열 보장 훅');
t('발행·수정 양쪽에서 훅을 부른다', () => {
  const hits = camp.match(/_ensureLinkedWorktableDeliveryColumns\(/g) || [];
  assert.ok(hits.length >= 3, `훅 정의+호출이 ${hits.length}회 — 발행·수정 둘 다여야 한다`);
  assert.ok(camp.includes("_ensureLinkedWorktableDeliveryColumns(rows[0].id, 'create')"));
  assert.ok(camp.includes("_ensureLinkedWorktableDeliveryColumns(id, 'update')"));
});
t('★ 훅은 절대 throw 하지 않는다 (열 보장 실패가 공고 저장을 죽이면 안 된다)', () => {
  const i = camp.indexOf('async function _ensureLinkedWorktableDeliveryColumns');
  const body = camp.slice(i, camp.indexOf('\nasync function', i + 10));
  assert.ok(/catch \(e\)/.test(body), 'catch 가 없다');
  assert.ok(!/\bthrow\b/.test(body), '훅 안에 throw 가 있다');
});
t('★ recruit_campaigns 의 컬럼명은 linked_sheet_id 다 (옵션 훅이 밟은 42703 자리)', () => {
  const i = camp.indexOf('async function _ensureLinkedWorktableDeliveryColumns');
  const raw = camp.slice(i, camp.indexOf('\nasync function', i + 10));
  // ★ 주석을 먼저 걷어낸다 — "linked_tab_sheet_id 아님" 이라 **경고해 둔 문장**이
  //   코드로 오인돼 가드가 거짓 실패한다(이 레포가 반복해 밟은 자리).
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(body.includes('linked_sheet_id'), 'linked_sheet_id 를 안 읽는다');
  assert.ok(!body.includes('linked_tab_sheet_id'), 'work_orders 의 컬럼명을 쓰고 있다(42703)');
});

console.log('\n[E] 서비스 — 사본 0 · 쓰기 표면 · fail-closed');
t('★ 열 이름·자리·배분은 worktablePlan 단일 출처', () => {
  assert.ok(/require\('\.\.\/utils\/worktablePlan'\)/.test(svc));
  ['DELIVERY_KIND_HEADER', 'RECALL_HEADERS', 'distributeDeliveryTypes'].forEach(k =>
    assert.ok(svc.includes(k), k + ' 를 가져오지 않는다'));
  assert.ok(!/'배송구분'/.test(svc), '열 이름을 사본으로 적었다');
  assert.ok(!/'회수택배사'/.test(svc), '회수 열 이름을 사본으로 적었다');
});
t('★ 쓰기 표면 = raw_sheet_tabs 헤더 + campaign_participants.row_json 두 곳뿐', () => {
  const w = (svc.match(/UPDATE\s+(\w+)/g) || []).map(x => x.split(/\s+/)[1]);
  assert.deepStrictEqual([...new Set(w)].sort(), ['campaign_participants', 'raw_sheet_tabs']);
  assert.ok(!/INSERT INTO|DELETE FROM/.test(svc), '삽입·삭제가 있다');
});
t('★ fail-closed — 무시트·등록·기본형·부속정보 게이트', () => {
  /* ★ 문자열 존재만 보면 "게이트를 실제로 던지지 않는" 변이를 통과시킨다(변이시험 실측) —
     `throw new DeliveryColumnError('<code>'` 형태를 요구한다. */
  ['not_applicable', 'tab_not_registered', 'not_sheetless', 'no_headers', 'no_delivery_mix', 'no_recall_info']
    .forEach(code => assert.ok(
      new RegExp("throw new DeliveryColumnError\\(\\s*'" + code + "'").test(svc),
      code + ' 를 실제로 던지지 않는다'));
});
t('★ 기입은 blank-only (담당자가 적은 값을 덮지 않는다)', () => {
  assert.ok(/if \(now\) continue;\s*\/\/ ★ blank-only/.test(svc) || /blank-only/.test(svc));
  assert.ok(/const now = _str\(rj\[h\]\);\s*\n\s*if \(now\) continue;/.test(svc), 'blank-only 검사가 없다');
});
t('★ 장부 재생성은 헤더 락 안에서 쓰고 그 뒤에 돈다', () => {
  assert.ok(svc.includes('pg_advisory_xact_lock'), '재생성과 같은 락을 안 잡는다');
  assert.ok(svc.indexOf("COMMIT") < svc.indexOf('rebuildLedgers'), '재생성이 커밋보다 먼저다');
});
t('구글시트 무접촉', () => {
  assert.ok(!/googleapis|sheets\.spreadsheets|throttledCall/.test(svc));
});

console.log('\n[F] 권한 경계');
t('★ 스코프 편집(리뷰어앱)은 부속정보를 못 바꾼다', () => {
  const i = camp.indexOf('async function _scopedCampaignEdit');
  const body = camp.slice(i, camp.indexOf('UPDATE recruit_campaigns SET', i) + 900);
  ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach(k =>
    assert.ok(!body.includes(k), k + ' 가 스코프 편집에 들어갔다(권한 상승)'));
});

console.log('\n[G] 화면 배선');
t('부속 입력칸 5종이 살아 있는 마크업에 있다', () => {
  ['rf_delivery_mix_row', 'rf_delivery_real_count', 'rf_delivery_empty_count',
   'rf_recall_row', 'rf_recall_courier', 'rf_recall_product'].forEach(id =>
    assert.ok(modal.includes(id), id + ' 가 없다'));
});
t('★ 해당 유형일 때만 펼친다', () => {
  assert.ok(/mixRow\.hidden = base !== '혼합'/.test(modal));
  assert.ok(/recallRow\.hidden = base !== '회수'/.test(modal));
});
/* ★★ 2026-08-24 실사고 — JS 는 위처럼 el.hidden 을 정확히 세우는데도 배송유형이 실배송인
   화면에 "배송 조합"·"회수 정보" 가 그대로 보였다. 원인은 JS 가 아니라 CSS 였다:
   `.rf-compact-main .form-row{display:grid}` 가 **브라우저 기본 규칙 [hidden]{display:none} 을
   항상 이긴다**(작성자 스타일시트 > UA 스타일시트). 그래서 hidden 속성만으로는 안 접힌다.
   ★ 이 회귀는 정적 grep(위 두 줄)으로는 절대 안 잡힌다 — 그 두 줄은 멀쩡히 있었다.
     그래서 "가림 규칙이 CSS 에 있고, 그 규칙이 display:grid 보다 특이성이 높은가"를 고정한다. */
t('★★ hidden 이 CSS display:grid 에 먹히지 않게 가림 규칙이 있다(실사고 재발 차단)', () => {
  assert.ok(/\.form-row\[hidden\]\{display:none\}/.test(modal),
    'form-row[hidden] 가림 규칙이 없다 — hidden 을 세워도 줄이 그대로 보인다');
});
t('★★ 그 가림 규칙은 순서에 기대지 않을 만큼 특이성이 높다', () => {
  // `.rf-compact-main .form-row{display:grid}` 와 특이성이 같으면 파일 순서(나중 규칙이 이김)에
  // 좌우돼, CSS 를 재배치하는 순간 가림이 조용히 풀린다(이 파일에서 이미 두 번 밟은 함정).
  assert.ok(/#recruitModal \.rf-compact-main \.form-row\[hidden\]/.test(modal),
    '.rf-compact-main 접두가 없으면 display:grid 규칙과 특이성이 같아 순서에 기댄다');
});
t('★ 그 규칙은 form-row 만 겨냥한다(전역 [hidden] !important 금지)', () => {
  // 전역 `#recruitModal [hidden]{display:none!important}` 로 때우면, hidden 을 단 채
  // style.display 로만 여는 요소(rf_linked_tab_note 계열)가 **영구히 안 보이게** 된다.
  assert.ok(!/#recruitModal \[hidden\]\{display:none!important\}/.test(modal),
    '전역 !important 가림은 style.display 로 여는 요소를 죽인다');
});
t('★ style.display 로만 여는 안내 박스에는 hidden 을 달지 않는다(영구 비표시 차단)', () => {
  // 같은 사고의 거울상: rf_linked_tab_note 는 코드가 style.display 로만 여닫는데 마크업에
  // hidden 이 붙어 있어 **한 번도 보인 적이 없었다**(2026-08-24 함께 발견).
  assert.ok(/id="rf_linked_tab_note" style="display:none"/.test(modal),
    'rf_linked_tab_note 가 hidden 이면 style.display="" 로 열어도 UA 규칙에 막혀 안 보인다');
  assert.ok(!/id="rf_linked_tab_note" hidden/.test(modal));
});
t('★ 배송유형이 바뀌면 부속 행이 따라간다', () => {
  assert.ok(/delivery\.addEventListener\('change', rfSyncDeliveryDetail\)/.test(modal));
  assert.ok(/window\.rfSyncDeliveryDetail = rfSyncDeliveryDetail/.test(modal),
    '전역 노출이 없으면 마크업의 oninput 이 ReferenceError 로 죽는다');
});
t('★ 합계 상태를 화면이 말한다', () => {
  assert.ok(/합계 ' \+ sum \+ '건 \/ 총 건수 ' \+ total \+ '건'/.test(modal));
});
t('★ payload 는 입력칸이 있는 화면에서만 실린다(미전송 = 유지)', () => {
  const i = front.indexOf('function _rfDeliveryDetailPayload');
  const body = front.slice(i, front.indexOf('\nwindow.rfToggleCashReceipt', i));
  assert.ok(/if \(!mixRow && !recallRow\) return \{\};/.test(body), '칸 없는 화면에서 빈 객체를 안 돌려준다');
  assert.ok(front.includes('..._rfDeliveryDetailPayload()'), '저장 payload 에 안 실린다');
});
t('★ 프리필은 발행·수정 공용 한 벌(사본 0)', () => {
  const hits = front.match(/_rfFillDeliveryDetail\(/g) || [];
  assert.ok(hits.length >= 3, `정의+발행+수정 = 3회여야 하는데 ${hits.length}회`);
  assert.ok(front.includes('_rfFillDeliveryDetail(c.delivery_type_mix'), '수정 프리필이 없다');
  assert.ok(front.includes('_rfFillDeliveryDetail(prefill.delivery_type_mix'), '발행 프리필이 없다');
});
t('★ 신규 발행 초기화가 부속칸을 비운다(이전 공고 값 누수 차단)', () => {
  assert.ok(/"rf_delivery_real_count","rf_delivery_empty_count","rf_recall_courier","rf_recall_product"/.test(front));
});

console.log(`\n총 ${pass + fail}건 — 통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
