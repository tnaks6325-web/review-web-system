/**
 * sheetImport.service.js — 구글시트 주소로 작업 가져오기 (탈 구글시트 잔재 처리)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 하는 일 = **시스템이 모르는 시트를 한 건씩 흡수한다**
 *
 *   증상(2026-08-10 실측 · 0720수진코리아 고양이캔 4종):
 *     시트에는 108명이 적혀 있고 맨 윗줄에 "리뷰웹시스템으로 이관되었습니다"라고 쓰여 있는데,
 *     정작 리뷰웹시스템에는 그 작업이 **없다**. 시트를 본 사람은 시스템에 오고, 시스템에서
 *     못 찾아 시트로 돌아가면 "여기 보지 마세요"가 적혀 있다 — 어느 쪽에서도 일할 수 없다.
 *
 *   원인 3겹: ① 접수를 거치지 않아 `tab_configs` 미등록 ② 업체 소유 미지정
 *            ③ 내용이 시스템 표로 옮겨진 적 없음 → 이 서비스가 셋을 한 번에 처리한다.
 *
 * ★★ 사본 0 — 판정·실행은 전부 기존 부품을 그대로 쓴다:
 *   · 헤더 탐지  = `utils/sheetHeader.detectSheetHeader`(인덱스 빌더와 같은 함수)
 *   · 열 역할    = `utils/worktableTemplate.classifyHeaders`(매퍼 파생 — 키워드 표 복사 금지)
 *   · 줄 생성    = `participants.createSlotsFromSheetRows`(쓰기 소유자 규율)
 *   · 장부 3권   = `sheetlessLedger.rebuildLedgers`(→ `indexBuilder.parseTabRows` 그대로 통과)
 *   · 업체 소유  = `trackB.setOwnership` · 시트 안내문 = `sheetNotice.applySheetNotice`
 *   이 파일이 새로 만드는 판정은 **"어느 줄을 가져오는가" 하나뿐**이다.
 *
 * ★★ 등록 창구가 하나 는다 — 명시적으로 인정한 예외다.
 *   `TAB_REGISTRATION_MODE='order'` 규율상 신규 탭 등록 창구는 접수 하나였다. 이 경로는
 *   **복원 성격**(아카이브 복구·DB 재구축과 같은 분류)이라 게이트를 우회하되 조건을 건다:
 *     ① adminOrMaster 전용  ② 업체 지정 필수(D3)  ③ 자동 발견·일괄 실행 없음(사람이 주소를 하나씩)
 *     ④ 수행자·시각을 로그와 `sheetless_by` 에 남김
 *   `allowManualRegister()` 를 완화하지 말 것 — 그 스위치는 다른 창구(작업시트추가)의 것이다.
 *
 * ★★ 미리보기는 **DB 쓰기 0**(시트만 1회 읽는다). 그래서 "이 시트에 뭐가 들었나"를 확인하는
 *   도구로 먼저 쓸 수 있다. 무언가가 만들어지는 것은 `importSheet` 뿐이다.
 *
 * 사용자 확정(2026-08-10) D1~D6:
 *   D1 즉시 끊기(무시트 표식 ON + 안내문 갱신) · D2 모집공고 미생성 · D3 업체 필수
 *   D4 제출·입금 표시 그대로 이월 · D5 이미 등록된 탭은 차단 · D6 가져온 직후 되돌리기
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { classifyHeaders } = require('../utils/worktableTemplate');

let _pool = null;
function _db() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 화면이 사유를 구분해 말할 수 있게 코드를 붙인다(errorHandler 500 마스킹 방지 — 라우트가 400대로 매핑). */
class ImportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ── 상한 — 오붙여넣기·거대 시트로 한 번에 수만 줄이 들어오는 것을 막는다 ── */
const MAX_ROWS = 2000;          // `createSlotsFromSheetRows` 와 같은 상한
const PREVIEW_SAMPLE = 12;      // 화면에 실제로 그려 주는 대표 줄 수

/* ═══════════════════════════════════════════════════════════════════
   ① 주소 해석 — 순수함수
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 구글시트 주소에서 시트ID와 gid를 뽑는다.
 * ★ gid 는 `#gid=` · `?gid=` · `&gid=` 어디에 있어도 읽는다(브라우저가 주소창에 넣는 형태가 제각각).
 * ★ 시트ID 만 준 경우(주소가 아니라 ID를 붙여넣음)도 받는다 — 사람이 무엇을 붙여넣을지 모른다.
 * @returns {{sheetId:string|null, gid:string|null}}
 */
function parseSheetUrl(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { sheetId: null, gid: null };

  let sheetId = null;
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) sheetId = m[1];
  else if (/^[A-Za-z0-9_-]{20,}$/.test(s)) sheetId = s;      // ID 단독 붙여넣기

  let gid = null;
  const g = s.match(/[#?&]gid=(\d+)/);
  if (g) gid = g[1];

  return { sheetId, gid };
}

/* ═══════════════════════════════════════════════════════════════════
   ② 표 판독 — 순수함수 (시트에서 읽어 온 2차원 배열만 본다)
   ═══════════════════════════════════════════════════════════════════ */

/** 값이 하나라도 있는 줄인가 */
function _hasAny(cells) {
  return (cells || []).some(c => String(c == null ? '' : c).trim() !== '');
}

/** 연락처에서 숫자만 남긴 뒤 뒤 8자리 — `columnResolver` 와 같은 성질(표시·판정용) */
function _phone8(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

/**
 * 시트 위쪽 안내 줄에서 작업 이름·상품 주소를 읽는다(헤더 줄 **위**만 본다).
 *
 * 실측 형태: `캠페인명 | 0720수진코리아 …` / `구매시간대 | 자유 | https://…coupang…`
 * ★ 못 찾으면 **빈 값**으로 둔다(추측 금지) — 화면이 사람에게 채우게 한다.
 */
function readTopMeta(values, headerRow) {
  const out = { campaignName: '', buyTime: '', productUrl: '' };
  const top = (values || []).slice(0, Math.max(0, (headerRow || 1) - 1));
  for (const raw of top) {
    const cells = normalizeCells(raw);
    const label = String(cells[0] || '');
    const rest = cells.slice(1).filter(v => v !== '');
    if (!out.campaignName && /캠페인\s*명|작업\s*명/.test(label) && rest[0]) out.campaignName = rest[0].slice(0, 200);
    if (!out.buyTime && /구매\s*시간|시간대/.test(label) && rest[0]) out.buyTime = rest[0].slice(0, 100);
    if (!out.productUrl) {
      const url = cells.find(c => /^https?:\/\//i.test(c));
      if (url) out.productUrl = url.slice(0, 500);
    }
  }
  return out;
}

/**
 * ★★ 이 파일이 새로 만드는 유일한 판정 = **어느 줄을 가져오는가**.
 *
 * 규칙(사용자 확정):
 *   · 이름·연락처가 있는 줄            → 가져옴
 *   · 번호가 없어도 내용이 있는 줄      → **가져옴**(번호를 안 매겼을 뿐 실제 진행 건 — 실측 8줄)
 *   · 연습으로 보이는 줄               → **체크만 해제**(숨기거나 지우지 않는다 — 진짜 참여자를
 *                                       시스템이 마음대로 버리면 사람이 사라진다)
 *   · 완전히 빈 줄                     → 자리만 만든다(명단에는 파서가 안 넣는다)
 *
 * ★ 연습 줄 판정은 **좁게**: 이름이 1글자 이하이거나 연락처가 8자리 미만인 줄만.
 *   넓히면 멀쩡한 참여자가 기본 제외되어 조용히 누락된다(오탐 > 미탐).
 */
function classifyImportRows({ headers, values, headerRow, nameIdx, phoneIdx }) {
  const rows = [];
  let named = 0, suspect = 0, blank = 0;

  for (let i = headerRow; i < (values || []).length; i++) {   // headerRow 는 1-based → 그 다음 줄부터
    const cells = normalizeCells(values[i] || []);
    const seq = i + 1;                                        // ★ 시트 실제 행 번호 = 작업표 seq
    if (!_hasAny(cells)) { blank++; rows.push({ seq, blank: true, include: true }); continue; }

    const name = nameIdx >= 0 ? String(cells[nameIdx] || '').trim() : '';
    const phoneRaw = phoneIdx >= 0 ? String(cells[phoneIdx] || '').trim() : '';
    const p8 = _phone8(phoneRaw);

    let why = '';
    if (name && name.length <= 1) why = '이름이 한 글자입니다';
    else if (name && !p8) why = '연락처를 알아볼 수 없습니다';
    const include = !why;

    if (name) named++;
    if (why) suspect++;

    // row_json = 헤더명 → 값 (import 경로와 같은 모양 — 그리드가 그대로 그린다)
    const rowJson = {};
    for (let c = 0; c < headers.length; c++) {
      const h = String(headers[c] || '').trim();
      if (!h) continue;
      const v = cells[c];
      if (v !== undefined && v !== '') rowJson[h] = v;
    }

    rows.push({ seq, name, phone: phoneRaw, phone8: p8, include, why, rowJson, cells });
  }

  return { rows, counts: { total: rows.length, named, suspect, blank } };
}

/* ═══════════════════════════════════════════════════════════════════
   ③ 시트 읽기 — 실제 API (미리보기·실행이 같은 함수를 쓴다)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 그 시트의 탭 하나를 읽어 온다.
 * ★ **FORMATTED_VALUE** — 미러와 같은 옵션이라야 `7 / 20 (월)` 같은 날짜 표기가 그대로 보존된다
 *   (UNFORMATTED 로 읽으면 직렬숫자가 되어 시트 일정·구매일자 표시가 통째로 달라진다).
 * ★ 시트 lane throttle 경유 — 주문 쓰기 슬롯을 굶기지 않는다.
 */
async function _readTab(sheetId, gid) {
  const { getSpreadsheetMeta, batchReadSheet } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');

  const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
  const tabs = (meta || []).filter(s => s && s.properties);
  if (!tabs.length) throw new ImportError('no_tabs', '이 시트에서 탭을 찾지 못했습니다.');

  const available = tabs.map(t => ({
    gid: String(t.properties.sheetId),
    tabName: t.properties.title,
    hidden: !!t.properties.hidden,
  }));

  /* ★ gid 를 준 경우 **그 gid 로만** 찾는다 — 이름으로 폴백하지 않는다.
     탭을 지웠다 다시 만들면 gid 가 바뀌므로, 이름 폴백은 **엉뚱한 탭을 가져오는** 사고가 된다
     (작업오더 접수의 "자동 이름매칭 폴백 금지"와 같은 규율). 못 찾으면 목록을 돌려주고 사람이 고른다. */
  const target = gid ? available.find(t => t.gid === String(gid)) : null;
  if (gid && !target) {
    const e = new ImportError('gid_not_found', '주소가 가리키는 탭을 이 시트에서 찾지 못했습니다 — 아래에서 골라 주세요.');
    e.availableTabs = available;
    throw e;
  }
  if (!gid) {
    const e = new ImportError('gid_required', '어느 탭을 가져올지 골라 주세요.');
    e.availableTabs = available;
    throw e;
  }

  const [vr] = await throttledCall(() =>
    batchReadSheet(sheetId, [`'${target.tabName}'!A:ZZ`], 'FORMATTED_VALUE'));
  const values = (vr && vr.values) || [];

  return {
    sheetTitle: meta._spreadsheetTitle || sheetId,
    tabName: target.tabName, gid: target.gid, values, availableTabs: available,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ④ 미리보기 — DB 쓰기 0
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 주소를 받아 "무엇을 가져올지"를 돌려준다. **저장하는 것이 없다.**
 * @returns {{ok, sheetId, gid, tabName, headers, columns, meta, rows, counts, blockers, warnings }}
 */
async function previewSheetImport({ url = '', sheetId: sidIn = '', gid: gidIn = '' } = {}) {
  const fromUrl = parseSheetUrl(url);
  const sheetId = String(sidIn || fromUrl.sheetId || '').trim();
  const gid = String(gidIn || fromUrl.gid || '').trim();
  if (!sheetId) throw new ImportError('bad_url', '구글시트 주소를 알아보지 못했습니다 — 주소창을 통째로 붙여넣어 주세요.');

  const read = await _readTab(sheetId, gid);
  const det = detectSheetHeader(read.values);

  const blockers = [];
  const warnings = [];

  if (!det.headers || !det.headerRowIndex) {
    return {
      ok: false, sheetId, gid: read.gid, tabName: read.tabName, sheetTitle: read.sheetTitle,
      availableTabs: read.availableTabs,
      blockers: [{ code: 'header_unrecognizable',
        message: '이 탭에서 표의 머리글 줄을 찾지 못했습니다 — 이름·연락처 같은 열 이름이 있는지 확인해 주세요.' }],
      warnings: [], rows: [], counts: { total: 0, named: 0, suspect: 0, blank: 0 },
    };
  }

  const headers = det.headers;

  /* ★★ 명단이 실제로 몇 명이 되는지는 **파서에게 물어본다** — 여기서 세면 사본이 되고,
     이름열 우선순위·제출/입금 판정이 갈려 "미리보기 107명인데 가져오니 92명"이 된다.
     장부 생성기가 쓰는 바로 그 함수(`indexBuilder.parseTabRows`)를 같은 입력으로 돌린다.
     ★ DB 는 **읽기만**(키워드·컬럼매핑) — 미리보기의 "쓰기 0" 약속은 그대로다. */
  const parsed = await _parseWithIndexBuilder({ values: read.values, sheetId, tabName: read.tabName, gid: read.gid });

  /* 상태 칸(리뷰제출·입금)은 탭 설정이 진실원본이지만 아직 등록 전이라 설정이 없다 →
     파서가 그 탭에서 실제로 고른 열 이름을 넘겨 역할 표시를 맞춘다(같은 판정, 사본 0). */
  const roles = classifyHeaders(headers, {
    submitCol: parsed.submitCol || '', submitCol2: parsed.submitCol2 || '',
  });
  const idxOf = (role) => roles.findIndex(r => r && r.role === role);
  const phoneIdx = idxOf('phone');
  const nameIdx = idxOf('recipient') >= 0 ? idxOf('recipient') : idxOf('orderer');

  /* ★★ fail-closed — 연락처 칸이 없으면 **가져오지 않는다**.
     그 명단은 리뷰어가 자기 참여 내역을 영영 찾을 수 없는 명단이 된다(검색 키가 phone8 이다).
     숫자만 채워 넣고 "옮겼다"고 말하는 쪽이 훨씬 나쁘다. */
  if (phoneIdx < 0) {
    blockers.push({ code: 'no_phone_column',
      message: '연락처 칸을 찾지 못했습니다 — 연락처가 없으면 리뷰어가 자기 참여 내역을 찾을 수 없습니다.' });
  }
  if (nameIdx < 0) {
    warnings.push({ code: 'no_name_column',
      message: '이름 칸을 알아보지 못했습니다 — 명단이 비어 보일 수 있습니다.' });
  }

  const cls = classifyImportRows({ headers, values: read.values, headerRow: det.headerRowIndex, nameIdx, phoneIdx });
  /* ★ "가져올 내용이 있는가"의 기준도 파서 결과다 — 우리가 센 이름 수와 갈리면 파서 쪽이 맞다.
     ★★ 단 **파서를 못 돌린 경우(null)는 0으로 접지 않는다** — 조회 실패를 "내용 없음"으로
        말하면 멀쩡한 시트를 가져올 수 없다고 잘못 안내한다(모름 ≠ 없음). */
  if (parsed.count === 0 || (parsed.count == null && !cls.counts.named)) {
    blockers.push({ code: 'no_rows', message: '가져올 내용이 없습니다 — 이 탭에는 이름이 적힌 줄이 없습니다.' });
  }
  if (cls.rows.length > MAX_ROWS) {
    blockers.push({ code: 'too_many_rows',
      message: `줄이 너무 많습니다(${cls.rows.length}줄) — 한 번에 ${MAX_ROWS}줄까지만 가져올 수 있습니다.` });
  }
  if (cls.counts.suspect) {
    warnings.push({ code: 'suspect_rows',
      message: `연습으로 보이는 ${cls.counts.suspect}줄은 체크를 풀어 두었습니다 — 필요하면 다시 체크하세요.` });
  }

  /* ★★ D5 — 이미 등록된 탭. 단 **빈 껍데기면 통과**시키고(되살릴 길이 없어지면 안 된다),
     막을 때는 **어디에 있는지·왜 안 보이는지**를 함께 말한다(막다른 길 금지). */
  const dup = await _findRegistered(sheetId, read.tabName, read.gid);
  const dupJudge = classifyRegistered(dup);
  if (dup && dupJudge.blocked) {
    blockers.push({ code: 'already_registered',
      message: `이미 시스템에 있는 작업입니다 — ${dup.advertiserName ? dup.advertiserName + ' › ' : ''}${dup.tabName}`,
      reasons: dupJudge.reasons, tab: dup });
  } else if (dup && dupJudge.empty) {
    warnings.push({ code: 'registered_empty',
      message: `이 작업은 등록만 되어 있고 내용이 비어 있습니다(표 0줄) — 가져오면 그 등록을 그대로 채웁니다.`,
      reasons: dupJudge.reasons, tab: dup });
  }

  return {
    ok: !blockers.length,
    sheetId, gid: read.gid, tabName: read.tabName, sheetTitle: read.sheetTitle,
    availableTabs: read.availableTabs,
    headerRow: det.headerRowIndex,
    headers,
    columns: headers.map((h, i) => ({
      header: h,
      role: (roles[i] && roles[i].role) || null,
      label: (roles[i] && roles[i].label) || null,
      isName: i === nameIdx, isPhone: i === phoneIdx,
    })),
    meta: readTopMeta(read.values, det.headerRowIndex),
    /* counts.named = 우리가 센 "이름이 보이는 줄" · index = **파서가 만들 검색 명단 수**(정답).
       둘을 따로 보여주는 이유: 갈리면 그 차이가 곧 "파서가 못 읽는 줄"이라는 신호다. */
    counts: { ...cls.counts, index: parsed.count, submitted: parsed.submitted },
    statusCols: { submit: parsed.submitCol || null, paid: parsed.submitCol2 || null },
    rows: _sampleRows(cls.rows, {
      date: idxOf('dateStr'), price: idxOf('price'), submit: idxOf('submit'), paid: idxOf('paid'),
    }),
    blockers, warnings,
  };
}

/**
 * 장부 생성기와 **같은 파서**를 같은 입력으로 돌려 "가져오면 명단이 몇 명이 되는가"를 얻는다.
 * ★ fail-soft — 파서가 죽어도 미리보기 전체를 죽이지 않는다(그때는 우리가 센 수만 보여준다).
 */
async function _parseWithIndexBuilder({ values, sheetId, tabName, gid }) {
  try {
    const ib = require('./indexBuilder.service');
    try { await ib.loadKeywordsFromDB(); } catch (_) {}
    let dbColMap = null;
    try { dbColMap = await require('./columnMapping.service').getTabColumnIndexMap(sheetId, gid); } catch (_) {}
    const rows = ib.parseTabRows(values, sheetId, tabName, gid, tabName, dbColMap) || [];
    return {
      count: rows.length,
      submitted: rows.filter(r => r && r.isSubmitted).length,
      submitCol: (rows[0] && rows[0].submitCol) || '',
      submitCol2: (rows[0] && rows[0].submitCol2) || '',
    };
  } catch (e) {
    logger.warn(`[sheetImport] 명단 미리계산 실패 — ${(e && e.message) || e}`);
    return { count: null, submitted: null, submitCol: '', submitCol2: '' };
  }
}

/**
 * 화면에 그릴 대표 줄 — 앞쪽 몇 줄 + 체크 해제된 줄은 **전부**(사람이 판단해야 하므로).
 *
 * ★★ 표에 보여줄 값(구매일자·금액·제출·입금)은 **서버가 골라서 싣는다** — 열 이름이 탭마다 다르므로
 *   화면이 `row_json['리뷰제출']` 처럼 이름을 찍어 꺼내면 그 이름이 다른 탭에서 통째로 빈 칸이 된다.
 *   어느 칸인지는 이미 역할 판정이 알고 있으니 그 인덱스로 뽑는다(판정 사본 0).
 */
function _sampleRows(rows, idx) {
  const filled = rows.filter(r => !r.blank);
  const suspect = filled.filter(r => !r.include);
  const head = filled.filter(r => r.include).slice(0, PREVIEW_SAMPLE);
  const pick = head.concat(suspect.slice(0, 30));
  const at = (r, i) => (i >= 0 && r.cells ? String(r.cells[i] || '') : '');
  return pick.map(r => ({
    seq: r.seq, name: r.name, phone: r.phone, include: r.include, why: r.why || '',
    date: at(r, idx.date), price: at(r, idx.price), submit: at(r, idx.submit), paid: at(r, idx.paid),
    values: r.rowJson || {},
  }));
}

/**
 * 이미 등록된 탭인가 — 이름 또는 gid 로 찾는다(리네임으로 연결이 조용히 풀리는 것 방지).
 *
 * ★★ **"있다/없다"만으로는 막다른 길이 된다**(실사용 신고 2026-08-10): 등록은 돼 있는데
 *   업체관리·작업보드 어디에서도 못 찾는 상태가 실재한다. 그래서 **왜 안 보이는지**의 재료를
 *   함께 읽는다 — 작업 목록 노출 조건은 `tab_configs` 가 아니라
 *   **`raw_sheet_tabs`(미러) + `index_master`(등록부 active)** 이고(`listActiveTabs`),
 *   업체관리 표는 거기에 **업체 소유**까지 필요하다.
 * ★ 쿼리 1회(스칼라 서브쿼리) — 미리보기의 "읽기만" 성격을 유지한다.
 */
async function _findRegistered(sheetId, tabName, gid) {
  const g = String(gid || '');
  const { rows } = await _db().query(
    `SELECT tc.tab_name, tc.tab_gid, COALESCE(tc.sheetless, FALSE) AS sheetless,
            (SELECT a.name FROM advertiser_campaigns ac
               JOIN advertisers a ON a.id = ac.advertiser_id
              WHERE ac.sheet_id = tc.sheet_id AND ac.deleted_at IS NULL
                AND (ac.tab_gid IS NULL OR ac.tab_gid = tc.tab_gid)
              ORDER BY ac.tab_gid NULLS LAST LIMIT 1) AS advertiser_name,
            (SELECT COUNT(*) FROM campaign_participants cp
              WHERE cp.sheet_id = tc.sheet_id AND cp.tab_name = tc.tab_name AND cp.deleted_at IS NULL) AS board_rows,
            (SELECT COUNT(*) FROM campaign_participants cp
              WHERE cp.sheet_id = tc.sheet_id AND cp.tab_name = tc.tab_name AND cp.deleted_at IS NULL
                AND cp.order_submission_id IS NOT NULL) AS with_order,
            (SELECT COUNT(*) FROM review_index ri
              WHERE ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name) AS index_rows,
            EXISTS (SELECT 1 FROM index_master im
                     WHERE im.sheet_id = tc.sheet_id AND im.status = 'active'
                       AND (im.tab_name = tc.tab_name OR (COALESCE(tc.tab_gid,'') <> '' AND im.tab_gid = tc.tab_gid))) AS in_master,
            EXISTS (SELECT 1 FROM raw_sheet_tabs rst
                     WHERE rst.sheet_id = tc.sheet_id AND rst.is_system_tab = FALSE
                       AND (rst.tab_name = tc.tab_name OR (COALESCE(tc.tab_gid,'') <> '' AND rst.tab_gid = tc.tab_gid))) AS in_mirror
       FROM tab_configs tc
      WHERE tc.sheet_id = $1
        AND (tc.tab_name = $2 OR ($3 <> '' AND tc.tab_gid = $3))
      LIMIT 1`,
    [sheetId, tabName, g]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    tabName: r.tab_name, tabGid: r.tab_gid, sheetless: r.sheetless,
    advertiserName: r.advertiser_name || null,
    boardRows: Number(r.board_rows) || 0,
    withOrder: Number(r.with_order) || 0,
    indexRows: Number(r.index_rows) || 0,
    inMaster: !!r.in_master, inMirror: !!r.in_mirror,
  };
}

/**
 * ★★ 등록돼 있을 때 **막을지 / 통과시킬지**를 정하고, 막는다면 **왜 안 보이는지**를 말한다.
 *   판정 단일 출처 — 미리보기와 실행이 같은 함수를 쓴다(갈리면 "화면은 되는데 서버가 거부").
 *
 * · **빈 껍데기**(표 0줄 · 주문 0 · 명단 0) = 등록만 있고 내용이 없다 → **가져오기를 허용**한다.
 *   D5 가 막으려던 것은 "그동안 들어온 주문·수정 내역이 지워지는 것"인데, 지울 것이 없으면
 *   막을 이유가 없다. 오히려 막으면 **되살릴 방법이 어디에도 없는 작업**이 된다(실사용 신고).
 * · 내용이 있으면 계속 막되, 어디를 봐야 하는지·왜 안 보이는지를 문장으로 돌려준다.
 */
function classifyRegistered(d) {
  if (!d) return { blocked: false, empty: false, reasons: [] };
  const empty = d.boardRows === 0 && d.withOrder === 0 && d.indexRows === 0;
  const reasons = [];
  if (!d.inMirror || !d.inMaster) {
    reasons.push({ code: 'not_in_list',
      message: '작업 목록에 뜨지 않는 상태입니다 — 검색 명단·작업 등록부가 만들어지지 않았습니다.' });
  }
  if (!d.advertiserName) {
    reasons.push({ code: 'no_advertiser',
      message: '업체가 지정되지 않아 업체관리 표에는 나오지 않습니다(작업보드에서는 "미지정" 그룹).' });
  }
  if (!reasons.length) {
    reasons.push({ code: 'visible',
      message: `${d.advertiserName ? d.advertiserName + ' 소유로 ' : ''}이미 정상 등록된 작업입니다.` });
  }
  return { blocked: !empty, empty, reasons };
}

/* ═══════════════════════════════════════════════════════════════════
   ⑤ 가져오기 실행
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 실제로 가져온다.
 *
 * ★★ 순서가 계약:
 *   ① 시트를 **서버가 다시 읽어** 계획을 재계산(화면이 보낸 줄 목록을 믿지 않는다)
 *   ② `campaigns`/`tab_configs` 등록 — **이때 `sheetless = TRUE`**(D1)
 *      → 장부 생성기가 무시트 탭에서만 동작(fail-closed)하므로 표식이 **먼저** 켜져야 한다
 *   ③ 업체 소유 지정(D3 필수)  ④ 작업표 줄 생성  ⑤ 장부 3권  ⑥ 시트 안내문
 *
 * ★ ⑥ 은 **best-effort** — 실패해도 가져오기를 되돌리지 않고 사유만 실어 보낸다
 *   (되돌리면 "표식은 켰는데 안내문은 없는" 어중간한 상태가 된다).
 */
async function importSheet({
  url = '', sheetId: sidIn = '', gid: gidIn = '', advertiserId = '',
  displayName = '', skipSeqs = [], notice = true, by = 'admin',
} = {}) {
  const fromUrl = parseSheetUrl(url);
  const sheetId = String(sidIn || fromUrl.sheetId || '').trim();
  const gid = String(gidIn || fromUrl.gid || '').trim();
  if (!sheetId) throw new ImportError('bad_url', '구글시트 주소를 알아보지 못했습니다.');
  if (!gid) throw new ImportError('gid_required', '어느 탭을 가져올지 골라 주세요.');
  /* ★★ D3 — 업체 없이 가져오면 업체관리 표에 안 보여 지금 문제가 그대로 반복된다. */
  if (!advertiserId) throw new ImportError('advertiser_required', '업체를 골라 주세요.');

  const { rows: advRows } = await _db().query(
    `SELECT id, name, status FROM advertisers WHERE id = $1 LIMIT 1`, [advertiserId]);
  if (!advRows.length) throw new ImportError('advertiser_not_found', '그 업체를 찾지 못했습니다.');
  if (String(advRows[0].status || '') === 'ended') {
    throw new ImportError('advertiser_ended', '종료된 거래처에는 작업을 등록할 수 없습니다.');
  }
  const advertiserName = advRows[0].name;

  // ── ① 서버가 다시 읽고 다시 판정한다 ──
  const read = await _readTab(sheetId, gid);
  const det = detectSheetHeader(read.values);
  if (!det.headers || !det.headerRowIndex) {
    throw new ImportError('header_unrecognizable', '이 탭에서 표의 머리글 줄을 찾지 못했습니다.');
  }
  const headers = det.headers;
  const roles = classifyHeaders(headers);
  const idxOf = (role) => roles.findIndex(r => r && r.role === role);
  const phoneIdx = idxOf('phone');
  const nameIdx = idxOf('recipient') >= 0 ? idxOf('recipient') : idxOf('orderer');
  if (phoneIdx < 0) {
    throw new ImportError('no_phone_column', '연락처 칸을 찾지 못했습니다 — 리뷰어가 찾을 수 없는 명단이 됩니다.');
  }

  /* ★ 미리보기와 **같은 판정**(사본 0) — 빈 껍데기는 통과시켜 그 등록을 채운다. */
  const dup = await _findRegistered(sheetId, read.tabName, read.gid);
  if (dup && classifyRegistered(dup).blocked) {
    throw new ImportError('already_registered',
      `이미 시스템에 있는 작업입니다 — ${dup.advertiserName ? dup.advertiserName + ' › ' : ''}${dup.tabName}`);
  }

  const cls = classifyImportRows({ headers, values: read.values, headerRow: det.headerRowIndex, nameIdx, phoneIdx });
  if (cls.rows.length > MAX_ROWS) {
    throw new ImportError('too_many_rows', `줄이 너무 많습니다(${cls.rows.length}줄).`);
  }
  const skip = new Set((Array.isArray(skipSeqs) ? skipSeqs : []).map(n => parseInt(n, 10)).filter(Number.isFinite));
  const take = cls.rows.filter(r => !skip.has(r.seq));
  if (!take.some(r => !r.blank)) throw new ImportError('empty', '가져올 줄을 하나도 고르지 않았습니다.');

  const topMeta = readTopMeta(read.values, det.headerRowIndex);
  const label = String(displayName || topMeta.campaignName || read.tabName).trim().slice(0, 200);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  const db = _db();

  // ── ② 등록 (campaigns → tab_configs) ──
  await db.query(
    `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
       sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
    [sheetId, read.sheetTitle, sheetUrl]);

  /* ★★ 메타는 **blank-only**(COALESCE-fill) — 접수 업서트와 같은 규율.
     ★★ `sheetless` 는 **OR** — 이관은 되돌리지 않는다(시트 URL 로 재실행했다고 조용히 시트
        기반으로 되돌리면 크론이 옛 시트 값으로 장부를 덮어 편집분이 사라진다).
     ⚠ 접수 업서트(order.routes)는 작업오더 행에 강하게 결속돼 있어 그대로 호출할 수 없다.
       그래서 컬럼을 **최소로** 쓰고, 위 두 불변식을 회귀가드가 고정한다. */
  await db.query(
    `INSERT INTO tab_configs
       (sheet_id, tab_name, tab_gid, sheet_url, campaign_name, display_name,
        sheetless, sheetless_at, sheetless_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, TRUE, NOW(), $7, NOW())
     ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
       sheetless     = COALESCE(tab_configs.sheetless, FALSE) OR EXCLUDED.sheetless,
       sheetless_at  = COALESCE(tab_configs.sheetless_at, EXCLUDED.sheetless_at),
       sheetless_by  = COALESCE(NULLIF(tab_configs.sheetless_by,''), EXCLUDED.sheetless_by),
       tab_gid       = COALESCE(NULLIF(tab_configs.tab_gid,''),       EXCLUDED.tab_gid),
       sheet_url     = COALESCE(NULLIF(tab_configs.sheet_url,''),     EXCLUDED.sheet_url),
       campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
       display_name  = COALESCE(NULLIF(tab_configs.display_name,''),  EXCLUDED.display_name),
       updated_at    = NOW()`,
    [sheetId, read.tabName, read.gid, sheetUrl, read.sheetTitle, label, String(by).slice(0, 100)]);

  // ── ③ 업체 소유 (탭 지정 — 같은 시트의 다른 탭은 건드리지 않는다) ──
  await require('./trackB.service').setOwnership({
    advertiserId, sheetId, tabGid: read.gid, by,
  });

  // ── ④ 작업표 줄 ──
  const slotRows = take.map(r => ({
    seq: r.seq,
    rowJson: r.rowJson || {},
  }));
  const slots = await require('./participants.service').createSlotsFromSheetRows({
    sheetId, tabName: read.tabName, tabGid: read.gid, campaignName: read.sheetTitle,
    rows: slotRows, by: `sheet-import:${by}`,
  });

  // ── ⑤ 장부 3권 ──
  let ledger = null, ledgerError = null;
  try {
    ledger = await require('./sheetlessLedger.service')
      .rebuildLedgers({ sheetId, tabName: read.tabName, columns: headers, by: `sheet-import:${by}` });
  } catch (e) {
    ledgerError = (e && (e.code || e.message)) || 'rebuild_failed';
    logger.warn(`[sheetImport] 장부 생성 실패 tab=${read.tabName} — ${ledgerError}`);
  }

  // ── ⑥ 시트 안내문 (best-effort) ──
  let noticeResult = null;
  if (notice) {
    try {
      const { CUTOVER_NOTICE } = require('./sheetlessCutover.service');
      noticeResult = await require('./sheetNotice.service')
        .applySheetNotice(sheetId, { gid: read.gid, tabName: read.tabName, text: CUTOVER_NOTICE, force: true });
    } catch (e) {
      noticeResult = { ok: false, error: (e && e.message) || 'notice_failed' };
    }
  }

  logger.info(`[sheetImport] 가져오기 완료 — ${read.tabName} (${sheetId}) → ${advertiserName} · ` +
    `줄 ${slots.created}/${slotRows.length} · 명단 ${ledger ? ledger.indexRows : '?'} by=${by}`);

  return {
    ok: true, sheetId, tabName: read.tabName, tabGid: read.gid,
    advertiserId, advertiserName, displayName: label,
    requested: slotRows.length, created: slots.created,
    skipped: cls.rows.length - slotRows.length,
    indexRows: ledger ? ledger.indexRows : null,
    submittedCount: ledger ? ledger.submittedCount : null,
    ledgerError,
    notice: noticeResult,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ⑥ 되돌리기 (D6)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 방금 가져온 작업을 **가져오기 전 상태로** 되돌린다.
 *
 * ★★ 표식만 끄면 안 된다 — 등록(`tab_configs`)이 남아 있으면 크론이 그 시트를 다시 읽어
 *   장부를 채우므로 "되돌렸는데 다시 나타난다". 그래서 등록·장부·표 줄·소유를 함께 내린다.
 * ★★ **주문이 한 건이라도 들어왔으면 거부한다**(fail-closed) — 등록을 지우면 그 주문이 갈 곳을
 *   잃는다. 그 경우는 작업보드의 [줄 정리]가 맞는 도구라고 사유로 안내한다.
 * ★ `campaigns` 행은 남긴다 — 같은 시트의 다른 탭이 공유한다.
 * ★ 구글시트는 건드리지 않는다(안내문도 그대로 — 지우면 "이관됨"과 "아님"을 오가며 더 헷갈린다).
 */
async function revertImport({ sheetId = '', tabName = '', by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new ImportError('bad_request', 'sheetId, tabName 필수');
  const db = _db();

  const { rows: tcRows } = await db.query(
    `SELECT tab_gid, COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tcRows.length) return { ok: true, changed: false, message: '이미 등록이 없는 작업입니다.' };
  const tabGid = String(tcRows[0].tab_gid || '');

  /* ★ 주문·수기 줄이 있으면 되돌리지 않는다 — 이 기능이 만든 줄(`worktable`)만 있고
     주문 연결이 하나도 없을 때에만 "가져오기 직후"로 본다. */
  const { rows: guard } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE order_submission_id IS NOT NULL) AS with_order,
            COUNT(*) FILTER (WHERE source <> 'worktable')            AS other_source,
            COUNT(*)                                                 AS total
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`, [sheetId, tabName]);
  const g = guard[0] || {};
  if (Number(g.with_order) > 0 || Number(g.other_source) > 0) {
    return {
      ok: false, code: 'has_activity',
      withOrder: Number(g.with_order) || 0, otherSource: Number(g.other_source) || 0,
      message: '이 작업에는 이미 주문이나 직접 추가한 줄이 있어 되돌릴 수 없습니다 — ' +
               '작업보드의 [줄 정리]로 필요한 줄만 내려 주세요.',
    };
  }

  const client = await db.connect();
  let removed = 0;
  try {
    await client.query('BEGIN');
    /* 장부 재생성과 같은 탭 락 — 재생성이 도는 중에 지우면 반쯤 만들어진 장부가 남는다. */
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);

    /* ★ 작업표 쓰기는 `participants.service` 가 소유한다(쓰기 소유자 규율) — 여기는 순서·게이트만.
       같은 `client` 를 넘겨 등록·장부 삭제와 한 트랜잭션으로 묶는다. */
    removed = await require('./participants.service').purgeImportedRows(client, { sheetId, tabName });

    await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    await client.query('DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    if (tabGid) {
      await client.query('DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2', [sheetId, tabGid]);
      await client.query('DELETE FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2', [sheetId, tabGid]);
    }
    /* ★★ **탭 지정 소유만** 해제한다 — 이 기능이 거는 소유는 항상 `tab_gid` 지정이다.
       gid 를 모르면 우리가 만든 소유가 아니므로 **아무것도 건드리지 않는다**(빈 값을 NULL 로 넘기면
       `tab_gid IS NULL` = **시트 전체 소유**가 걸려 같은 시트의 다른 탭까지 업체에서 떨어진다). */
    if (tabGid) {
      await client.query(
        `UPDATE advertiser_campaigns SET deleted_at = NOW()
          WHERE sheet_id = $1 AND tab_gid = $2 AND deleted_at IS NULL`, [sheetId, tabGid]);
    }
    await client.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  logger.warn(`[sheetImport] 되돌리기 — ${tabName} (${sheetId}) 줄 ${removed}개 by=${by}`);
  return {
    ok: true, changed: true, removed,
    message: `되돌렸습니다 — 표 ${removed}줄과 업체 연결을 내렸습니다. 구글시트는 그대로 남아 있습니다.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ⑦ 수리 — "등록은 됐는데 어디에도 안 보이는" 작업 되살리기
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 진단이 짚어 준 원인을 **그 자리에서** 고친다. 가져오기(덮어쓰기)가 아니다.
 *
 * ★★ 실측(2026-08-10 · 0720수진코리아): 표 109줄·명단 109명·**주문 109건**이 멀쩡히 있는데
 *   `raw_sheet_tabs`(시트 사본)만 없어 `listActiveTabs`(미러 + 등록부) 조건을 못 넘겨
 *   작업 목록에서 사라져 있었다. 여기서 "가져오기"를 하면 **주문 109건 위에 덮어쓴다** —
 *   그래서 차단은 그대로 두고, **없는 것만 다시 만드는** 경로를 따로 연다.
 *
 * · `rebuild` = 장부 재생성(`sheetlessLedger.rebuildLedgers`) — 작업표에서 미러·명단·등록부를 다시 만든다.
 *   ★ **무시트 탭에서만**(그 함수의 fail-closed 그대로). 시트 기반이면 시트가 진실원본이라
 *     [반영 점검]의 시트 새로고침이 맞는 도구다 — 사유를 말하고 거부한다.
 * · `assign` = 업체 소유 지정(`trackB.setOwnership`) — 업체관리 표에 나타난다.
 *
 * ★ 실행부는 전부 기존 함수(사본 0). 이 함수는 **어느 것을 부를지와 게이트**만 정한다.
 * ★ 끝나면 **갱신된 진단을 함께 돌려준다** — 화면이 "고쳐졌는지"를 숫자로 바로 보여준다.
 */
async function repairRegistered({ sheetId = '', tabName = '', action = '', advertiserId = '', by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new ImportError('bad_request', 'sheetId, tabName 필수');

  const cur = await _findRegistered(sheetId, tabName, '');
  if (!cur) throw new ImportError('not_registered', '등록된 작업이 아닙니다 — 먼저 가져오기를 하세요.');

  let done = null;
  if (action === 'rebuild') {
    if (!cur.sheetless) {
      throw new ImportError('not_sheetless',
        '시트 기반 작업입니다 — 시트가 진실원본이라 여기서 만들지 않습니다. [반영 점검] 화면의 [↻ 시트 새로고침]을 이용하세요.');
    }
    const led = await require('./sheetlessLedger.service')
      .rebuildLedgers({ sheetId, tabName, by: `sheet-import-repair:${by}` });
    done = { action, mirrorRows: led.mirrorRows, indexRows: led.indexRows, submittedCount: led.submittedCount };
    logger.info(`[sheetImport] 수리(장부 재생성) — ${tabName} (${sheetId}) 미러 ${led.mirrorRows}행 · 명단 ${led.indexRows}명 by=${by}`);
  } else if (action === 'assign') {
    if (!advertiserId) throw new ImportError('advertiser_required', '업체를 골라 주세요.');
    const { rows: adv } = await _db().query(
      `SELECT id, name, status FROM advertisers WHERE id = $1 LIMIT 1`, [advertiserId]);
    if (!adv.length) throw new ImportError('advertiser_not_found', '그 업체를 찾지 못했습니다.');
    if (String(adv[0].status || '') === 'ended') throw new ImportError('advertiser_ended', '종료된 거래처입니다.');
    /* ★ gid 는 **등록부에서 다시 구한 값**(cur.tabGid)을 쓴다 — 화면이 보낸 gid 를 믿으면
       낡은 화면이 같은 시트의 다른 탭에 소유를 건다. gid 가 없으면 시트 전체 소유가 되므로 거부. */
    if (!cur.tabGid) {
      throw new ImportError('no_gid',
        '이 작업에 탭 번호(gid)가 없어 탭 단위로 업체를 지정할 수 없습니다 — 업체관리의 [소유 시트]에서 지정하세요.');
    }
    await require('./trackB.service').setOwnership({ advertiserId, sheetId, tabGid: cur.tabGid, by });
    done = { action, advertiserName: adv[0].name };
    logger.info(`[sheetImport] 수리(업체 지정) — ${tabName} (${sheetId}) → ${adv[0].name} by=${by}`);
  } else {
    throw new ImportError('bad_action', '무엇을 고칠지 정하지 않았습니다.');
  }

  const after = await _findRegistered(sheetId, tabName, '');
  return { ok: true, done, tab: after, judge: classifyRegistered(after) };
}

module.exports = {
  parseSheetUrl,
  repairRegistered,
  readTopMeta,
  classifyImportRows,
  classifyRegistered,
  previewSheetImport,
  importSheet,
  revertImport,
  ImportError,
  MAX_ROWS,
  __setPoolForTest,
};
