/**
 * sheetlessBadge.test.js — 탈 구글시트 W3-b(A) 회귀가드: 무시트 표시 · 죽은 시트링크 제거
 * 실행: node tests/sheetlessBadge.test.js
 *
 * 고정하는 것:
 *  A. 서버가 재료를 싣는다 — 화면 3곳(홈 목록·업체관리·반영 점검)이 쓸 `sheetless` 플래그
 *  B. 광고주 렌즈는 화이트리스트 재구성 — 표시용 `sheetless` 한 칸만 허용
 *     (2026-08-23 사용자 확정: 무시트 작업에는 시트 제목 라벨을 그리지 않는다. 업체 화면도
 *      같은 규칙이라 그 판정 재료가 필요하다 — 무시트 여부는 표시용 불리언이고 내부 정보가
 *      아니다. **다른 내부 필드는 여전히 폐기**하고 스프레드 재구성도 계속 금지한다.)
 *  C. 무시트 = 죽은 링크를 만들지 않는다 — 반영 점검 tabUrl null + 사유
 *  D. 배지 렌더러는 한 벌 — 정의 1 · 호출 3, "모르면 안 그린다"
 *  E. 공고 카드 시트 버튼 — 가상 시트ID 접두 사본 일치 + 무시트면 구글 URL 미생성
 *  F. 업체 링크 일원화 — 리뷰웹시스템[3버전] 화면에 구글시트 링크 0
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readFe = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
// ⚠ 블록 주석 정규식으로 주석을 지우면 이 레포의 정규식 리터럴을 물어 파일이 통째로 사라진다(실측).
//    줄 주석만 지운다.
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }
async function oka(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

/* ══════════════ A. 서버가 재료를 싣는다 ══════════════ */
console.log('\n[A] 서버가 sheetless 플래그를 화면 재료로 싣는다');

(async () => {
  /* A-1. 홈 작업목록·작업보드 = participants.listActiveTabs */
  {
    const participants = require('../src/services/participants.service');
    let sql = '';
    participants.__setPoolForTest
      ? participants.__setPoolForTest({ query: async (s) => { sql = String(s); return { rows: [] }; } })
      : null;
    if (participants.__setPoolForTest) {
      await participants.listActiveTabs({ limit: 10 });
      participants.__setPoolForTest(null);
    } else {
      sql = read('src/services/participants.service.js');
    }
    ok('listActiveTabs 가 sheetless 를 함께 읽는다', /COALESCE\(tc\.sheetless,\s*FALSE\)\s+AS\s+"sheetless"/i.test(sql));
    ok('★ tab_configs 는 (sheet_id, tab_name) 로 조인한다(행 증식 없음)',
      /LEFT JOIN tab_configs tc ON tc\.sheet_id = rst\.sheet_id AND tc\.tab_name = rst\.tab_name/i.test(sql));
  }

  /* A-2. 업체관리 연결탭 표 = ownedTabsForAdvertiser */
  {
    const src = read('src/services/trackB.service.js');
    const body = src.slice(src.indexOf('async function ownedTabsForAdvertiser'),
      src.indexOf('async function ownedTabsForAdvertiser') + 4000);
    ok('ownedTabsForAdvertiser 가 sheetless 를 싣는다', /COALESCE\(tc\.sheetless,\s*FALSE\)\s+AS\s+"sheetless"/i.test(body));
    // 이 함수는 이미 tab_configs 를 조인하고 있어야 한다 = 쿼리 순증 0(폴더 버튼 규율과 같다)
    ok('★ 쿼리 순증 0 — tab_configs 조인은 이미 있던 것을 쓴다', /JOIN tab_configs tc/i.test(body));
  }

  /* A-3. 반영 점검(sheet-sync audit) */
  {
    const src = read('src/services/sheetSyncAudit.service.js');
    ok('auditSheetSync 본 쿼리가 sheetless 를 싣는다',
      /COALESCE\(tc\.sheetless,\s*FALSE\)\s+AS\s+"sheetless"/i.test(src));
  }

  /* ══════════════ B. 광고주에게는 안 나간다 ══════════════ */
  console.log('\n[B] 광고주 렌즈 = 화이트리스트 재구성 (표시용 sheetless 한 칸만)');
  {
    const src = read('src/services/trackB.service.js');
    const i = src.indexOf('async function advertiserWorkSummary');
    assert(i > 0, 'advertiserWorkSummary 를 찾지 못함');
    const body = src.slice(i, src.indexOf('\n}', src.indexOf('items: tabs.map')) + 2);
    ok('★ 표시용 sheetless 한 칸(시트 제목 라벨 숨김 재료) — 이것 말고는 없다',
      /sheetless: t\.sheetless === true,/.test(body)
      && noLineComments(body).split('sheetless').length - 1 === 2);   // 키 + 값 참조 1쌍뿐
    // 렌즈가 화이트리스트가 아니라 스프레드(...t)로 바뀌면 이 검사는 무의미해진다 → 그 형태를 금지
    ok('★ 광고주 항목을 스프레드로 만들지 않는다(화이트리스트 유지)',
      !/items:\s*tabs\.map\([^)]*=>\s*\(\{\s*\.\.\./.test(body));
  }

  /* ══════════════ C. 무시트 = 죽은 링크를 만들지 않는다 ══════════════ */
  console.log('\n[C] 무시트 작업에는 구글시트 링크를 만들지 않는다');
  {
    const svc = require('../src/services/sheetSyncAudit.service');
    const base = {
      sheetId: 'S1', tabName: 'T', displayName: 'T', campaignName: null,
      registeredAt: '2026-07-01T00:00:00Z', rawRows: 10, mirroredAt: 'x', mirrorTabName: 'T', mirrorGid: '77',
      idxStatus: 'active', idxBuiltAt: 'x', idxErrorMsg: null, indexRows: 5, boardRows: 5,
      lastOrderAt: '2026-07-02T00:00:00Z',
    };
    svc.__setPoolForTest({
      query: async () => ({ rows: [
        { ...base, tabName: 'sheet-based', displayName: 'sheet-based', tabGid: '77', sheetless: false },
        { ...base, sheetId: 'wt_deadbeef', tabName: 'sheetless-new', displayName: 'sheetless-new', tabGid: '900001', sheetless: true },
        // 이관된 기존 작업 = **진짜 시트 ID** 를 그대로 쓰면서 무시트가 된다(모양으로는 못 잡는 케이스)
        { ...base, sheetId: 'S9', tabName: 'sheetless-migrated', displayName: 'sheetless-migrated', tabGid: '78', sheetless: true },
      ] }),
    });
    // ★ 무시트는 이제 기본 제외(점검 대상 아님 — sheetSyncAudit.test.js §10)라 여기서는
    //   `includeSheetless` 로 열어서 본다. 이 절의 검사 의미(무시트에는 시트 링크를 만들지 않는다)는 불변.
    const out = await svc.auditSheetSync({ before: null, includeUnknown: true, includeSheetless: true });
    svc.__setPoolForTest(null);
    const byName = new Map(out.items.map(i => [i.tabName, i]));

    await oka('시트 기반 작업은 종전대로 구글시트 링크가 나온다(무회귀)', async () => {
      const r = byName.get('sheet-based');
      assert(r, 'sheet-based 누락');
      assert(/^https:\/\/docs\.google\.com\//.test(String(r.tabUrl || '')), '시트 링크가 사라졌다');
      assert.strictEqual(r.sheetless, false);
    });
    await oka('★ 무시트(가상 ID) 작업은 tabUrl 이 null 이고 sheetless=true 로 사유를 말한다', async () => {
      const r = byName.get('sheetless-new');
      assert(r, 'sheetless-new 누락');
      assert.strictEqual(r.tabUrl, null, '죽은 구글 링크가 만들어졌다');
      assert.strictEqual(r.sheetless, true);
    });
    await oka('★★ 이관된 기존 작업(진짜 시트 ID)도 링크를 만들지 않는다 — 판정은 플래그이지 ID 모양이 아니다', async () => {
      const r = byName.get('sheetless-migrated');
      assert(r, 'sheetless-migrated 누락');
      assert.strictEqual(r.tabUrl, null, 'ID 모양으로만 판정하면 이 케이스가 뚫린다');
      assert.strictEqual(r.sheetless, true);
    });
  }

  /* ══════════════ D. 무시트 배지 제거(사용자 확정 2026-08-23) ══════════════ */
  console.log('\n[D] 「무시트」 배지 — 목록·작업보드·업체관리에서 제거됨');
  {
    const wd = readFe('workdesk.html');
    /* ★★ 활성 작업이 **전부 무시트**라(본섭 실측: 114 중 113, 나머지 1건은 마감) 모든 줄에
       붙는 상시 표기가 되어 신호 구실을 못 했다 → 세 화면에서 제거.
       ★ 되살릴 때는 "무시트면 뜬다"가 아니라 **"시트 기반이면 뜬다"** 로 뒤집을 것 —
         그래야 희귀 케이스가 눈에 띈다(지금 그 일은 그리드 배지·시트 제목 라벨이 한다). */
    ok('★ 렌더러·호출 전부 제거(되붙이면 상시 표기로 되돌아간다)',
      !/_nsBadge/.test(noLineComments(wd).replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('★ 판정 단일 출처 `_isNoSheet` 는 남는다 — 시트 제목 라벨 숨김·목록·경고가 쓴다',
      /function _isNoSheet\(t\)\{ return !!\(t && t\.sheetless===true\); \}/.test(wd)
      && (wd.match(/_isNoSheet\(/g) || []).length >= 8);
    ok('★ 서버 재료(`sheetless`)는 그대로 — 배지만 뺐지 판정을 없앤 게 아니다',
      /sheetless/.test(read('src/services/trackB.service.js')));
    /* ★ `.ns-b` CSS 와 「무시트」 문구는 **탈시트 전환 화면(`_coRows`)** 이 계속 쓴다 —
       그 화면에서는 "이관됐다/아니다"가 곧 주제라 배지가 신호로 작동한다. */
    ok('★ 탈시트 전환 화면의 무시트 표시는 남는다(그 화면의 주제다)',
      /t\.sheetless\?'<span class="ns-b">무시트<\/span>':''/.test(wd) && /\.ns-b\{/.test(wd));
  }

  /* ══════════════ E. 공고 카드 — 시트 흔적 0 ══════════════ */
  console.log('\n[E] 모집공고 카드 — 죽은 시트 링크도, 시트 연결 표기도 없다 (사용자 확정 2026-08-19)');
  {
    // ⚠ 검사 의미 갱신: 카드의 [시트] 버튼이 제거되어(업체 링크 일원화) 이제 검사할 것은
    //   "카드가 구글시트 URL 을 조립하지 않는다"는 **더 강한 불변식** 하나다.
    //   버튼을 되살리려면 무시트 분기(가상 ID·sheetless 플래그)를 함께 되살려야 한다.
    const cc = readFe('js/campaign-cards.js');
    ok('★ 카드는 구글시트 URL 을 조립하지 않는다(무시트 작업의 죽은 링크 원천 차단)',
      !/docs\.google\.com\/spreadsheets/.test(cc));
    ok('★ "시트 탭 미연결" 안내를 그리지 않는다 — 무시트라 연결할 시트탭이 없다',
      !/시트 탭 미연결/.test(cc));
    ok('★ 연결 탭 이름 줄(sp-link)도 그리지 않는다', !/<div class="sp-link">/.test(cc));
    ok('★ 가상 시트ID 접두 사본이 남아 있지 않다(판정에 쓰지 않는다)',
      !/_VIRTUAL_SHEET_PREFIX/.test(cc));
  }

  /* ══════════════ F. 업체 링크 일원화 ══════════════ */
  console.log('\n[F] 리뷰웹시스템[3버전] 화면에는 구글시트 링크가 없다 (업체 링크 일원화)');
  {
    // ★ placeholder 는 링크가 아니라 **붙여넣을 자리 안내**다(작업 가져오기 마법사의 시트 주소 입력칸) —
    //   그것까지 세면 "사람이 주소를 가져오는" 정상 창구가 이 가드에 걸린다. 링크 조립만 센다.
    const wd = noLineComments(readFe('workdesk.html'))
      .replace(/placeholder="[^"]*"/g, '').replace(/placeholder='[^']*'/g, '');
    const hits = (wd.match(/https:\/\/docs\.google\.com/g) || []).length;
    ok('★ workdesk.html 에 구글시트 직링크 0 — 광고주·내부 모두 리뷰웹 화면에서 끝낸다', hits === 0);
  }

  /* ══════════════ G. 반영 점검 화면 배선 ══════════════ */
  console.log('\n[G] 반영 점검 화면 — 무시트는 링크 대신 배지');
  {
    const html = readFe('sheet-sync-audit.html');
    ok('tabLink 가 sheetless 를 먼저 보고 배지를 그린다', /it\.sheetless === true.*무시트/s.test(html));
    ok('★ 링크 렌더는 여전히 docs.google.com 호스트 검증 뒤에만(신뢰 베이스 재구성)',
      /\/\^https:\\\/\\\/docs\\\.google\\\.com\\\//.test(html));
    ok('배지 CSS 가 있다', /\.ns-b \{/.test(html));
  }

  console.log(`\n✅ sheetlessBadge: ${passed} cases passed`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
