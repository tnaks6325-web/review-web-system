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
    const start = src.indexOf('async function ownedTabsForAdvertiser');
    const end = src.indexOf('\nasync function ', start + 10);
    const body = src.slice(start, end > start ? end : src.length);
    ok('ownedTabsForAdvertiser 가 sheetless 를 싣는다', /COALESCE\(tc\.sheetless,\s*FALSE\)\s+AS\s+"sheetless"/i.test(body));
    // 이 함수는 이미 tab_configs 를 조인하고 있어야 한다 = 쿼리 순증 0(폴더 버튼 규율과 같다)
    ok('★ 쿼리 순증 0 — tab_configs 조인은 이미 있던 것을 쓴다', /JOIN tab_configs tc/i.test(body));
  }

  /* (A-3. 반영 점검 sheetSyncAudit 는 결정 186 77번에서 제거) */

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

  /* (C. 반영 점검 화면의 시트 링크 판정 — sheetSyncAudit 제거(결정 186 77번)로 대상 소멸) */

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
    /* ★ `.ns-b` 를 쓰던 유일한 곳(탈시트 전환 화면 `_coRows`)이 2026-09-28 제거됐다(결정 186 2번) —
       배지 CSS 도 함께 뺐다. 되살아나면 쓰는 곳 없는 CSS 이거나 상시 표기의 부활이다. */
    ok('★ 무시트 배지(.ns-b)는 CSS·마크업 모두 없다(주석 제외)',
      !/\bns-b\b/.test(noLineComments(wd).replace(/\/\*[\s\S]*?\*\//g, '')));
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

  /* (G. 반영 점검 화면 sheet-sync-audit.html 은 결정 186 77번에서 제거) */

  console.log(`\n✅ sheetlessBadge: ${passed} cases passed`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
