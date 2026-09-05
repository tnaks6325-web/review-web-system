/**
 * reviewerDbBlacklist.test.js — 등록리뷰어DB 자동 블랙리뷰어 시스템 회귀가드 (091-2)
 * 실행: node tests/reviewerDbBlacklist.test.js
 *
 * 사용자 확정(2026-08-05):
 *   · 판정 재정의 — 두 값 모두 미제출 행의 경과일수: 기한경과 = 14일↑(30일 미만, 승격·이중계수 없음)
 *     / 리뷰미작성 = 30일↑ (기본 14/30, 설정탭에서 변경)
 *   · 토글(참여가능↔블랙리스트)은 확인창 없이 즉시 적용 · 행 배경색·이름 배지 없음
 *   · Q1=B — 토글은 전 공고 자동 차단이 아니라 공고별 [🚫 리뷰어] 팝업 상단 자동 표시로 이어진다
 *   · 엑셀 다운로드 없음(있다면 제거)
 *
 * 고정하는 것:
 *  A. 집계 SQL 시맨틱 — 미제출 기준 · 기한경과 상하한(승격) · 이중 계수 없음(정적)
 *  B. annotateReviewerRows 실행(스텁 db) — 타계정 합산 · 후보 판정 · 블랙리스트 매핑 · 자리표시자 정합
 *  C. setGlobalBlacklist / listGlobalBlacklist 실행 — upsert/삭제 · 마스킹 · fail-soft
 *  D. 라우터 — /reviewers/blacklist 등록(권한 체인) · /reviewers 주석 fail-soft(statsUnavailable) ·
 *     계좌 검색 · flag 필터 자리표시자 정합 · reviewer-gate 응답에 globalBlacklist(fail-soft 미동봉)
 *  E. 프론트(등록리뷰어DB) — 홈 링크+기존 13열+신규 3열 · RV_COLSPAN 17 · 토글 즉시 적용(확인창 없음)·실패 롤백 ·
 *     행 배경/배지 없음 · 집계 실패 '?' · 필터 칩 · 엑셀 다운로드 부재
 *  F. 프론트(공고별 팝업) — globalBlacklist 맨 위 병합 · 조회 실패 = 구역 미표시 · 모두 차단은 allow 미덮음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}

(async () => {
  const svcSrc = read('src/services/reviewerGate.service.js');
  const trackBSrc = read('src/routes/trackB.routes.js');
  const wdk = read('../frontend/workdesk.html');
  const modal = read('../frontend/js/campaign-reviewer-gate.js');
  const settings = read('../frontend/js/admin-settings.js');

  // ── A. 집계 SQL 시맨틱(정적) ──
  console.log('\n[A] 집계 SQL — 재정의된 판정(미제출 기준 · 승격 · 이중계수 없음)');
  {
    const m = svcSrc.match(/async function _reviewHistory[\s\S]{0,2200}?GROUP BY ri\.phone8/);
    ok('_reviewHistory 존재', !!m);
    const sql = m[0];
    ok('★ nowrite = 미제출 AND 경과 ≥ nowriteDays($3)',
      /AS nowrite/.test(sql) && /NOT \(ri\.is_submitted = TRUE OR ri\.review_file_id IS NOT NULL\)[\s\S]{0,200}\$3 \|\| ' days'[\s\S]{0,60}::interval\)::int AS nowrite/.test(sql));
    ok('★ overdue 도 미제출 기준(옛 "늦게 제출" 정의 폐기)',
      !/review_file_at > os\.submitted_at/.test(sql));
    ok('★ overdue 는 상하한 양쪽( ≥ overdueDays AND < nowriteDays ) — 30일 넘으면 미작성으로 승격 = 이중계수 없음',
      /AS overdue/.test(sql) && /\$2 \|\| ' days'/.test(sql) && />= NOW\(\) - \(\$3 \|\| ' days'\)::interval/.test(sql));
    ok('구매 시점 없는 행 제외(os.submitted_at IS NOT NULL)', (sql.match(/os\.submitted_at IS NOT NULL/g) || []).length >= 2);
  }

  // ── B. annotateReviewerRows 실행 ──
  console.log('\n[B] annotateReviewerRows (스텁 db 실행)');
  const svc = require('../src/services/reviewerGate.service');
  {
    const db = { query: async (sql, params) => {
      const maxPh = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(x => Number(x[1])));
      assert(maxPh === (params || []).length, '자리표시자↔파라미터 불일치: ' + sql.slice(0, 60));
      if (/FROM review_index/.test(sql)) return { rows: [
        { phone8: '11111111', joined: 5, done: 3, nowrite: 1, overdue: 1 },   // 본인
        { phone8: '22222222', joined: 4, done: 4, nowrite: 1, overdue: 0 },   // 타계정
      ] };
      if (/FROM blacklist/.test(sql)) return { rows: [{ p8: '33333333', reason: 'r', added_by: 'a', added_at: null }] };
      if (/FROM app_settings/.test(sql)) return { rows: [] };
      return { rows: [] };
    } };
    const out = await svc.annotateReviewerRows([
      { phone8: '11111111', subPhone8s: ['22222222'] },
      { phone8: '33333333', subPhone8s: [] },
    ], db);
    ok('★ 누적참여 = 본인+타계정 합산(5+4=9) · joinedSub=4',
      out[0].stats.joined === 9 && out[0].stats.joinedSub === 4, out[0].stats);
    ok('★ 미작성도 타계정 포함 합산(1+1=2) → 후보', out[0].stats.nowrite === 2 && out[0].candidate === true);
    ok('참여 이력 없는 리뷰어 = 0건·후보 아님', out[1].stats.joined === 0 && out[1].candidate === false);
    ok('블랙리스트 매핑(phone8 키)', !!out[1].blacklisted && out[0].blacklisted === null);
  }

  // ── C. 전역 블랙리스트 토글·목록 ──
  console.log('\n[C] setGlobalBlacklist / listGlobalBlacklist');
  {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await svc.setGlobalBlacklist({ phone: '010-1010-1234', on: true, reason: 'r', by: '만두' }, db);
    ok('등록 = blacklist upsert(ON CONFLICT phone)', /INSERT INTO blacklist[\s\S]{0,200}ON CONFLICT \(phone\) DO UPDATE/.test(calls[0].sql)
      && calls[0].params[0] === '01010101234');
    await svc.setGlobalBlacklist({ phone: '010-1010-1234', on: false }, db);
    ok('해제 = DELETE(숫자 정규화 매칭)', /DELETE FROM blacklist/.test(calls[1].sql));
    let threw = false;
    try { await svc.setGlobalBlacklist({ phone: '123', on: true }, db); } catch (_) { threw = true; }
    ok('짧은 번호는 거부', threw);
  }
  {
    const db = { query: async (sql, params) => {
      if (/FROM blacklist b/.test(sql)) return { rows: [{ name: '홍길동', reason: '', added_by: '', added_at: null, digits: '01010101234', p8: '10101234' }] };
      if (/FROM app_settings/.test(sql)) return { rows: [] };
      if (/FROM review_index/.test(sql)) throw new Error('집계 죽음');
      return { rows: [] };
    } };
    const out = await svc.listGlobalBlacklist('c1', db);
    ok('목록: 연락처는 뒤4자리 마스킹', out[0].phoneMasked === '***-1234' && out[0].inGlobalBlacklist === true);
    ok('★ 이력 집계 실패 = fail-soft("조회 실패" 표기, 목록은 나간다)', out[0].history.level === 'unknown');
  }

  // ── D. 라우터 ──
  console.log('\n[D] 라우터 (trackB)');
  const trackB = require('../src/routes/trackB.routes');
  {
    const r = trackB.stack.filter(l => l.route).find(l => l.route.path === '/reviewers/blacklist' && l.route.methods.post);
    ok('POST /reviewers/blacklist 등록 + 권한 체인 3단(auth→adminOrMaster→핸들러)', !!r && r.route.stack.length >= 3);
  }
  ok('/reviewers 주석은 fail-soft + statsUnavailable(0으로 꾸미지 않음 — 088 규율)',
    /statsUnavailable = true;[\s\S]{0,200}블랙리뷰어 주석 집계 실패\(fail-soft\)/.test(trackBSrc));
  ok('/reviewers 검색에 등록 계좌번호 부분일치 추가', /bank_account[\s\S]{0,80}LIKE \$\$\{params\.length\}/.test(trackBSrc)
    || /COALESCE\(bank_account,''\),'\[\^0-9\]','','g'\) LIKE/.test(trackBSrc));
  ok('flag 필터 4종(blacklist/available/candidate/overdue)', /'blacklist' \|\| flag === 'available'/.test(trackBSrc)
    && /'candidate' \|\| flag === 'overdue'/.test(trackBSrc));
  ok('★ overdue 필터는 미작성 승격분 제외(상하한 양쪽)', /AND os\.submitted_at >= NOW\(\) - \(\$\$\{params\.length\} \|\| ' days'\)::interval/.test(trackBSrc));
  ok('reviewer-gate 응답에 globalBlacklist — 조회 실패는 **필드 미동봉**(빈 배열로 "0명" 위장 금지)',
    /globalBlacklist = await listGlobalBlacklist/.test(trackBSrc)
    && /\.\.\.\(globalBlacklist \? \{ globalBlacklist \} : \{\}\)/.test(trackBSrc));

  // ── E. 프론트(등록리뷰어DB) ──
  console.log('\n[E] 프론트 — 등록리뷰어DB');
  ok('신규 3열(누적참여·이전 리뷰·참여설정)', /<th style="width:92px">누적참여<\/th>/.test(wdk)
    && />이전 리뷰<\/th>/.test(wdk) && />참여설정<\/th>/.test(wdk));
  ok('RV_COLSPAN = 17(홈 링크+13+3 — 타계정 펼침행 colspan 어긋나면 표가 무너진다)', /const RV_COLSPAN = 17;/.test(wdk));
  {
    const body = wdk.slice(wdk.indexOf('async function _rvBlkToggle'), wdk.indexOf('async function _rvBlkToggle') + 1600);
    ok('★ 토글 = 즉시 적용(확인창 없음 — 사용자 확정)', !/confirm\(/.test(body));
    ok('★ 실패 시 낙관 반영 롤백(화면·서버 불일치 잔존 금지)', /el\.classList\.toggle\('on', !toOn\)/.test(body));
    ok('토글 onclick 은 배열 인덱스만(XSS 규율)', /_rvBlkToggle\(\$\{i\},this\)/.test(wdk));
    ok('body 는 JSON.stringify(api 헬퍼 계약)', /JSON\.stringify\(\{ phone:r\.phone, on:toOn, reason \}\)/.test(body));
  }
  ok('★ 집계 실패 = "집계 실패 ?"(0건·정상으로 꾸미지 않음)', (wdk.match(/집계 실패 \?/g) || []).length >= 2);
  ok('★ 후보·블랙리스트 행 배경색 없음(사용자 확정 — cand/blk 행 클래스 부재)',
    !/tr class="\$\{[^}]*cand/.test(wdk) && !/class="rvsq/.test(wdk.match(/<tr>[\s\S]{0,100}c-nm/) ? '' : ''));
  ok('이름 옆에는 안정적인 소유자 코드만 표시(상태·블랙리스트 배지 금지)',
    /<td class="c-nm" style="font-weight:700">\$\{esc\(r\.name\|\|''\)\}\$\{r\.reviewerNo!=null\?/.test(wdk)
    && /title="소유자 코드/.test(wdk));
  ok('필터 칩 5종 + 단일 진입점 _rvSetFlag', /_rvSetFlag\('\$\{f\}'\)/.test(wdk)
    && /\['candidate','🚨 후보 \(미작성 1건↑\)'\]/.test(wdk));
  ok('검색 안내에 계좌번호와 실시간 검색 방식 포함', /이름 \/ 연락처 \/ 계좌번호 실시간 검색/.test(wdk));
  ok('★ 엑셀 다운로드 없음(Q4 — 등록리뷰어DB 화면에 다운로드 버튼 부재)',
    !/엑셀 다운로드|download.*csv/i.test(wdk.slice(wdk.indexOf('function _renderRvHead'), wdk.indexOf('const RV_COLSPAN'))));

  // ── F. 프론트(공고별 팝업 — 후속조치 Q1=B) ──
  console.log('\n[F] 프론트 — 공고별 팝업 블랙리스트 자동 표시');
  ok('globalBlacklist 를 표 맨 위에 병합(front.concat)', /S\.items = front\.concat\(S\.items\)/.test(modal));
  ok('★ 필드 부재(조회 실패·구버전) = 구역 미표시 — Array.isArray 게이트', /Array\.isArray\(j\.globalBlacklist\)/.test(modal)
    && /Array\.isArray\(d\.globalBlacklist\)/.test(modal));
  ok('조회 실패 시 "표시 안 됨" 고지(무신호 금지)', /전역 블랙리스트 조회 실패 — 표시 안 됨/.test(modal));
  {
    const body = modal.slice(modal.indexOf('function _blockAll'), modal.indexOf('function _blockAll') + 900);
    ok('★ [모두 차단]은 사람이 정한 허용 예외(allow)를 덮지 않는다', /mode === 'block' \|\| mode === 'allow'\) return/.test(body));
    ok('[모두 차단]도 스테이징 → [선택 적용] confirm 경유(즉시 서버 반영 아님)', !/_post\(/.test(body));
  }
  ok('팝업 CSV 제거(Q4)', !/_csv/.test(modal));

  // ── G. 설정 패널 문구(재정의 반영) ──
  console.log('\n[G] 설정 패널');
  ok('기본값 문구 30/14 + 승격 설명', /리뷰미작성 판정 일수 \(기본 30\)/.test(settings)
    && /기한경과 판정 일수 \(기본 14\)/.test(settings) && /미작성으로 승격/.test(settings));
  ok('로더 폴백도 30(빈 값≠14 옛값 잔존 금지)', /n\.value = c\.nowriteDays \|\| 30;/.test(settings));

  console.log(`\n✅ reviewerDbBlacklist: ${passed}개 통과`);
  process.exit(0);   // trackB.routes require 가 pool 핸들을 연다(레포 관용구)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
