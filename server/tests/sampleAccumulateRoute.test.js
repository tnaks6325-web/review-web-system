/**
 * sampleAccumulateRoute.test.js — 리뷰검수 2차 회귀가드:
 *   [A] 판별 예시 누적(교체 → 추가) — 하위호환·상한·개별 삭제·캐시 지문
 *   [B] 동봉 상한 트림 — 슬롯별 최근 우선 라운드로빈(슬롯 전멸 금지)
 *   [C] 수동 분류(manualRoute) — 검증 분기 + 실제 이동 시퀀스(스텁 pool/drive)
 *   [D] 정확도 통계(routeAccuracyStats) — 수동 분류 vs AI 계획 대조
 *   [E] 배선 — 라우트·workdesk 유형 필터/이동 버튼·admin-settings 다장 UI·승격 mode:'add'
 *
 * 실행: node tests/sampleAccumulateRoute.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* drive.service 는 실 자격증명이 필요하다 — fileRoute 가 lazy require 하기 전에 스텁 주입 */
const drivePath = require.resolve('../src/services/drive.service');
const _driveCalls = [];
require.cache[drivePath] = {
  id: drivePath, filename: drivePath, loaded: true, exports: {
    getFileParents: async (id) => { _driveCalls.push(['parents', id]); return { parents: ['OLD_PARENT'] }; },
    moveFile: async (id, to, from) => { _driveCalls.push(['move', id, to, from]); },
    extractFolderIdFromUrl: (u) => (u ? 'REVIEW_BASE' : null),
    getOrCreateSubFolder: async (base, label) => { _driveCalls.push(['sub', base, label]); return { id: 'RECEIPT_FOLDER' }; },
    trashFiles: async () => { throw new Error('수동 경로에서 휴지통 호출 금지'); },
    downloadFile: async () => null,
    ensureCaptureFolderPath: async () => ({ id: 'CAP', url: 'https://drive.google.com/drive/folders/CAP' }),
  },
};

const RI = require('../src/services/reviewInspect.service');
const FR = require('../src/services/fileRoute.service');

function seqPool(handlers) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const h = handlers[Math.min(i, handlers.length - 1)]; i++;
      return typeof h === 'function' ? h(sql, params) : (h || { rows: [], rowCount: 0 });
    },
  };
}

(async () => {
  /* ═══ A. 누적 저장 ═══ */
  console.log('\nA) 판별 예시 누적');
  {
    // A1: 하위호환 — 종전 값(URL 문자열 1개)은 1장짜리 배열로 읽힌다(기존 등록분 유실 0)
    assert.deepStrictEqual(RI.parseSampleUrls('https://x/api/drive/image/AAAAAAAAAAAAAAAAAAAAA'),
      ['https://x/api/drive/image/AAAAAAAAAAAAAAAAAAAAA']);
    assert.deepStrictEqual(RI.parseSampleUrls(''), []);
    assert.deepStrictEqual(RI.parseSampleUrls('["https://a/1","http://bad","https://a/2"]'),
      ['https://a/1', 'https://a/2'], 'https 아닌 항목은 걸러진다');
    assert.deepStrictEqual(RI.parseSampleUrls('[broken'), []);
    ok('A1: ★ 하위호환 — 문자열 = 1장짜리 배열(마이그레이션 0·유실 0), 깨진 JSON = 빈 목록');

    // A2: add = 누적(교체 아님) — 기존 1장 + 새 1장 = 2장
    let p = seqPool([
      { rows: [{ value: 'https://a/1' }] },
      { rows: [], rowCount: 1 },
    ]);
    RI.__setPoolForTest(p);
    const l2 = await RI.saveRouteSample({ key: 'order_capture', imageUrl: 'https://a/2', mode: 'add' });
    assert.deepStrictEqual(l2, ['https://a/1', 'https://a/2']);
    const up = p.calls.find(q => /INSERT INTO app_settings/.test(q.sql));
    assert.strictEqual(up.params[1], JSON.stringify(['https://a/1', 'https://a/2']), 'JSON 배열로 저장');
    ok('A2: ★★ mode:add = 기존 예시를 지우지 않고 추가(교체 아님)');

    // A3: 상한 — 5장에서 add 거부(사유 메시지)
    p = seqPool([{ rows: [{ value: JSON.stringify(['https://a/1','https://a/2','https://a/3','https://a/4','https://a/5']) }] }]);
    RI.__setPoolForTest(p);
    let threw = null;
    try { await RI.saveRouteSample({ key: 'order_capture', imageUrl: 'https://a/6', mode: 'add' }); } catch (e) { threw = e; }
    assert.ok(threw && /최대 5장/.test(threw.message));
    ok('A3: 슬롯당 하드캡 5장 — 초과는 사유와 함께 거부(조용한 절단 금지)');

    // A4: 같은 URL 재등록 = no-op(중복 누적 방지)
    p = seqPool([{ rows: [{ value: 'https://a/1' }] }, { rows: [], rowCount: 1 }]);
    RI.__setPoolForTest(p);
    const same = await RI.saveRouteSample({ key: 'order_capture', imageUrl: 'https://a/1', mode: 'add' });
    assert.deepStrictEqual(same, ['https://a/1']);
    ok('A4: 같은 URL 재등록 = 중복 누적 없음');

    // A5: remove = 그 장만 삭제
    p = seqPool([{ rows: [{ value: JSON.stringify(['https://a/1', 'https://a/2']) }] }, { rows: [], rowCount: 1 }]);
    RI.__setPoolForTest(p);
    const rem = await RI.saveRouteSample({ key: 'order_capture', mode: 'remove', index: 0 });
    assert.deepStrictEqual(rem, ['https://a/2']);
    ok('A5: mode:remove+index = 고른 한 장만 삭제');

    // A6: 종전 동작 보존 — mode 미지정 + '' = 전체 제거 / URL = 단일 교체(옛 화면 호환)
    p = seqPool([{ rows: [{ value: JSON.stringify(['https://a/1', 'https://a/2']) }] }, { rows: [], rowCount: 1 }]);
    RI.__setPoolForTest(p);
    const clr = await RI.saveRouteSample({ key: 'order_capture', imageUrl: '' });
    assert.deepStrictEqual(clr, []);
    ok('A6: mode 미지정 = 종전 동작 100%(교체/전체 제거 — 구화면 호환)');

    // A7: 설정 조회가 imageUrls 배열 + imageUrl 첫 장(하위호환)을 함께 준다
    p = seqPool([{ rows: [{ key: 'route_sample_order_capture', value: JSON.stringify(['https://a/1', 'https://a/2']) }] }]);
    RI.__setPoolForTest(p);
    const st = (await RI.routeSampleSettings()).find(s => s.key === 'order_capture');
    assert.deepStrictEqual(st.imageUrls, ['https://a/1', 'https://a/2']);
    assert.strictEqual(st.imageUrl, 'https://a/1');
    ok('A7: 설정 응답 = imageUrls 배열 + imageUrl 첫 장(구프론트 호환)');
    RI.__setPoolForTest(null);

    // A8: 캐시 지문 — 로더가 key 에 URL 해시 접미(#)를 붙인다(장수·구성 변화 = sampleSig 변화)
    const src = read('src/services/reviewInspect.service.js');
    assert.ok(/s\.key \+ '#' \+ imgId/.test(src), '샘플 key 에 이미지 식별자 접미');
    assert.ok(/sha1'\)\.update\(url\)/.test(src.replace(/createHash\('/g, "'")) || /createHash\('sha1'\)\.update\(url\)/.test(src));
    ok('A8: ★★ 캐시 지문 — 예시 구성이 바뀌면 옛 판정 캐시가 히트하지 못한다');
  }

  /* ═══ B. 동봉 상한 트림 ═══ */
  console.log('\nB) 동봉 상한(6장) 트림');
  {
    const mk = (base, i) => ({ key: base + '#' + i, label: base });
    const samples = [
      mk('coupang_pc', 1), mk('coupang_pc', 2), mk('coupang_pc', 3), mk('coupang_pc', 4),
      mk('route_order_capture', 1), mk('route_order_capture', 2),
      mk('route_purchase_confirm', 1), mk('route_purchase_confirm', 2),
    ];
    const t = RI._trimSamples(samples, 6);
    assert.strictEqual(t.length, 6);
    const bases = new Set(t.map(s => s.key.split('#')[0]));
    assert.ok(bases.has('coupang_pc') && bases.has('route_order_capture') && bases.has('route_purchase_confirm'),
      '라운드로빈 — 어떤 슬롯도 통째로 잘리지 않는다');
    assert.ok(t.some(s => s.key === 'coupang_pc#4'), '슬롯 안에서는 최근 등록(뒤) 우선');
    assert.strictEqual(RI._trimSamples(samples.slice(0, 3), 6).length, 3, '상한 이하 = 무변경');
    ok('B1: ★ 판정당 6장 상한 — 슬롯별 최근 우선 라운드로빈(자동분류 예시 전멸 금지)');
    assert.ok(/_trimSamples\(base\.concat\(route\)\)/.test(read('src/services/reviewInspect.service.js')),
      'submissionSamples(단일 조립 지점)가 트림을 적용');
    ok('B2: 트림은 단일 조립 지점(submissionSamples)에서 — 호출부별 드리프트 없음');
  }

  /* ═══ C. 수동 분류 ═══ */
  console.log('\nC) manualRoute — 수동 분류(이동)');
  {
    // C1: 검증 분기
    assert.strictEqual((await FR.manualRoute({})).ok, false);
    assert.strictEqual((await FR.manualRoute({ fileId: 'F', target: 'trash' })).ok, false, '대상 화이트리스트');
    let p = seqPool([{ rows: [] }]);
    FR.__setPoolForTest(p);
    assert.ok(/원장에 없는/.test((await FR.manualRoute({ fileId: 'F', target: 'receipt' })).error));
    p = seqPool([{ rows: [{ file_id: 'F', slot_key: 'receipt', sheet_id: 's', tab_name: 't' }] }]);
    FR.__setPoolForTest(p);
    assert.ok(/이미 그 칸/.test((await FR.manualRoute({ fileId: 'F', target: 'receipt' })).error));
    ok('C1: 대상 화이트리스트·원장 부재·같은 칸 = 거부(이동 0)');

    // C2: 대상 칸 중복 = 거부(휴지통 금지 — 수동 경로에 파일 삭제 없음)
    p = seqPool([
      { rows: [{ file_id: 'F', file_name: 'f.png', sheet_id: 's', tab_name: 't', row_index: 3, reviewer_name: '김', slot_key: 'review', file_hash: 'H' }] },
      { rows: [{ folder_url: 'https://drive.google.com/drive/folders/REVIEW_BASE', capture_slots: null, income_type: '현영' }] },
      { rows: [{ file_id: 'OTHER' }] },   // findSlotDuplicate 히트
    ]);
    FR.__setPoolForTest(p);
    const dupOut = await FR.manualRoute({ fileId: 'F', target: 'receipt', by: '만두' });
    assert.strictEqual(dupOut.ok, false);
    assert.ok(/같은 파일이 이미/.test(dupOut.error));
    ok('C2: ★ 대상 칸 같은 지문 = 거부(자동과 달리 휴지통으로 보내지 않는다)');

    // C3: 정상 이동 — Drive 이동 + 원장 UPDATE(COALESCE 최초 출처 보존 + manual: 표기) + 대표 재계산 + resolved 로그
    _driveCalls.length = 0;
    p = seqPool([
      { rows: [{ file_id: 'F', file_name: 'f.png', sheet_id: 's', tab_name: 't', row_index: 3, reviewer_name: '김', slot_key: 'review', file_hash: 'H' }] },
      { rows: [{ folder_url: 'https://drive.google.com/drive/folders/REVIEW_BASE', capture_slots: null, income_type: '현영' }] },
      { rows: [] },                        // 중복 없음
      { rows: [], rowCount: 1 },           // 원장 UPDATE
      { rows: [] },                        // recomputePrimary SELECT(0장 → 비움 UPDATE)
      { rows: [], rowCount: 1 },
    ]);
    FR.__setPoolForTest(p);
    const out = await FR.manualRoute({ fileId: 'F', target: 'receipt', by: '만두' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.from, 'review');
    assert.strictEqual(out.to, 'receipt');
    assert.ok(_driveCalls.some(c => c[0] === 'move' && c[2] === 'RECEIPT_FOLDER'), '현영 서브폴더로 Drive 이동');
    const upd = p.calls.find(q => /SET routed_from_slot = COALESCE\(routed_from_slot, slot_key\)/.test(q.sql));
    assert.ok(upd, '★ 최초 출처 보존(COALESCE) — 되돌리기가 항상 원래 칸으로');
    assert.strictEqual(upd.params[2], 'manual:만두', '분류 원장 표기 = manual:<이름>(정확도 통계의 재료)');
    ok('C3: 이동 시퀀스 — 자동분류와 같은 실행부(폴더·원장·대표·로그) + manual 표기');
    FR.__setPoolForTest(null);
  }

  /* ═══ D. 정확도 통계 ═══ */
  console.log('\nD) routeAccuracyStats');
  {
    const p = seqPool([
      { rows: [
        { file_id: 'A', manual_to: 'receipt', plan_to: 'receipt' },
        { file_id: 'B', manual_to: 'order_capture', plan_to: null },
        { file_id: 'C', manual_to: 'receipt', plan_to: 'order_capture' },
      ] },
    ]);
    FR.__setPoolForTest(p);
    const st = await FR.routeAccuracyStats({ days: 30 });
    assert.deepStrictEqual({ total: st.total, match: st.match, miss: st.miss, differ: st.differ },
      { total: 3, match: 1, miss: 1, differ: 1 });
    assert.ok(/routed_by LIKE 'manual:%'/.test(p.calls[0].sql), '수동 분류만 정답으로 센다');
    assert.ok(/capture_route_plan/.test(p.calls[0].sql), 'AI 관측 계획(dry 모드 기록)과 대조');
    ok('D1: 수동 분류(정답) vs AI 계획 — match/miss/differ 3분류');
    FR.__setPoolForTest(null);
  }

  /* ═══ E. 배선 ═══ */
  console.log('\nE) 배선');
  {
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/'\/review-inspect\/route-manual', authMiddleware, _reInternal/.test(tb),
      '수동 이동 = 건별 확인과 같은 게이트(내부인 + staff 담당 탭)');
    assert.ok(/'\/review-inspect\/route-stats', authMiddleware, adminOrMasterMiddleware/.test(tb),
      '정확도 통계 = adminOrMaster');
    assert.ok(/resolveInspection\(\{ fileId, by, resolution: 'ok' \}\)/.test(tb),
      '이동 성공 = 그 검수 건 정상(오제출) 자동 종결');
    assert.ok(/_routePromoteSuggestion/.test(tb) && /SAMPLE_SLOT_CAP/.test(tb),
      '승격 제안 — 슬롯에 자리가 있을 때만(상한은 서버 단일 출처)');
    ok('E1: 라우트 3종(이동·통계·종결) + 승격 제안');

    const wd = readFront('workdesk.html');
    assert.ok(/RI_TYPES=\[/.test(wd) && /_riIssueTypes/.test(wd) && /riTypeSet/.test(wd),
      '오류유형 필터 칩(클라 계산 — 서버 변경 0)');
    assert.ok(/STATE\.riStatus='\$\{k\}';STATE\.riType='all'/.test(wd),
      '★ 상태 전환 시 유형 필터 초기화');
    assert.ok(/riRouteManual\(\$\{i\},'receipt'\)/.test(wd) && /riRouteManual\(\$\{i\},'order_capture'\)/.test(wd),
      '카드 이동 버튼 — onclick 은 인덱스만(문자열 보간 금지)');
    // ⚠ 시스템 confirm → 전용 팝업(_rcPopup) 전환으로 문구 형태가 바뀌었다 — 검사 의미 불변.
    assert.ok(/\[원위치\]로 언제든 되돌릴 수 있습니다/.test(wd), '확인창이 되돌리기 경로를 알려준다');
    assert.ok(/res\.promote && confirm/.test(wd) && /mode:'add'/.test(wd),
      '이동 후 승격 제안 — 사람이 confirm 해야 등록(조용한 자동 등록 금지)');
    assert.ok(/기존 예시는 지워지지 않고 추가/.test(wd), '승격 팝업이 누적임을 말한다');
    assert.ok(/riClearSample\('\$\{s\.key\}',\$\{ui\}\)/.test(wd), '판별 예시 모달 — 장별 개별 삭제');
    ok('E2: workdesk — 유형 필터·이동 버튼·승격 confirm·누적 UI');

    const as = readFront('js/admin-settings.js');
    assert.ok(/function _smpUrls/.test(as) && /imageUrls\) \|\| \(s && s\.imageUrl \? \[s\.imageUrl\] : \[\]\)/.test(as),
      '설정탭 — 구백엔드(imageUrl 단일) 호환 파서');
    assert.ok(/mode: 'add'/.test(as) && /mode: 'remove', index: idx/.test(as),
      '설정탭 업로드 = 누적, 삭제 = 개별');
    assert.ok(/route-stats/.test(as) && /_rtLoadStats/.test(as), '정확도 카드(fail-soft)');
    assert.ok(/아직 통계를 지원하지 않습니다/.test(as), '구백엔드 = 배포 대기 안내(허위 0% 표시 금지)');
    ok('E3: admin-settings — 다장 슬롯·개별 삭제·정확도 카드');
  }

  console.log(`\n✅ sampleAccumulateRoute 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
