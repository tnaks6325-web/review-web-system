'use strict';
/**
 * 은행/증권사 표준코드 — 다건이체 서식 생성 단일 출처
 *
 * 표는 **케이뱅크 공식 대량이체 양식**('대량이체입력가이드' 시트)에서 그대로 옮겼다.
 * 하나은행 다건이체 서식도 같은 표준 금융기관 코드를 쓰므로(실측: 090 카카오뱅크·
 * 092 토스뱅크·088 신한·011 농협이 두 은행 파일에서 동일) **표는 하나만 둔다**.
 * 사본을 만들면 은행이 하나 추가될 때 한쪽만 늘어난다.
 *
 * ★ 매칭은 **정확 일치만** 한다(부분일치 금지) — '하나'로 부분매칭하면 '하나증권'(270)이
 *   '하나은행'(081)으로 잡혀 남의 계좌로 돈이 간다. 판정 실패는 추측하지 않고 null
 *   (= 계좌미비로 분류돼 화면에 드러남). 레포 규율: 틀린 값보다 빈 값.
 */

/** 코드 → 정식 명칭 (케이뱅크 공식 양식 순서 그대로) */
const BANKS = [
  ['089', '케이뱅크'],        ['002', '산업은행'],       ['003', '기업은행'],
  ['004', '국민은행'],        ['007', '수협은행'],       ['008', '수출입은행'],
  ['011', 'NH농협은행'],      ['012', '지역농축협'],     ['020', '우리은행'],
  ['023', 'SC제일은행'],      ['027', '한국씨티은행'],   ['031', '대구은행'],
  ['032', '부산은행'],        ['034', '광주은행'],       ['035', '제주은행'],
  ['037', '전북은행'],        ['039', '경남은행'],       ['041', '우리카드'],
  ['045', '새마을금고'],      ['048', '신협'],           ['052', '모건스탠리은행'],
  ['054', 'HSBC은행'],        ['055', '도이치은행'],     ['057', '제이피모간체이스은행'],
  ['058', '미즈호은행'],      ['059', '엠유에프지은행'], ['060', 'BOA은행'],
  ['061', '비엔피파리바은행'],['062', '중국공상은행'],   ['063', '중국은행'],
  ['064', '산림조합중앙회'],  ['065', '대화은행'],       ['066', '교통은행'],
  ['067', '중국건설은행'],    ['071', '우체국'],         ['081', '하나은행'],
  ['088', '신한은행'],        ['090', '카카오뱅크'],     ['092', '토스뱅크'],
  ['209', '유안타증권'],      ['218', 'KB증권'],         ['221', '상상인증권'],
  ['222', '한양증권'],        ['223', '리딩투자증권'],   ['224', 'BNK투자증권'],
  ['225', 'IBK투자증권'],     ['227', '다올투자증권'],   ['238', '미래에셋증권'],
  ['240', '삼성증권'],        ['243', '한국투자증권'],   ['247', 'NH투자증권'],
  ['261', '교보증권'],        ['262', '하이투자증권'],   ['263', '현대차증권'],
  ['264', '키움증권'],        ['265', '이베스트투자증권'],['266', 'SK증권'],
  ['267', '대신증권'],        ['269', '한화투자증권'],   ['270', '하나증권'],
  ['271', '토스증권'],        ['272', 'NH선물'],         ['278', '신한투자증권'],
  ['279', 'DB금융투자'],      ['280', '유진투자증권'],   ['287', '메리츠증권'],
  ['288', '카카오페이증권'],  ['290', '부국증권'],       ['291', '신영증권'],
  ['292', '케이프투자증권'],  ['293', '한국증권금융'],   ['294', '한국포스증권'],
];

/**
 * 리뷰어가 내정보에 실제로 적는 표기 → 코드.
 * 실측 표기(신한/우리/국민/케이뱅크/토스뱅크/카카오뱅크/기업/KEB하나/농협)를 모두 덮는다.
 * ★ 여기에 없는 표기는 추측하지 않는다 — 계좌미비로 남겨 사람이 확인한다.
 */
const ALIASES = {
  // 시중은행
  'kb': '004', 'kb국민': '004', 'kb국민은행': '004', '국민': '004',
  '신한': '088',
  '우리': '020',
  '하나': '081', 'keb하나': '081', 'keb': '081', 'keb하나은행': '081', '외환': '081', '외환은행': '081',
  'ibk': '003', 'ibk기업': '003', 'ibk기업은행': '003', '기업': '003',
  'nh': '011', 'nh농협': '011', '농협': '011', '농협은행': '011', '단위농협': '011', '지역농협': '011',
  'sc': '023', 'sc제일': '023', '제일': '023', '제일은행': '023',
  '씨티': '027', '시티': '027', '시티은행': '027', '씨티은행': '027',
  'kdb': '002', 'kdb산업': '002', '산업': '002',
  '수협': '007',
  // 인터넷은행 — 리뷰어 계좌에서 가장 흔하다
  '케이': '089', '케이뱅크은행': '089', 'k뱅크': '089', '케뱅': '089', 'kbank': '089',
  '카카오': '090', '카뱅': '090', '카카오뱅크은행': '090', 'kakaobank': '090',
  '토스': '092', '토스뱅크은행': '092', 'toss': '092',
  // 지방은행 / 상호금융
  '대구': '031', 'im뱅크': '031', 'im': '031', 'imbank': '031',
  '부산': '032', '광주': '034', '제주': '035', '전북': '037', '경남': '039',
  '새마을': '045', 'mg새마을금고': '045', 'mg': '045',
  '신협중앙회': '048',
  '우체국예금보험': '071', '우체국은행': '071',
  '산림조합': '064',
  // ── 2026-08 제공 엑셀(은행코드 매핑표) 대조로 보강한 표기 ──
  //   ★ 같은 말이 두 코드에 걸리는 항목(우리 020/022 · 국민 004/019 · 씨티 027/053 ·
  //     NH투자증권 247/289 · IBK투자증권 225/271)은 **넣지 않았다** — 어느 코드로 보낼지
  //     정할 수 없어 그대로 넣으면 남의 계좌로 간다. 필요하면 화면에서 사람이 하나만 고른다.
  '한국씨티': '027',
  'hsbc': '054',
  '도이치': '055',
  'boa': '060',
  'bnp파리바': '061',
  '미래에셋': '238', '미래에셋대우': '238',
  '에이치엠씨투자증권': '263',
  '에스케이증권': '266',
  '한화증권': '269',
  '동부증권': '279',
  '메리츠종금': '287',
  'lig투자증권': '292',
  '펀드온라인코리아': '294',
};

const _byCode = new Map(BANKS);
const _byName = new Map();                                  // 정규화 정식명 → 코드
for (const [code, name] of BANKS) _byName.set(_norm(name), code);

/** 코드 → 기본 별칭 원문 목록(화면 표시용 — 무엇이 기본이고 무엇이 사람이 넣은 것인지 구분). */
const _baseAliasByCode = new Map();
for (const alias of Object.keys(ALIASES)) {
  const c = ALIASES[alias];
  if (!_baseAliasByCode.has(c)) _baseAliasByCode.set(c, []);
  _baseAliasByCode.get(c).push(alias);
}

/** 공백·기호 제거 + 소문자. '주식회사'·'(주)' 같은 접두는 제거한다. */
function _norm(s) {
  return String(s == null ? '' : s)
    .replace(/\(주\)|주식회사|㈜/g, '')
    .replace(/[\s\-_.·,()]/g, '')
    .toLowerCase()
    .trim();
}

/* ══════════════════════════════════════════════════════════════
   사람이 화면에서 고친 표기(오버레이)
   ★★ 판정 **규칙**은 한 줄도 바뀌지 않는다 — 오버레이가 바꾸는 것은
      "표에 무엇이 들어 있는가"뿐이다(정확일치만 · 모르면 null 은 그대로).
   ★★ 오버레이 미로드 = 이 파일의 기본값 = 오늘 동작 100%(fail-open).
      DB 조회가 죽어도 이체 판정이 멈추면 안 된다.
   ★ 저장소는 `app_settings.bank_name_overrides` 한 키이고, 그것을 읽어
     `setBankOverrides()` 로 밀어 넣는 곳은 `services/bankNameOverride.service.js` 하나다.
   ══════════════════════════════════════════════════════════════ */
let _ov = null;

function _code3(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length === 3 ? d : '';
}

/** 저장 JSON → 조회용 인덱스. 형식이 아니면 null(= 기본값). */
function _buildOverlay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = new Map();     // code → 정식 명칭(덮어쓰기·신규기관)
  const add = new Map();      // code → [{ v: 원문, n: 정규화 }]
  const del = new Set();      // 정규화 — 기본 별칭 중 사람이 뺀 것
  const alias = new Map();    // 정규화 → code
  const extra = new Set();    // 표에 없던 신규 기관 코드
  const byName = new Map();   // 정규화 정식명 → code

  const banks = raw.banks && typeof raw.banks === 'object' ? raw.banks : {};
  for (const key of Object.keys(banks)) {
    const c = _code3(key);
    if (!c) continue;
    const v = banks[key] || {};
    if (typeof v.name === 'string' && v.name.trim()) name.set(c, v.name.trim());
    if (Array.isArray(v.add)) {
      for (const a of v.add) {
        const n = _norm(a);
        if (!n) continue;
        if (!add.has(c)) add.set(c, []);
        add.get(c).push({ v: String(a).trim(), n });
        alias.set(n, c);
      }
    }
    if (Array.isArray(v.del)) for (const d of v.del) { const n = _norm(d); if (n) del.add(n); }
  }
  for (const e of (Array.isArray(raw.extra) ? raw.extra : [])) {
    const c = _code3(e && e.code);
    const nm = String((e && e.name) || '').trim();
    if (!c || !nm || _byCode.has(c)) continue;
    name.set(c, nm);
    extra.add(c);
  }
  for (const [c, nm] of name) { const n = _norm(nm); if (n) byName.set(n, c); }
  return { name, add, del, alias, extra, byName };
}

/** 오버레이 적용(서비스가 부른다). raw 가 비면 기본값으로 되돌린다. */
function setBankOverrides(raw) { _ov = _buildOverlay(raw); return _ov; }

function _effName(code) { return (_ov && _ov.name.get(code)) || _byCode.get(code) || ''; }
function _lookupName(n) { return (_ov && _ov.byName.get(n)) || _byName.get(n) || ''; }
function _lookupAlias(n) {
  if (_ov && _ov.alias.has(n)) return _ov.alias.get(n);      // 사람이 넣은 표기가 먼저
  if (_ov && _ov.del.has(n)) return '';                      // 사람이 뺀 기본 별칭
  return ALIASES[n] || '';
}
function _hasCode(c) { return _byCode.has(c) || !!(_ov && _ov.name.has(c)); }

/**
 * 은행명(또는 코드) → { code, name }. 판정 불가면 null.
 * 순서: ① 3자리 코드 ② 정식명 정확일치 ③ 별칭 정확일치 ④ 뒤의 '은행' 떼고 재시도
 *   ④는 '신한은행'처럼 정식명에 이미 은행이 붙은 경우가 ②에서 걸리므로,
 *   '카카오뱅크은행' 같은 군더더기 표기만 흡수한다.
 */
function resolveBank(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  const digits = raw.replace(/[^0-9]/g, '');
  if (digits && digits.length <= 3 && /^[0-9]+$/.test(raw.trim())) {
    const padded = digits.padStart(3, '0');
    if (_hasCode(padded)) return { code: padded, name: _effName(padded) };
  }

  const n = _norm(raw);
  if (!n) return null;
  { const c = _lookupName(n); if (c) return { code: c, name: _effName(c) }; }
  { const c = _lookupAlias(n); if (c) return { code: c, name: _effName(c) }; }

  const stripped = n.replace(/(은행|뱅크)$/, '');
  if (stripped && stripped !== n) {
    const c1 = _lookupName(stripped); if (c1) return { code: c1, name: _effName(c1) };
    const c2 = _lookupAlias(stripped); if (c2) return { code: c2, name: _effName(c2) };
  }
  return null;
}

/** 화면용 목록 — 코드 · 지금 나가는 정식명 · 표기(기본/사람이 넣은 것 구분). */
function bankTable() {
  const codes = BANKS.map(([c]) => c);
  if (_ov) for (const c of _ov.extra) if (!_byCode.has(c)) codes.push(c);
  return codes.map((code) => {
    const baseName = _byCode.get(code) || '';
    const aliases = [];
    for (const a of (_baseAliasByCode.get(code) || [])) {
      const n = _norm(a);
      if (_ov && _ov.del.has(n)) continue;                       // 사람이 뺐다
      if (_ov && _ov.alias.has(n) && _ov.alias.get(n) !== code) continue;  // 다른 은행으로 옮겼다
      aliases.push({ v: a, base: true });
    }
    if (_ov) for (const it of (_ov.add.get(code) || [])) {
      if (aliases.some(x => _norm(x.v) === it.n)) continue;
      aliases.push({ v: it.v, base: false });
    }
    return {
      code,
      name: _effName(code),
      baseName,
      renamed: !!(_ov && _ov.name.has(code) && _byCode.has(code)),
      custom: !!(_ov && _ov.extra.has(code)),
      aliases,
      // ★ 지운 것까지 포함한 **기본 별칭 전체** — 화면이 저장 페이로드의 `del` 을
      //   "여기 있는데 지금 목록에 없는 것"으로 계산한다(프론트에 정규화 사본을 두지 않기 위해
      //   서버가 준 문자열끼리 그대로 비교한다).
      baseAliases: (_baseAliasByCode.get(code) || []).slice(),
    };
  });
}

/**
 * 저장 전 검증 — **같은 말이 두 은행에 걸리면 저장 자체를 막는다**(유일한 하드블록).
 * 어느 코드로 이체할지 정할 수 없기 때문이고, 이건 곧 남의 계좌로 돈이 가는 경로다.
 * 반환: { ok, clean, conflicts:[{token,codes}], code, error }
 */
function validateBankOverrides(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const banksIn = src.banks && typeof src.banks === 'object' ? src.banks : {};
  const extraIn = Array.isArray(src.extra) ? src.extra : [];

  const clean = { banks: {}, extra: [] };
  const errors = [];

  for (const e of extraIn) {
    const c = _code3(e && e.code);
    const nm = String((e && e.name) || '').trim();
    if (!c) { errors.push(`은행코드는 숫자 3자리여야 합니다(입력: ${String((e && e.code) || '')}).`); continue; }
    if (!nm) { errors.push(`${c} — 정식 명칭이 비었습니다.`); continue; }
    if (_byCode.has(c)) { errors.push(`${c} 는 이미 표에 있는 은행입니다(${_byCode.get(c)}).`); continue; }
    if (nm.length > 40) { errors.push(`${c} — 정식 명칭이 너무 깁니다.`); continue; }
    if (clean.extra.some(x => x.code === c)) continue;
    clean.extra.push({ code: c, name: nm });
  }
  const extraCodes = new Set(clean.extra.map(x => x.code));

  for (const key of Object.keys(banksIn)) {
    const c = _code3(key);
    if (!c) { errors.push(`알 수 없는 은행코드: ${key}`); continue; }
    if (!_byCode.has(c) && !extraCodes.has(c)) { errors.push(`표에 없는 은행코드: ${c}`); continue; }
    const v = banksIn[key] || {};
    const ent = {};
    const nm = typeof v.name === 'string' ? v.name.trim() : '';
    if (nm && nm !== _byCode.get(c)) {
      if (nm.length > 40) { errors.push(`${c} — 정식 명칭이 너무 깁니다.`); continue; }
      ent.name = nm;
    }
    const seen = new Set();
    const addOut = [];
    for (const a of (Array.isArray(v.add) ? v.add : [])) {
      const t = String(a == null ? '' : a).trim();
      const n = _norm(t);
      if (!n) continue;
      if (t.length > 40) { errors.push(`${c} — 표기가 너무 깁니다: ${t}`); continue; }
      // 숫자만 있는 표기는 ① 코드 조회에서 먼저 걸려 **영원히 도달하지 못한다** → 넣지 못하게 막는다.
      if (/^[0-9]+$/.test(n)) { errors.push(`${c} — 숫자만 있는 표기는 넣을 수 없습니다: ${t}`); continue; }
      if (seen.has(n)) continue;
      seen.add(n);
      addOut.push(t);
    }
    if (addOut.length) ent.add = addOut;
    const delOut = [];
    for (const d of (Array.isArray(v.del) ? v.del : [])) {
      const t = String(d == null ? '' : d).trim();
      if (_norm(t)) delOut.push(t);
    }
    if (delOut.length) ent.del = delOut;
    if (ent.name || ent.add || ent.del) clean.banks[c] = ent;
  }

  if (errors.length) return { ok: false, code: 'bad_input', error: errors[0], errors, conflicts: [] };

  // ── 겹침 검사: 최종 표에서 한 표기가 두 코드를 가리키면 저장 불가 ──
  const ov = _buildOverlay(clean);
  const map = new Map();
  const put = (n, c) => { if (!n) return; if (!map.has(n)) map.set(n, new Set()); map.get(n).add(c); };
  const effName = (c) => (ov && ov.name.get(c)) || _byCode.get(c) || '';
  for (const [c] of BANKS) put(_norm(effName(c)), c);
  if (ov) for (const c of ov.extra) put(_norm(effName(c)), c);
  for (const a of Object.keys(ALIASES)) {
    const c = ALIASES[a];
    // ★★ **기본 별칭을 다른 은행에 추가하는 것은 "이동"이 아니라 "겹침"이다** —
    //   조용히 옮겨 주면 오타 한 번('국민'을 신한에 추가)에 그 표기가 통째로 다른
    //   은행을 가리켜 남의 계좌로 돈이 간다. 옮기려면 원래 은행에서 **먼저 지워야** 한다
    //   (그래서 여기서 걸러 낼 조건은 `del` 하나뿐이다 — 완화 금지).
    if (ov && ov.del.has(a)) continue;
    put(a, c);
  }
  if (ov) for (const [n, c] of ov.alias) put(n, c);

  const conflicts = [];
  for (const [token, set] of map) {
    if (set.size < 2) continue;
    conflicts.push({ token, codes: [...set].map(c => ({ code: c, name: effName(c) })) });
  }
  if (conflicts.length) {
    const f = conflicts[0];
    return {
      ok: false, code: 'conflict', conflicts,
      error: `'${f.token}' 이 ${f.codes.map(x => x.code + ' ' + x.name).join(' / ')} 두 곳에 있습니다 — 어느 은행인지 정할 수 없어 저장할 수 없습니다.`,
    };
  }
  return { ok: true, clean, conflicts: [] };
}

/** 계좌번호 — 서식은 '-' 없이 숫자만(케이뱅크 양식: 숫자 15자 이내) */
function normalizeAccount(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

/**
 * 받는분 통장표시 — 케이뱅크 양식 제약: 한글 8자(16byte) 이내, 지정 특수문자 외 불가.
 * 초과분은 자르고, 허용되지 않는 문자는 제거한다(은행이 파일 자체를 거부하지 않게).
 */
const MEMO_ALLOWED = /[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ !@#^*()+\-./;,[\]:_?~{|}]/g;
function normalizeMemo(v) {
  const cleaned = String(v == null ? '' : v).replace(MEMO_ALLOWED, '').trim();
  let bytes = 0, out = '';
  for (const ch of cleaned) {
    const w = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1;
    if (bytes + w > 16) break;
    bytes += w; out += ch;
  }
  return out;
}

/** 표준코드 → 정식 명칭. 케이뱅크 양식은 "형식에 맞는 은행명 혹은 코드만" 받으므로
 *  리뷰어가 적은 원문('신한')이 아니라 **정식명('신한은행')** 을 써야 거부되지 않는다. */
function bankNameByCode(code) {
  const c = String(code == null ? '' : code).replace(/[^0-9]/g, '').padStart(3, '0');
  return _effName(c);
}

module.exports = {
  BANKS, resolveBank, bankNameByCode, normalizeAccount, normalizeMemo,
  setBankOverrides, bankTable, validateBankOverrides,
};
