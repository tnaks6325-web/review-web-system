/**
 * participantAddSheetless.test.js — [＋ 줄 추가](addParticipant) 무시트 결함 수정 회귀가드 (2026-08-21)
 *
 * 결함(실측): 무시트 탭에서 addParticipant 가 ① seq 를 900000 대역에 배정하고 ② row_json 을
 * 비워 두어, 장부 생성기(buildValues)가 90만 칸 배열을 만들고 그 줄은 이름 없는 행으로 버려져
 * **검색 명단·입금대상에서 영영 빠졌다**.
 *
 * 고정하는 것:
 *   A. 무시트 add = 실제 행 번호 대역 + row_json(헤더명 키) + source='worktable' + 장부 재생성 1회
 *   B. MAX(seq) 가 900000 대역을 세지 않는다(FILTER) — 오염된 탭에서도 실제 대역으로 이어붙는다
 *   C. 시트 기반 탭 = 종전 경로 그대로(900000 대역·source='manual'·장부 재생성 없음) — 무회귀
 *   D. fail-closed 3종(이름 없음·미등록 탭·열 구성 미상) = 쓰기 0건
 *   E. buildValues 가 900000 대역 줄을 배열에 넣지 않고(90만 칸 방어) 뺀 사실을 세어 알린다
 *   F. appendSlot·registerBlogger·addApplicantRow 의 MAX(seq) 도 같은 대역 가드(단일 출처)
 *
 * 실행: node tests/participantAddSheetless.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/participants.service');
const ledger = require('../src/services/sheetlessLedger.service');

const HEADERS = ['번호', '담당자', '구매일자', '수취인', 'id', '연락처', '주소', '은행', '리뷰제출', '입금'];

function makePool(sc) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/COALESCE\(sheetless, FALSE\) AS s FROM tab_configs/.test(s)) return { rows: [{ s: !!sc.sheetless }] };
      if (/SELECT tab_gid, campaign_name FROM tab_configs/.test(s)) return { rows: sc.unregistered ? [] : [{ tab_gid: '77', campaign_name: '캠페인C' }] };
      if (/SELECT detected_headers, headers FROM raw_sheet_tabs/.test(s)) return { rows: [{ detected_headers: sc.headers === undefined ? HEADERS : sc.headers, headers: null }] };
      if (/MAX\(seq\) FILTER \(WHERE seq < 900000\)/.test(s)) return { rows: [{ nextseq: sc.nextseq || 79 }] };
      if (/MAX\(seq\) FILTER \(WHERE seq >= 900000\)/.test(s)) return { rows: [{ nextseq: 900001, tab_gid: null }] };
      if (/INSERT INTO campaign_participants[\s\S]*RETURNING id, seq/.test(s)) {
        // 무시트 INSERT 는 campaign_name 포함(seq=params[4]), 종전 경로는 미포함(seq=params[3])
        const seqIdx = /campaign_name/.test(s) ? 4 : 3;
        return { rows: [{ id: 'new-id', seq: params[seqIdx] }] };
      }
      return { rows: [] };
    },
  };
}

async function run() {
  const realRebuild = ledger.rebuildLedgers;
  let rebuildCalls = [];
  ledger.rebuildLedgers = async (a) => { rebuildCalls.push(a); return { ok: true }; };

  try {
    // ── A. 무시트 add: 실제 대역 + row_json + worktable + 장부 재생성 ──
    let pool = makePool({ sheetless: true, nextseq: 79 });
    svc.__setPoolForTest(pool);
    rebuildCalls = [];
    let r = await svc.addParticipant({ sheetId: 'S', tabName: 'T', reviewerName: '박은비', phone: '010-8221-7191', by: 'master' });
    assert.equal(r.added, 1);
    assert.equal(r.seq, 79, '무시트 add 는 실제 행 번호 대역(900000 아님)');
    assert.equal(r.sheetless, true);
    const ins = pool.q.find(x => /INSERT INTO campaign_participants/.test(x.s));
    assert.ok(ins, 'INSERT 실행');
    assert.ok(/'worktable'/.test(ins.s), "무시트 add 는 source='worktable' — manual 이면 리뷰제출·입금 표시가 영영 안 켜진다");
    const rj = JSON.parse(ins.params[11]);
    assert.equal(rj['수취인'], '박은비', 'row_json 이름 칸 — 비면 장부 파서가 그 줄을 버린다(결함의 본체)');
    assert.equal(rj['연락처'], '010-8221-7191', 'row_json 연락처 칸');
    assert.ok(!('번호' in rj), '번호 칸은 비워 둔다(자동 재번호 스윕 담당 — 틀린 값보다 빈 값)');
    assert.equal(ins.params[7], '82217191', 'phone8 정규화(끝 8자리)');
    assert.equal(rebuildCalls.length, 1, '장부 재생성 1회 — 빼면 표에는 있는데 검색·입금대상에는 없는 줄');
    assert.equal(rebuildCalls[0].sheetId, 'S');
    console.log('  A. 무시트 add(실제 대역·row_json·worktable·장부) 통과');

    // ── B. MAX 쿼리가 900000 대역을 세지 않는다 ──
    const mx = pool.q.find(x => /MAX\(seq\) FILTER \(WHERE seq < 900000\)/.test(x.s));
    assert.ok(mx, 'MAX(seq) 에 대역 FILTER — 오염된 탭(900001 존재)에서도 실제 대역으로 이어붙는다');
    console.log('  B. 대역 FILTER 통과');

    // ── C. 시트 기반 탭 = 종전 경로 그대로(무회귀) ──
    pool = makePool({ sheetless: false });
    svc.__setPoolForTest(pool);
    rebuildCalls = [];
    r = await svc.addParticipant({ sheetId: 'S', tabName: 'T', reviewerName: '수동추가', phone: '010-9999-1234', by: 'master' });
    assert.equal(r.seq, 900001, '시트 기반 탭은 종전대로 900000 대역(import 행과 비충돌)');
    assert.equal(r.sheetless, undefined, '종전 반환 shape 불변');
    const ins2 = pool.q.find(x => /INSERT INTO campaign_participants/.test(x.s));
    assert.ok(/'manual'/.test(ins2.s), '종전 경로는 source=manual 그대로');
    assert.equal(rebuildCalls.length, 0, '시트 기반 탭에서는 장부 재생성을 부르지 않는다');
    console.log('  C. 시트 기반 무회귀 통과');

    // ── D. fail-closed 3종 = 쓰기 0건 ──
    for (const [sc, args, label] of [
      [{ sheetless: true }, { sheetId: 'S', tabName: 'T', phone: '010-1111-2222' }, '이름 없음'],
      [{ sheetless: true, unregistered: true }, { sheetId: 'S', tabName: 'T', reviewerName: 'X' }, '미등록 탭'],
      [{ sheetless: true, headers: [] }, { sheetId: 'S', tabName: 'T', reviewerName: 'X' }, '열 구성 미상'],
    ]) {
      pool = makePool(sc);
      svc.__setPoolForTest(pool);
      let threw = false;
      try { await svc.addParticipant({ ...args, by: 'm' }); } catch (_) { threw = true; }
      assert.ok(threw, `${label} → 거부(throw)`);
      assert.ok(!pool.q.some(x => /INSERT INTO/.test(x.s)), `${label} → 쓰기 0건`);
    }
    console.log('  D. fail-closed 3종(쓰기 0) 통과');

    // ── E. buildValues 900000 대역 방어(실행) ──
    const bv = ledger.buildValues({
      headers: ['수취인', '연락처'],
      rows: [
        { seq: 2, row_json: { 수취인: 'A' } },
        { seq: 900001, row_json: { 수취인: '값있는잔재' } },
        { seq: 900002, row_json: {} },
      ],
    });
    assert.ok(bv.values.length < 1000, `대역 줄이 배열 크기를 정하면 안 된다(실측 ${bv.values.length}칸 — 90만 칸 방어)`);
    assert.equal(bv.manualBandSkipped, 2, '뺀 줄 수를 센다(조용한 누락 금지)');
    assert.equal(bv.manualBandWithData, 1, '값이 있는 잔재 줄 수를 따로 센다(warn 재료)');
    assert.deepEqual(bv.values[1], ['A', ''], '실제 대역 줄은 종전 그대로 실린다');
    // 대역 줄이 없으면 종전과 완전히 동일
    const bv0 = ledger.buildValues({ headers: ['수취인'], rows: [{ seq: 2, row_json: { 수취인: 'A' } }] });
    assert.equal(bv0.manualBandSkipped, 0);
    assert.equal(bv0.values.length, 2);
    console.log('  E. buildValues 대역 방어 통과');

    // ── F. 형제 경로들의 MAX(seq) 대역 가드(단일 출처) ──
    const SRC = f => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
    const FILTER_RE = /MAX\(seq\) FILTER \(WHERE seq < \$\{(?:_)?MANUAL_SEQ_BASE\}/;
    for (const f of ['participants.service.js', 'blogRegister.service.js', 'sheetlessApplicant.service.js']) {
      assert.ok(FILTER_RE.test(SRC(f)), `${f}: MAX(seq) 대역 FILTER (상수 단일 출처)`);
    }
    // appendSlot 자체(participants 안 두 번째 사용처)
    const partSrc = SRC('participants.service.js');
    const apIdx = partSrc.indexOf('async function appendSlot');
    assert.ok(FILTER_RE.test(partSrc.slice(apIdx, apIdx + 1200)), 'appendSlot 의 MAX(seq) 도 대역 FILTER');
    // 상수는 participants 가 단일 출처로 내보낸다
    assert.equal(svc.MANUAL_SEQ_BASE, 900000, 'MANUAL_SEQ_BASE 단일 출처 export');
    console.log('  F. 형제 경로 대역 가드 통과');
  } finally {
    ledger.rebuildLedgers = realRebuild;
    svc.__setPoolForTest(null);
  }

  console.log('✅ participantAddSheetless: 전부 통과');
  process.exit(0);
}

run().catch(e => { console.error('❌', e); process.exit(1); });
