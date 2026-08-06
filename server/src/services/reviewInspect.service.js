/**
 * reviewInspect.service.js — 리뷰 자동검수 (M0 1차 필터 + M1 2차 검수).
 *
 * 두 층으로 나뉜다.
 *   1차(M0) = 리뷰어가 캡처를 **첨부하는 순간**. 리뷰 화면인가 / 어느 채널인가만 본다.
 *             아직 Drive 에 올라가지도, 제출로 기록되지도 않은 상태라 파일만 바꾸면 끝난다.
 *   2차(M1) = **제출 이후**. 상품명·같은 파일·본문 겹침처럼 다른 제출과 대조해야
 *             나오는 판정. 결과는 기록만 하고 제출을 되돌리지 않는다.
 *
 * ★★ 완화 금지 불변식 (이 셋이 풀리면 "참여 소각" 사고가 난다)
 *   ① fail-open — AI 미설정·오류·타임아웃·저확신은 **통과**. 모르면 통과가 원칙.
 *   ② 차단은 "리뷰 화면이 아님"(kind='other') + 높은 확신 **하나뿐**.
 *      채널 불일치·상품명 불일치·중복·유사도는 **절대 차단하지 않는다**(경고 또는 사후 분류).
 *   ③ 카카오메이커스는 잠금 제외 — 별점 있는 후기 화면과 별점 없는 피드형이 공존해
 *      리뷰어가 어느 쪽을 캡처할지 통제할 수 없다. 피드형 오판이 곧 정상 제출 차단이다.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');
// ★ 087: 리뷰타입 판정은 utils/reviewType 단일 출처(여기서 규칙을 다시 만들면 화면과 갈라진다)
const { resolveReviewType } = require('../utils/reviewType');

/* ── 스위치·임계값 (전부 env 로 끌 수 있다) ───────────────────────────── */
const ENABLED = process.env.REVIEW_INSPECT !== '0';            // 2차 검수 전체
const PRECHECK_ENABLED = process.env.REVIEW_PRECHECK !== '0';  // 1차 필터 전체
// ★ 관측 모드: 판정은 하되 **잠그지 않는다**. 운영 초기 오탐률을 보는 동안 이걸 권장.
const PRECHECK_BLOCK = process.env.REVIEW_PRECHECK_BLOCK !== '0';
const BLOCK_CONFIDENCE = Number(process.env.REVIEW_PRECHECK_BLOCK_CONFIDENCE || 0.9);
const CHANNEL_WARN_CONFIDENCE = Number(process.env.REVIEW_PRECHECK_CHANNEL_CONFIDENCE || 0.8);
const SIM_THRESHOLD = Number(process.env.REVIEW_INSPECT_SIM_THRESHOLD || 0.9);
const MIN_TEXT = Number(process.env.REVIEW_INSPECT_MIN_TEXT || 30);
// ★ 두 글의 길이가 이 비율 이상일 때만 "포함 관계"(word_similarity)까지 본다.
//   낮추면 짧은 관용구가 긴 리뷰에 들어있다는 이유로 오탐이 난다(findSimilarText 주석 참조).
const SIM_LEN_RATIO = Number(process.env.REVIEW_INSPECT_SIM_LEN_RATIO || 0.5);
/* ★ 비교 범위 — 기본 'tab'(같은 작업 안에서만). 'global' 이면 **다른 캠페인에 같은 글을
   돌려쓰는 것**까지 잡지만, 비교 대상이 전체로 늘어 쿼리가 무거워진다(trgm GIN 인덱스가
   있어도 행 수에 비례). 운영 규모를 보고 켤 것. */
const SIM_SCOPE = String(process.env.REVIEW_INSPECT_SIM_SCOPE || 'tab');
// 작성자 표기 재사용 탐지 — 경고 전용(차단 절대 없음). 끄려면 0.
const AUTHOR_REUSE = process.env.REVIEW_INSPECT_AUTHOR_REUSE !== '0';
// ★ 잠금 제외 채널 — 위 불변식 ③
const BLOCK_EXEMPT_CHANNELS = String(process.env.REVIEW_PRECHECK_EXEMPT || 'kakao')
  .split(',').map(s => s.trim()).filter(Boolean);
/* ★ 087 2차: 구매확정 화면 판정. 끄면 구매확정 탭은 1차 필터를 아예 건너뛴다(도입 전과 동일).
   이 갈래는 **켜져 있어도 절대 잠그지 않는다** — pass/warn 만 낸다. */
const CONFIRM_VERIFY = process.env.REVIEW_CONFIRM_VERIFY !== '0';

let _pool;
function _db() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(p) { _pool = p || null; }

/* ── 채널 표기 ─────────────────────────────────────────────────────── */
const CHANNEL_LABELS = {
  coupang: '쿠팡', naver: '네이버', kakao: '카카오메이커스', oliveyoung: '올리브영',
};
function channelLabel(k) { return CHANNEL_LABELS[k] || ''; }

/**
 * 탭/공고의 구매채널 문자열 → 검수용 채널 key.
 * 관리자 화면의 버튼값(쿠팡·네이버·올리브영·카카오메이커스)과 커스텀 입력 양쪽을 받는다.
 * ★ 카카오는 '메이커스'를 요구 — 톡스토어·선물하기는 화면이 달라 같은 기준을 쓸 수 없다
 *   (utils/cashReceiptChannels 와 같은 규율). 판정 실패는 null = 대조 안 함.
 */
function expectedChannelKey(channel) {
  const ch = String(channel == null ? '' : channel);
  if (!ch.trim()) return null;
  if (/쿠팡|coupang/i.test(ch)) return 'coupang';
  if (/네이버|스마트스토어|naver/i.test(ch)) return 'naver';
  if (/올리브영|올영|oliveyoung/i.test(ch)) return 'oliveyoung';
  if (/메이커스|makers/i.test(ch)) return 'kakao';
  return null;
}

/* ══════════════════════════════════════════════════════════════════
 * 1차 필터 (M0) — 첨부 시점 정책
 * ════════════════════════════════════════════════════════════════ */

/**
 * @param {object|null} classified  gemini.classifySubmissionImage 결과(실패 시 null)
 * @param {string|null} expectedChannel  이 작업의 채널 key(모르면 null = 대조 생략)
 * @param {string} slotKey  'review' 외 슬롯은 1차 대상이 아니다
 * @returns {{verdict:'pass'|'warn'|'block'|'skip', code:string, message:string,
 *            channel:string, confidence:number, blockable:boolean}}
 */
function precheckPolicy({ classified, expectedChannel, slotKey = 'review', reviewType = null } = {}) {
  const skip = (code) => ({ verdict: 'skip', code, message: '', channel: '', confidence: 0, blockable: false });

  if (!PRECHECK_ENABLED) return skip('disabled');
  // 1차는 리뷰 슬롯만 — 영수증 슬롯은 기존 제출 시점 검수(captureVerify)가 그대로 담당한다.
  if (String(slotKey || 'review') !== 'review') return skip('not_review_slot');

  /* ★★ 087 안전핀 (완화 금지) — 구매확정 작업은 **어떤 경우에도 잠그지 않는다**.
     구매확정건의 리뷰어는 리뷰 화면이 아니라 '구매확정 완료 화면'을 올린다. 2차에서 AI 에
     `purchase_confirm` 종류를 붙였지만 **판별 예시이미지가 등록되기 전에는 정확도가 낮아**
     오탐이 곧 정상 제출 차단(= 참여 소각)이 된다. 그래서 이 갈래는 pass/warn 만 낸다.
     ★ 킬스위치 `REVIEW_CONFIRM_VERIFY=0` 이면 판정 자체를 생략(종전 skip 동작).
     ★ reviewType 이 null(미지정·판정 실패)이면 여기 걸리지 않는다 = 오늘 동작 그대로. */
  if (reviewType === 'confirm') {
    if (!CONFIRM_VERIFY) return skip('purchase_confirm_tab');
    if (!classified || typeof classified !== 'object') return skip('no_verdict');
    const c = Number(classified.confidence) || 0;
    if (classified.kind === 'purchase_confirm') {
      return { verdict: 'pass', code: 'confirm_ok', message: '구매확정 완료 화면으로 확인했어요.',
               channel: '', confidence: c, blockable: false };
    }
    // 리뷰 화면을 올린 경우가 가장 흔한 실수 — 무엇을 올려야 하는지 콕 집어 알려준다.
    if (c < BLOCK_CONFIDENCE) return skip('low_confidence');
    return {
      verdict: 'warn', code: 'not_purchase_confirm',
      message: classified.kind === 'review'
        ? '이 작업은 리뷰가 아니라 **구매확정**입니다. 구매확정이 완료된 화면을 캡처해 주세요.'
        : '구매확정 완료 화면이 아닌 것 같아요. "구매확정" 표시가 보이는 화면을 캡처해 주세요.',
      channel: '', confidence: c, blockable: false,
    };
  }
  // ★ 불변식 ① — 판정 재료가 없으면 통과. AI 장애가 제출을 막는 사유가 되면 안 된다.
  if (!classified || typeof classified !== 'object') return skip('no_verdict');

  const conf = Number(classified.confidence) || 0;
  const kind = classified.kind;
  const channel = String(classified.channel || '');

  // ── 리뷰 화면이 아님 ──
  if (kind !== 'review') {
    // 영수증을 리뷰 자리에 올린 경우는 기존 슬롯 검수가 이미 다루는 영역이라
    // 여기서는 같은 말을 두 번 하지 않고 통과시킨다(중복 경고 방지).
    if (kind === 'receipt') return skip('receipt_handled_elsewhere');
    /* ★★ 087 2차 역방향 — 리뷰 작업 자리에 '구매확정 완료 화면'이 온 경우.
       새 종류를 도입했다는 이유만으로 **판정이 갑자기 세지면 안 된다**: 종전에는 이런 화면이
       `other` 로 떨어져 차단 대상이었는데, 지금 그대로 두면 같은 이미지가 계속 차단된다.
       잠금은 `other` 한 갈래뿐이라는 불변식(②)을 지켜 여기서는 **경고까지만** 한다
       — 차단 범위를 넓히는 게 아니라 좁히는 방향이라 fail-open 원칙과도 맞는다. */
    if (kind === 'purchase_confirm') {
      if (conf < CHANNEL_WARN_CONFIDENCE) return skip('low_confidence');
      return { verdict: 'warn', code: 'purchase_confirm_on_review',
               message: '구매확정 화면으로 보여요. 이 작업은 리뷰 작성 건이라 별점과 리뷰 내용이 보이는 화면이 필요합니다.',
               channel, confidence: conf, blockable: false };
    }
    if (conf < BLOCK_CONFIDENCE) return skip('low_confidence');
    // ★ 불변식 ③ — 잠금 제외 채널의 작업은 경고까지만.
    const exempt = expectedChannel && BLOCK_EXEMPT_CHANNELS.includes(expectedChannel);
    const msg = '리뷰 화면이 아닌 것 같아요. 별점과 리뷰 내용이 함께 보이는 화면을 캡처해 주세요.';
    if (exempt || !PRECHECK_BLOCK) {
      return { verdict: 'warn', code: exempt ? 'not_review_exempt' : 'not_review_observe',
               message: msg, channel, confidence: conf, blockable: false };
    }
    return { verdict: 'block', code: 'not_review', message: msg, channel, confidence: conf, blockable: true };
  }

  // ── 리뷰는 맞는데 채널이 다름 → ★ 불변식 ② 경고까지만 ──
  //   이 작업의 채널 정보는 상품 URL 호스트로 **추정한** 값이라 우리 쪽이 틀렸을 수 있다.
  //   우리 데이터 오류로 리뷰어를 막지 않는다.
  if (expectedChannel && channel && channel !== expectedChannel && conf >= CHANNEL_WARN_CONFIDENCE) {
    return {
      verdict: 'warn', code: 'channel_mismatch',
      message: `이 작업은 ${channelLabel(expectedChannel)} 리뷰인데 ${channelLabel(channel)} 리뷰 화면으로 보여요.`,
      channel, confidence: conf, blockable: false,
    };
  }

  return {
    verdict: 'pass', code: 'ok',
    message: channel ? `${channelLabel(channel)} 리뷰 화면으로 확인했어요.` : '리뷰 화면으로 확인했어요.',
    channel, confidence: conf, blockable: false,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 판별 예시이미지 (few-shot)
 *
 * ★★ 예시는 **판정 호출부 전부가 같은 것을 넘겨야** 한다 — 한쪽만 넘기면 캐시 키가
 *   갈려 같은 이미지에 AI 콜이 두 번 나간다(review-upload 의 verifyCapture ↔ 검수).
 *   그래서 "이 탭의 기대 채널 → 예시 목록"을 여기서 한 번 만들어 양쪽에 같이 준다.
 * ★ 채널을 모르면 **빈 배열**(예시 미동봉) — 9장을 다 보내면 토큰·지연이 커져
 *   첨부 즉시 판별의 응답성을 해친다.
 * ════════════════════════════════════════════════════════════════ */
const SAMPLES_ENABLED = process.env.REVIEW_INSPECT_SAMPLES !== '0';
const _sampleCache = new Map();                 // `${settingKey}|${url}` → { data, mimeType, ts }
const SAMPLE_TTL = Number(process.env.REVIEW_INSPECT_SAMPLE_TTL_MS || 30 * 60 * 1000);
/* 누적 상한 — "많이"가 아니라 "다르게"가 정확도를 올린다(few-shot은 종류당 2~5장에서 포화).
 * 슬롯당 저장 5장 / 한 판정 동봉 6장. 초과는 조용히 자르지 않고 화면·로그가 말한다. */
const SAMPLE_SLOT_CAP = Math.max(1, Number(process.env.REVIEW_INSPECT_SAMPLE_SLOT_CAP || 5));
const SAMPLE_ATTACH_CAP = Math.max(1, Number(process.env.REVIEW_INSPECT_SAMPLE_ATTACH_CAP || 6));

/**
 * 예시 슬롯 값 파싱 — ★ 하위호환이 핵심: 종전 값은 URL 문자열 1개였다.
 * "문자열 = 1장짜리 배열"로 읽어 기존 등록분 유실 0(마이그레이션 0).
 */
function parseSampleUrls(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return [];
  if (v.startsWith('[')) {
    try {
      const a = JSON.parse(v);
      return (Array.isArray(a) ? a : []).map(s => String(s || '').trim())
        .filter(u => /^https:\/\/\S+$/i.test(u)).slice(0, SAMPLE_SLOT_CAP);
    } catch (_) { return []; }
  }
  return [v];
}

/**
 * 예시 슬롯 편집 단일 지점 — 리뷰/현금영수증/자동분류 세 저장 창구가 전부 이걸 쓴다
 * (사본을 두면 한쪽만 상한·중복 규칙이 달라진다).
 * mode: 'add'(누적 — 기본 UI) | 'remove'+index(개별 삭제) | 미지정(종전 동작 = 교체/전체 제거)
 */
async function _mutateSampleList(settingKey, { imageUrl, mode, index } = {}) {
  const url = String(imageUrl ?? '').trim();
  if (url && !/^https:\/\/\S+$/i.test(url)) throw new Error('imageUrl은 https 절대 URL이어야 합니다.');
  const { rows } = await _db().query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [settingKey]);
  let list = parseSampleUrls(rows[0] && rows[0].value);
  if (mode === 'add') {
    if (!url) throw new Error('추가할 imageUrl이 필요합니다.');
    if (!list.includes(url)) {
      if (list.length >= SAMPLE_SLOT_CAP) {
        throw new Error(`슬롯당 최대 ${SAMPLE_SLOT_CAP}장입니다 — 덜 닮은 기존 예시를 지우고 등록하세요.`);
      }
      list = list.concat([url]);
    }
  } else if (mode === 'remove') {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('지울 예시를 찾지 못했습니다.');
    list = list.filter((_, j) => j !== i);
  } else {
    list = url ? [url] : [];   // 종전 동작 100%: 단일 교체 / ''=전부 제거(옛 화면 호환)
  }
  await _db().query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [settingKey, list.length ? JSON.stringify(list) : '']
  );
  for (const k of _sampleCache.keys()) if (k.startsWith(settingKey + '|')) _sampleCache.delete(k);
  return list;
}

/** Drive 프록시 URL → base64. 실패는 null(그 예시만 빠지고 판정은 계속). */
async function _fetchSample(url) {
  try {
    const m = /\/api\/drive\/image\/([-\w]{20,})/.exec(String(url || ''));
    if (!m) return null;
    const { downloadFile } = require('./drive.service');
    const f = await downloadFile(m[1]);
    if (!f || !f.buffer) return null;
    return { data: f.buffer.toString('base64'), mimeType: f.mimeType || 'image/jpeg' };
  } catch (e) {
    logger.warn(`[reviewInspect] 예시이미지 로드 실패(생략): ${e.message}`);
    return null;
  }
}

/**
 * 슬롯 목록 → few-shot 예시 배열. **리뷰 예시와 현금영수증 예시가 같은 경로를 쓴다**
 * (사본을 두면 한쪽만 캐시·URL 검증이 달라진다).
 * @param {Array<{key:string,label:string,settingKey:string,kind:string}>} slots
 */
async function _loadSampleSlots(slots) {
  if (!SAMPLES_ENABLED || !slots || !slots.length) return [];
  const keys = slots.map(s => s.settingKey);
  const { rows } = await _db().query(
    'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [keys]
  );
  const urlOf = {};
  for (const r of rows) if (r.value) urlOf[r.key] = r.value;

  const out = [];
  const now = Date.now();
  for (const s of slots) {
    const k = s.settingKey;
    // ★ 누적: 슬롯 하나 = 이미지 여러 장. key 에 **URL 해시 접미**(#xxxx)를 붙인다 —
    //   gemini 의 캐시 지문(sampleSig)이 key 목록으로 만들어지므로, 장수·구성이 바뀌면
    //   지문이 바뀌어 옛 캐시가 새 예시를 모른 채 히트하는 것을 막는다(classify 접두 상향과 같은 규율).
    for (const url of parseSampleUrls(urlOf[k])) {
      const imgId = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
      const sampleKey = s.key + '#' + imgId;
      const ck = k + '|' + url;
      const hit = _sampleCache.get(ck);
      if (hit && (now - hit.ts) < SAMPLE_TTL) {
        out.push({ key: sampleKey, label: s.label, kind: s.kind, data: hit.data, mimeType: hit.mimeType });
        continue;
      }
      const f = await _fetchSample(url);
      if (!f) continue;
      _sampleCache.set(ck, { ...f, ts: now });
      out.push({ key: sampleKey, label: s.label, kind: s.kind, data: f.data, mimeType: f.mimeType });
    }
  }
  return out;
}

/**
 * 동봉 상한 트림 — 슬롯별 **최근 등록 우선 + 라운드로빈**으로 고르게 줄인다.
 * ★ 라운드로빈이라 각 슬롯이 최소 1장은 살아남는다 — 특정 슬롯(예: 자동분류 예시)이
 *   통째로 잘려 판별 재료가 사라지는 것 방지. 잘리면 로그로 말한다(조용한 절단 금지).
 */
function _trimSamples(samples, cap = SAMPLE_ATTACH_CAP) {
  if (!Array.isArray(samples) || samples.length <= cap) return samples || [];
  const groups = new Map();
  for (const s of samples) {
    const base = String(s.key || '').split('#')[0];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(s);
  }
  for (const arr of groups.values()) arr.reverse();   // 뒤에 붙은 것 = 최근 등록 → 우선
  const out = [];
  let added = true;
  while (out.length < cap && added) {
    added = false;
    for (const arr of groups.values()) {
      if (arr.length && out.length < cap) { out.push(arr.shift()); added = true; }
    }
  }
  logger.info(`[reviewInspect] 예시 ${samples.length}장 → ${out.length}장 동봉(판정당 상한 ${cap})`);
  return out;
}

/**
 * 기대 채널에 해당하는 예시이미지들. 등록된 게 없으면 빈 배열 =
 * **오늘과 완전히 같은 동작**(예시를 안 올리면 아무것도 안 바뀐다).
 */
async function loadSamplesFor(expectedChannel) {
  if (!SAMPLES_ENABLED || !expectedChannel) return [];
  try {
    const { samplesForChannel, sampleSettingKey } = require('../utils/reviewSampleChannels');
    const slots = samplesForChannel(expectedChannel)
      .map(s => ({ key: s.key, label: s.label, settingKey: sampleSettingKey(s.key), kind: 'review' }));
    return await _loadSampleSlots(slots);
  } catch (e) {
    logger.warn(`[reviewInspect] 예시이미지 준비 실패(미동봉): ${e.message}`);
    return [];
  }
}

/**
 * 그 채널의 **현금영수증** 판별 예시(receipt 슬롯 검수용). 리뷰 예시와 같은 규율:
 * ★ 채널을 모르면 빈 배열(미동봉), 등록 전이면 빈 배열 = 오늘과 동작 동일.
 * ★ `key` 에 `receipt_` 접두를 붙인다 — classify 캐시 지문이 슬롯 key 로 만들어지므로
 *   리뷰 예시(`coupang_pc`…)와 **절대 겹치면 안 된다**(겹치면 다른 예시로 판정한 결과가 히트).
 */
async function loadReceiptSamplesFor(expectedChannel) {
  if (!SAMPLES_ENABLED || !expectedChannel) return [];
  try {
    const { CASH_RECEIPT_CHANNELS, cashReceiptSampleSettingKey } = require('../utils/cashReceiptChannels');
    const hit = CASH_RECEIPT_CHANNELS.find(c => c.key === expectedChannel);
    if (!hit) return [];
    return await _loadSampleSlots([{
      key: 'receipt_' + hit.key,
      label: hit.label + ' 현금영수증',
      settingKey: cashReceiptSampleSettingKey(hit.key),
      kind: 'receipt',
    }]);
  } catch (e) {
    logger.warn(`[reviewInspect] 현금영수증 예시 준비 실패(미동봉): ${e.message}`);
    return [];
  }
}

/** 관리자 화면용 — 현금영수증 예시 슬롯별 등록 여부(채널 표는 서버 단일 출처). */
async function receiptSampleSettings() {
  const { CASH_RECEIPT_CHANNELS, CASH_RECEIPT_SAMPLE_SETTING_KEYS, cashReceiptSampleSettingKey } =
    require('../utils/cashReceiptChannels');
  const out = CASH_RECEIPT_CHANNELS.map(c => ({
    key: c.key, label: c.label, emoji: c.icon || '🧾', imageUrl: '',
  }));
  try {
    const { rows } = await _db().query(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [CASH_RECEIPT_SAMPLE_SETTING_KEYS]
    );
    const m = {};
    for (const r of rows) m[r.key] = r.value || '';
    for (const s of out) { s.imageUrls = parseSampleUrls(m[cashReceiptSampleSettingKey(s.key)]); s.imageUrl = s.imageUrls[0] || ''; }
  } catch (e) {
    logger.warn(`[reviewInspect] 현금영수증 예시 조회 실패: ${e.message}`);
  }
  return out;
}

/** 현금영수증 예시 저장(''=제거). 채널 화이트리스트는 utils/cashReceiptChannels 단일 출처. */
async function saveReceiptSample({ channel, imageUrl, mode, index } = {}) {
  const { isCashReceiptChannelKey, cashReceiptSampleSettingKey } = require('../utils/cashReceiptChannels');
  const ch = String(channel || '');
  // ★ 화이트리스트 — 목록에 없는 키를 받으면 임의 app_settings 키가 생성된다.
  if (!isCashReceiptChannelKey(ch)) throw new Error('알 수 없는 채널입니다.');
  return _mutateSampleList(cashReceiptSampleSettingKey(ch), { imageUrl, mode, index });
}

/* ── 자동 분류(파일 라우팅) 판별 예시 — 구매캡처·구매확정 (utils/routeSampleKinds 단일 출처) ──
 * 주문내역과 구매확정 화면은 생김새가 비슷해, **두 장이 모두 등록**돼야 구매캡처
 * 자동 이동이 켜진다(captureRoute.needsRouteSamples — 사용자 확정 2026-08-05).
 * ★ key 는 `route_` 접두 — classify 캐시 지문이 예시 key 로 만들어지므로
 *   리뷰(coupang_pc…)·현금영수증(receipt_*) 예시와 절대 겹치면 안 된다. */
async function loadRouteSamples() {
  if (!SAMPLES_ENABLED) return [];
  try {
    const { ROUTE_SAMPLE_KINDS } = require('../utils/routeSampleKinds');
    return await _loadSampleSlots(ROUTE_SAMPLE_KINDS.map(s => ({
      key: 'route_' + s.key, label: s.label, settingKey: s.settingKey, kind: s.kind,
    })));
  } catch (e) {
    logger.warn(`[reviewInspect] 자동분류 예시 준비 실패(미동봉): ${e.message}`);
    return [];
  }
}

/** 관리자 화면용 — 자동 분류 예시 슬롯별 등록 여부. */
async function routeSampleSettings() {
  const { ROUTE_SAMPLE_KINDS, ROUTE_SAMPLE_SETTING_KEYS, routeSampleSettingKey } = require('../utils/routeSampleKinds');
  const out = ROUTE_SAMPLE_KINDS.map(s => ({ key: s.key, label: s.label, emoji: s.emoji || '🛒', imageUrl: '' }));
  try {
    const { rows } = await _db().query(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [ROUTE_SAMPLE_SETTING_KEYS]
    );
    const m = {};
    for (const r of rows) m[r.key] = r.value || '';
    for (const s of out) { s.imageUrls = parseSampleUrls(m[routeSampleSettingKey(s.key)]); s.imageUrl = s.imageUrls[0] || ''; }
  } catch (e) {
    logger.warn(`[reviewInspect] 자동분류 예시 조회 실패: ${e.message}`);
  }
  return out;
}

/** 자동 분류 예시 저장(''=제거). 슬롯 화이트리스트는 utils/routeSampleKinds 단일 출처. */
async function saveRouteSample({ key, imageUrl, mode, index } = {}) {
  const { isRouteSampleKey, routeSampleSettingKey } = require('../utils/routeSampleKinds');
  const k = String(key || '');
  if (!isRouteSampleKey(k)) throw new Error('알 수 없는 예시 슬롯입니다.');
  return _mutateSampleList(routeSampleSettingKey(k), { imageUrl, mode, index });
}

/**
 * ★★ 제출 이미지 판별에 동봉할 예시의 **단일 조립 지점** — 1차 필터(review-precheck)·
 * 업로드 검수(review-upload verifyCapture)·2차 검수(inspectSubmission)·소급 스윕이
 * 전부 이 함수를 쓴다. 조립처가 갈리면 sampleSig(캐시 지문)가 갈려 **같은 이미지에
 * AI 콜이 두 번** 나간다(순증 0 전제가 깨진다 — 완화 금지).
 * 자동 분류 예시(route)는 채널과 무관하게 등록돼 있으면 항상 동봉한다(2장 상한).
 */
async function submissionSamples({ expectedChannel, slotKey = 'review' } = {}) {
  const base = slotKey === 'receipt'
    ? await loadReceiptSamplesFor(expectedChannel)
    : await loadSamplesFor(expectedChannel);
  const route = await loadRouteSamples();
  // ★ 판정당 동봉 상한 — 장수만큼 토큰·지연이 늘어 첨부 즉시 판별의 응답성을 해친다.
  return _trimSamples(base.concat(route));
}

/** 관리자 화면용 — 슬롯별 등록 여부. */
async function sampleSettings() {
  const { REVIEW_SAMPLES, sampleSettingKey, REVIEW_SAMPLE_KEYS } = require('../utils/reviewSampleChannels');
  const out = REVIEW_SAMPLES.map(s => ({ ...s, imageUrl: '' }));
  try {
    const { rows } = await _db().query(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [REVIEW_SAMPLE_KEYS]
    );
    const m = {};
    for (const r of rows) m[r.key] = r.value || '';
    for (const s of out) { s.imageUrls = parseSampleUrls(m[sampleSettingKey(s.key)]); s.imageUrl = s.imageUrls[0] || ''; }
  } catch (e) {
    logger.warn(`[reviewInspect] 예시이미지 조회 실패: ${e.message}`);
  }
  return out;
}

/** 예시이미지 저장(''=제거). https 절대 URL만 — 관리자 화면에 <img src>로 나간다. */
async function saveSample({ key, imageUrl, mode, index } = {}) {
  const { isReviewSampleKey, sampleSettingKey } = require('../utils/reviewSampleChannels');
  if (!isReviewSampleKey(key)) throw new Error('알 수 없는 예시 슬롯입니다.');
  return _mutateSampleList(sampleSettingKey(key), { imageUrl, mode, index });
}

/* ══════════════════════════════════════════════════════════════════
 * 2차 검수 (M1) — 제출 이후 대조
 * ════════════════════════════════════════════════════════════════ */

/** 파일 지문. base64 를 이미 쥔 시점에 계산하므로 추가 I/O 0. */
function hashBase64(b64) {
  const clean = String(b64 || '').replace(/^data:image\/[a-z]+;base64,/, '');
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

/** 상품명 비교용 정규화 — 공백·괄호·특수문자 제거 후 소문자. */
function _normProduct(s) {
  return String(s || '').toLowerCase().replace(/[\s\[\]()（）{}·・,，/|_+~"'`]/g, '');
}

/**
 * 대조 전 정리 — 실측(2026-08-05 이노크아든 건)에서 "같은 상품인데 다름"이 나온 원인 3가지를 벗긴다:
 *   ① 캡처 상품명의 꼬리 말줄임(`…`/`...`) — 쇼핑몰 화면이 긴 이름을 자른다
 *   ② 기대값의 선행 번호(`1. `) — 작업오더 상품 목록 표기가 붙어 온다
 *   ③ 기대값의 URL 꼬리(`(https:…`) — 상품 URL 이 이름 뒤에 딸려 온다
 * 정리 후 부분 포함(includes)으로 잡히게 하는 게 목적 — 지우는 오탐이 나도
 * 대조가 느슨해질 뿐(미탐 방향) 정상 제출을 불량으로 몰지 않는다.
 */
function _cleanProductForMatch(s) {
  return String(s || '')
    .replace(/(…|‥|\.{2,})\s*$/g, ' ')      // 꼬리 말줄임
    .replace(/^\s*\d+\s*[.)]\s*/, '')        // 선행 번호 "1. " / "2)"
    .replace(/\(?\s*https?:\S*/gi, ' ')      // URL 꼬리(괄호 열림 포함 — "(https:" 절단형까지)
    .trim();
}

/**
 * 캡처 속 상품명 ↔ 기대 상품명 대조.
 * ★ 쇼핑몰 화면은 상품명을 줄여 쓰거나 말줄임(…)하므로 **부분 포함도 일치로 인정**한다.
 *   기대값이 없으면 'skip'(대조 안 함) — 판정 불가를 불량으로 취급하지 않는다.
 * @returns {{verdict:'pass'|'warn'|'skip', expected:string[], ocr:string}}
 */
/** 정규화 기준 중복 없이 병합 — 별칭 가산용(원본 표기는 보존). */
function _mergeProductNames(base, extra) {
  const seen = new Set();
  const out = [];
  for (const v of [...(base || []), ...(extra || [])]) {
    const k = _normProduct(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function matchProductName(ocr, expectedList) {
  const list = (Array.isArray(expectedList) ? expectedList : [])
    .map(s => String(s || '').trim()).filter(Boolean);
  // ★ 말줄임·번호·URL 을 벗긴 뒤 대조한다(_cleanProductForMatch) — 벗기지 않으면
  //   "이노크아든 …다회용…" vs "1. 이노크아든 …교체형 (https:" 처럼 같은 상품이 다름으로 나온다.
  const o = _normProduct(_cleanProductForMatch(ocr));
  if (!list.length) return { verdict: 'skip', expected: [], ocr: String(ocr || '') };
  if (!o) return { verdict: 'skip', expected: list, ocr: '' };
  for (const e of list) {
    const n = _normProduct(_cleanProductForMatch(e));
    if (!n) continue;
    if (o.includes(n) || n.includes(o)) return { verdict: 'pass', expected: list, ocr: String(ocr) };
    // 말줄임 대비: 앞 6글자가 겹치면 같은 상품으로 본다(오탐보다 미탐을 택함)
    if (n.length >= 6 && o.length >= 6 && n.slice(0, 6) === o.slice(0, 6)) {
      return { verdict: 'pass', expected: list, ocr: String(ocr) };
    }
  }
  return { verdict: 'warn', expected: list, ocr: String(ocr) };
}

/** 항목별 판정 → 종합 status. 하나라도 fail → fail / warn 있으면 suspect / 나머지 pass. */
function computeStatus(checks) {
  const vs = Object.values(checks || {}).map(c => (c && c.verdict) || 'skip');
  if (!vs.length) return 'pending';
  if (vs.includes('fail')) return 'fail';
  if (vs.includes('warn')) return 'suspect';
  if (vs.every(v => v === 'skip')) return 'unverifiable';
  return 'pass';
}

/* ── 기대 상품명 공급 ─────────────────────────────────────────────
   ★ 우선순위: ① 탭에 직접 적어둔 값(`inspect_product_names`) → ② 연결된 작업오더.
     ①이 있으면 ②는 보지 않는다 — 관리자가 명시한 값이 항상 이긴다(시트 표기와
     작업오더 표기가 다를 때 손으로 잡는 칸이라, 자동값이 섞이면 그 의도가 무너진다). */

/** "옵션 없음"류는 상품명이 아니라 **서술**이다 — 기대값에 넣으면 아무 리뷰나 통과한다. */
const _NON_PRODUCT = /^(옵션\s*없음|없음|단일(\s*상품)?|해당\s*없음|기본|공통|-|없슴)$/;
function _isNonProduct(s) { return _NON_PRODUCT.test(String(s || '').trim()); }

/** 가격·수량 꼬리 제거 — "힙스 31400원" → "힙스", "A 28,900원" → "A" */
function _stripPriceTail(s) {
  return String(s || '')
    .replace(/결제\s*금액\s*[:：]?\s*[\d,]+\s*원?/g, ' ')
    .replace(/[\d,]{3,}\s*원/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 작업오더 → 기대 상품명 후보(순수함수).
 * ★ 후보를 넉넉히 모으는 쪽이 맞다 — 하나라도 맞으면 통과이므로, 후보가 많을수록
 *   **오탐(정상 리뷰를 의심 처리)이 줄고** 미탐만 조금 늘어난다. 이 기능의 실패 선호와 일치.
 */
function productNamesFromWorkOrder(wo) {
  const out = [];
  const push = (s) => {
    const v = _stripPriceTail(String(s || '').replace(/\|/g, '')).trim();
    if (v && v.length >= 2 && !_isNonProduct(v)) out.push(v);
  };
  if (!wo) return out;

  // ① 구조화 JSON — [{ name, base:{pay}, options:[{label,pay}] }] (프론트 _woOptionRows 와 같은 형태)
  try {
    const arr = JSON.parse(wo.product_options_json || '[]');
    if (Array.isArray(arr)) for (const p of arr) push(p && p.name);
  } catch (_) { /* 깨진 JSON 은 무시하고 아래 텍스트 경로로 */ }

  // ② 자유서술 텍스트 — 줄 단위, 구분자 앞 조각이 상품명
  //    실측 형식: "A - 옵1 - 결제금액 28,900원" / "상품A / 레드 / 12,000원" / "힙스 31400원"
  for (const line of String(wo.product_option || '').split(/[\n\r]+/)) {
    const t = line.trim();
    if (!t) continue;
    const head = t.split(/\s*[-–/|]\s*/)[0];
    push(head);
  }

  // 중복 제거(정규화 기준) — 같은 상품이 JSON·텍스트 양쪽에 있을 수 있다
  const seen = new Set();
  return out.filter(v => {
    const k = _normProduct(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 이 탭에 연결된 작업오더 1건. Track B 링크 우선 → work_orders.linked_tab_* 폴백.
 * ★ work_orders 는 **읽기만** 한다(Track A 승인 흐름이 linked_tab_* 를 보고 분기하므로).
 */
async function _workOrderForTab({ sheetId, tabName } = {}) {
  try {
    // ★★ 우선순위를 ORDER BY 로 **명시**한다 — 두 조건을 OR 로만 묶으면 Track B 링크가
    //   있어도 `created_at` 이 더 최근인 폴백 오더가 이긴다(실측으로 잡힘).
    //   0 = Track B 링크(명시적 지정) / 1 = work_orders.linked_tab_* 폴백.
    const { rows } = await _db().query(
      `SELECT w.title, w.product_option, w.product_options_json,
              CASE WHEN EXISTS (SELECT 1 FROM trackb_work_order_links l
                                 WHERE l.work_order_id = w.id AND l.deleted_at IS NULL
                                   AND l.sheet_id = $1 AND l.tab_name = $2)
                   THEN 0 ELSE 1 END AS link_rank
         FROM work_orders w
        WHERE w.deleted_at IS NULL
          AND ( EXISTS (SELECT 1 FROM trackb_work_order_links l
                         WHERE l.work_order_id = w.id AND l.deleted_at IS NULL
                           AND l.sheet_id = $1 AND l.tab_name = $2)
                OR (w.linked_tab_sheet_id = $1 AND w.linked_tab_name = $2) )
        ORDER BY link_rank, w.created_at DESC
        LIMIT 1`,
      [sheetId, tabName]
    );
    return rows[0] || null;
  } catch (e) {
    logger.warn(`[reviewInspect] 작업오더 조회 실패(상품명 대조 생략): ${e.message}`);
    return null;
  }
}

/** 탭 설정에서 기대 채널·기대 상품명·리뷰타입을 읽는다. 실패는 빈 값(대조 생략). */
async function loadTabExpectations({ sheetId, tabName } = {}) {
  const out = { expectedChannel: null, productNames: [], reviewType: null };
  if (!sheetId || !tabName) return out;
  try {
    // ★ LATERAL 최신 1행 — 서브쿼리를 둘로 나누면 채널과 커스텀값이 서로 **다른 공고**에서
    //   올 수 있다(같은 탭에 공고가 여러 개면 실제로 갈린다). 한 행에서 둘 다 가져온다.
    // ★ 087: 리뷰타입도 **같은 행에서** 가져온다 — 따로 조회하면 채널과 다른 공고의 값이 섞인다.
    // ★★ 리뷰타입은 **별도 LATERAL**(`reviewTypeContext.CAMPAIGN_REVIEW_TYPE_LATERAL` 단일 출처)로
    //   찾는다 — 채널 LATERAL 은 `channel`+`channel_custom` 이 **같은 행**에서 와야 하므로
    //   그대로 두고, 리뷰타입만 리네임(gid 폴백)·차수 재발행(값 있는 최신 공고)에 강한 규칙을 쓴다.
    //   두 규칙을 한 LATERAL 에 합치면 채널 짝이 깨진다.
    const { rows } = await _db().query(
      `SELECT c.inspect_product_names, c.inspect_product_aliases, c.review_type AS tab_review_type,
              rc.channel, rc.channel_custom, rt.review_type AS camp_review_type
         FROM tab_configs c
         LEFT JOIN LATERAL (
              SELECT channel, channel_custom
                FROM recruit_campaigns
               WHERE linked_sheet_id = c.sheet_id AND linked_tab_name = c.tab_name
               ORDER BY created_at DESC
               LIMIT 1
         ) rc ON TRUE${require('./reviewTypeContext.service').CAMPAIGN_REVIEW_TYPE_LATERAL}
        WHERE c.sheet_id = $1 AND c.tab_name = $2
        LIMIT 1`,
      [sheetId, tabName]
    );
    const r = rows[0];
    if (!r) return out;
    const ch = r.channel === '직접입력' ? (r.channel_custom || '') : (r.channel || '');
    out.expectedChannel = expectedChannelKey(ch);
    // ★ 087: 행 단위 값(시트 작업옵션 칸)은 여기서 알 수 없다 → 공고 > 탭 순서만 본다.
    //   행 값까지 더한 최종 판정은 호출부가 resolveReviewType 으로 합친다(단일 출처).
    out.reviewType = resolveReviewType({
      campaignType: r.camp_review_type, tabReviewType: r.tab_review_type,
    });
    // ★ 별칭(=[정상] 확인에서 학습된 인정 표기)은 어느 소스든 **가산만** 한다 —
    //   manual/work_order 우선순위 규칙(manual 있으면 파생 안 봄)을 절대 바꾸지 않는다.
    const aliases = String(r.inspect_product_aliases || '')
      .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    out.productNames = String(r.inspect_product_names || '')
      .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    if (out.productNames.length) {
      out.productSource = 'manual';
      out.productNames = _mergeProductNames(out.productNames, aliases);
      return out;
    }

    // 직접 적어둔 값이 없으면 연결된 작업오더에서 파생한다
    const wo = await _workOrderForTab({ sheetId, tabName });
    const derived = productNamesFromWorkOrder(wo);
    if (derived.length) { out.productNames = _mergeProductNames(derived, aliases); out.productSource = 'work_order'; }
    else if (aliases.length) { out.productNames = aliases; out.productSource = 'aliases'; }
  } catch (e) {
    logger.warn(`[reviewInspect] 탭 기대값 조회 실패(대조 생략): ${e.message}`);
  }
  return out;
}

/** 관리자 화면용 — 이 탭의 기대 상품명 현황(수동값 + 작업오더 파생값을 함께 보여준다). */
async function productNameSettings({ sheetId, tabName } = {}) {
  const out = { manual: '', aliases: '', derived: [], effective: [], source: 'none' };
  try {
    const { rows } = await _db().query(
      'SELECT inspect_product_names, inspect_product_aliases FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );
    out.manual = String(rows[0]?.inspect_product_names || '');
    out.aliases = String(rows[0]?.inspect_product_aliases || '');   // [정상] 확인에서 학습된 인정 별칭
    out.derived = productNamesFromWorkOrder(await _workOrderForTab({ sheetId, tabName }));
    const manualList = out.manual.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    if (manualList.length) { out.effective = manualList; out.source = 'manual'; }
    else if (out.derived.length) { out.effective = out.derived; out.source = 'work_order'; }
  } catch (e) {
    logger.warn(`[reviewInspect] 기대 상품명 조회 실패: ${e.message}`);
  }
  return out;
}

/** 학습된 인정 별칭 편집·비우기(줄바꿈 구분) — 자동 학습이지만 사람이 언제든 다듬을 수 있어야
 *  "조용한 자동수정"이 아니다. 빈 값 = 전부 비움. */
async function saveProductAliases({ sheetId, tabName, text } = {}) {
  const v = String(text == null ? '' : text)
    .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean).slice(0, 60).join('\n').slice(0, 4000);
  await _db().query(
    'UPDATE tab_configs SET inspect_product_aliases = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
    [v, sheetId, tabName]
  );
  return v;
}

/** 탭별 기대 상품명 저장(줄바꿈 구분). 빈 값 = 해제(작업오더 파생으로 되돌아간다). */
async function saveProductNames({ sheetId, tabName, text } = {}) {
  const v = String(text == null ? '' : text)
    .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean).slice(0, 20).join('\n').slice(0, 2000);
  await _db().query(
    'UPDATE tab_configs SET inspect_product_names = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
    [v, sheetId, tabName]
  );
  return v;
}

/**
 * 같은 파일 지문이 **다른 사람·다른 자리**에 이미 있는가.
 * ★ 같은 (시트·탭·행·리뷰어)의 재업로드는 중복이 아니다 — Drive 는 재업로드마다
 *   새 file_id 를 만들므로, 이걸 중복으로 잡으면 정상적인 재제출이 전부 불량이 된다.
 */
async function findDuplicate({ fileHash, fileId, sheetId, tabName, rowIndex, reviewerName } = {}) {
  if (!fileHash) return { verdict: 'skip' };
  try {
    const { rows } = await _db().query(
      `SELECT file_id, sheet_id, tab_name, row_index, reviewer_name, uploaded_at
         FROM review_submissions
        WHERE file_hash = $1
          AND file_id <> COALESCE($2, '')
          AND NOT (sheet_id = $3 AND tab_name = $4
                   AND COALESCE(row_index, -1) = COALESCE($5::int, -1)
                   AND COALESCE(reviewer_name, '') = COALESCE($6, ''))
        ORDER BY uploaded_at ASC NULLS LAST
        LIMIT 1`,
      [fileHash, fileId || null, sheetId, tabName, rowIndex ?? null, reviewerName || '']
    );
    if (!rows.length) return { verdict: 'pass' };
    const m = rows[0];
    return {
      verdict: 'fail',
      matchFileId: m.file_id, matchTab: m.tab_name, matchSheetId: m.sheet_id,
      matchReviewer: m.reviewer_name || '', matchRow: m.row_index,
      matchAt: m.uploaded_at,
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 중복 대조 실패(통과 처리): ${e.message}`);
    return { verdict: 'skip' };
  }
}

/**
 * ★★ "한 캡처에 여러 리뷰" 완화 — 같은 파일이라고 **다 중복이 아니다**(실사고 2026-08-06).
 *
 * 실제 신고: 리뷰어가 두 작업(노티드 두바이 쫀득쿠키 / 노티드 슈가베어 우유크림 폭탄떡)에
 * 동시에 참여했고, 쿠팡 **리뷰관리 화면에는 두 리뷰가 한 화면에 나란히** 보였다. 그래서 캡처
 * 한 장으로 두 건을 냈다 — **리뷰어가 맞게 행동한 것**인데 검수는 "중복파일"로 불량 처리했다.
 *
 * 그래서 같은 지문(hash)이라도 **세 갈래로 나눈다**:
 *   ㉮ 같은 작업 안에서 재사용            → fail (분명한 중복 — 종전 그대로)
 *   ㉯ **다른 리뷰어**가 같은 파일        → fail (도용 — 종전 그대로)
 *   ㉰ **같은 리뷰어 + 다른 작업**        → warn (사람이 본다) — 자동 불량·자동 제거 대상 아님
 *      └ 그 캡처에서 **두 작업의 기대 상품명이 모두** 읽히면 → pass (근거 있는 자동 통과)
 *
 * ★ 자동 통과는 **근거가 있을 때만** — 두 작업의 상품이 서로 다르고 둘 다 캡처에서 읽혀야 한다.
 *   근거 없이 통과시키면 "다른 캠페인에 같은 캡처 돌려쓰기"(진짜 재사용)까지 열린다.
 * ★ 근거를 못 찾아도 **fail 로는 되돌리지 않는다** — 정상 리뷰어를 불량으로 모는 쪽이,
 *   사람이 한 번 더 보는 쪽보다 나쁘다(이 저장소의 fail-open 규율).
 * ★ 조회 실패는 **판정을 바꾸지 않는다**(원래 verdict 유지) — 모르면 완화하지 않는다.
 */
const _normName = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
async function classifyDuplicateContext({ dup, cls, exp, sheetId, tabName, reviewerName } = {}) {
  if (!dup || dup.verdict !== 'fail' || !dup.matchFileId) return dup;
  const me = _normName(reviewerName), other = _normName(dup.matchReviewer);
  const sameReviewer = !!me && me === other;
  const otherWork = (dup.matchSheetId && dup.matchSheetId !== sheetId) || dup.matchTab !== tabName;
  if (!sameReviewer || !otherWork) return dup;    // ㉮㉯ = 종전 그대로 불량

  let hitHere = null, hitOther = null;
  try {
    const oexp = await loadTabExpectations({ sheetId: dup.matchSheetId || sheetId, tabName: dup.matchTab });
    // 캡처에서 읽어낸 모든 문자열을 한 덩어리로 놓고 두 작업의 기대 상품명을 각각 찾는다.
    const text = [cls && cls.productName, cls && cls.reviewText, ...(((cls && cls.signals) || []))]
      .filter(Boolean).join(' \n ');
    hitHere = _productHit(text, (exp && exp.productNames) || []);
    hitOther = _productHit(text, (oexp && oexp.productNames) || []);
  } catch (_) { /* 조회 실패 = 근거 없음(아래에서 warn) */ }

  if (hitHere && hitOther && _normProduct(hitHere) !== _normProduct(hitOther)) {
    return { ...dup, verdict: 'pass', multiReview: true, products: [hitHere, hitOther] };
  }
  return { ...dup, verdict: 'warn', sameReviewerOtherTab: true };
}

/** 기대 상품명 목록 중 그 캡처 텍스트에서 실제로 읽힌 것 하나(없으면 null). */
function _productHit(text, names) {
  const t = _normProduct(_cleanProductForMatch(text));
  if (!t) return null;
  for (const e of (names || [])) {
    const n = _normProduct(_cleanProductForMatch(e));
    if (n && n.length >= 3 && t.includes(n)) return e;
  }
  return null;
}

/**
 * 첨부 즉시 중복 대조 — **그 리뷰어 본인이 앞서 낸 사진**과 같은 파일인지(사용자 확정 ②:
 * 작업 무관 본인 전체). 사진이 저장되기 **전**에 알려주는 것이 이 함수의 존재 이유다.
 *
 * ★★ 같은 자리(같은 작업·같은 줄) 재첨부는 **중복이 아니다** — 잘못 올려 다시 올리는 정상
 *    재제출이라, 이걸 잡으면 멀쩡한 리뷰어가 갇힌다(2차 검수 findDuplicate 와 같은 규율).
 * ★ 본인 확인은 **이름 + (가능하면) 연락처 뒤 8자리** — 지문이 맞는 행만 대조하므로 비용이 없다.
 *   동명이인 오탐이 나더라도 **경고일 뿐 차단이 아니라서**(사용자 확정 ①) 피해가 없다.
 * ★ 반환하는 파일ID는 **본인 것뿐** — 남의 제출물은 어떤 경우에도 나가지 않는다.
 * ★ 판정 불가·조회 실패는 전부 null(경고 없음) = 오늘과 동작 동일(fail-open).
 */
async function findOwnDuplicate({ fileHash, sheetId, tabName, rowIndex, reviewerName, phone8 } = {}) {
  const name = String(reviewerName || '').trim();
  if (!fileHash || !name) return null;
  try {
    const { rows } = await _db().query(
      `SELECT s.file_id, s.sheet_id, s.tab_name, s.row_index, s.uploaded_at,
              (SELECT r.phone8 FROM review_index r
                WHERE r.sheet_id = s.sheet_id AND r.tab_name = s.tab_name
                  AND r.row_index = s.row_index LIMIT 1) AS phone8
         FROM review_submissions s
        WHERE s.file_hash = $1
          AND COALESCE(s.slot_key, 'review') <> 'trashed'
          AND REPLACE(COALESCE(s.reviewer_name, ''), ' ', '') = REPLACE($2, ' ', '')
          AND NOT (s.sheet_id = $3 AND s.tab_name = $4
                   AND COALESCE(s.row_index, -1) = COALESCE($5::int, -1))
        ORDER BY s.uploaded_at DESC NULLS LAST
        LIMIT 5`,
      [fileHash, name, sheetId || '', tabName || '', rowIndex ?? null]
    );
    if (!rows.length) return null;
    // ★ 연락처를 알 수 있으면 **본인 행만** 남긴다(동명이인 오탐 축소). 모르면 이름만으로 진행.
    const p8 = String(phone8 || '').replace(/\D/g, '');
    const pick = (p8.length === 8 ? rows.filter(r => !r.phone8 || r.phone8 === p8) : rows)[0] || null;
    if (!pick) return null;
    return {
      fileId: pick.file_id,
      sameTab: !!(sheetId && tabName) && pick.sheet_id === sheetId && pick.tab_name === tabName,
      rowIndex: pick.row_index,
      uploadedAt: pick.uploaded_at,
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 첨부 중복 대조 실패(경고 생략): ${e.message}`);
    return null;
  }
}

/**
 * 본문 텍스트 겹침 — 같은 탭 안에서만 비교(기본).
 *
 * ★★ 판정식이 `similarity` 단독이 아닌 이유 (로컬 PG16 실측):
 *   가장 흔한 복붙 수법은 **남의 리뷰를 그대로 붙이고 문장 한두 개를 덧붙이는 것**인데,
 *   trigram `similarity` 는 길이가 벌어지면 급격히 떨어져 이걸 놓친다.
 *     원문 + 한 문장 추가 → 0.859 / 두 문장 추가 → 0.718  (둘 다 0.9 기준을 빠져나감)
 *   `word_similarity` 는 "한쪽이 다른 쪽의 연속 구간에 들어있는가"를 재므로 둘 다 1.000 으로 잡는다.
 *
 * ★ 다만 word_similarity 만 쓰면 **짧은 관용구가 긴 리뷰에 통째로 들어있을 때** 1.000 이 나온다
 *   (실측: 27자 관용구 ⊂ 94자 리뷰 → 1.000). 그래서 **길이비 가드**를 둔다 —
 *   두 글의 길이가 비슷할 때(기본 0.5 이상)만 word_similarity 를 쓰고, 아니면 similarity 만 본다.
 *     위 오탐 케이스는 길이비 0.29 → 0.298 로 떨어져 걸리지 않고,
 *     복붙+추가(길이비 0.85·0.71)는 1.000 을 유지한다.
 *
 * ★ 짧은 글은 애초에 비교하지 않는다: "맛있어요 재구매의사 있습니다" 같은 관용구는
 *   누구나 비슷해 오탐이 된다.
 */
async function findSimilarText({ text, fileId, sheetId, tabName } = {}) {
  const t = String(text || '').trim();
  if (t.length < MIN_TEXT) return { verdict: 'skip', reason: 'too_short' };
  try {
    const { rows } = await _db().query(
      `SELECT file_id, reviewer_name, row_index, tab_name,
              CASE WHEN LEAST(length(ocr_text), length($1))::numeric
                        / GREATEST(length(ocr_text), length($1)) >= $6
                   THEN GREATEST(similarity(ocr_text, $1),
                                 word_similarity(ocr_text, $1),
                                 word_similarity($1, ocr_text))
                   ELSE similarity(ocr_text, $1)
              END AS score
         FROM review_inspections
        WHERE ($7::boolean OR (sheet_id = $2 AND tab_name = $3))
          AND file_id <> COALESCE($4, '')
          AND ocr_text IS NOT NULL AND length(ocr_text) >= $5
        ORDER BY score DESC
        LIMIT 1`,
      [t, sheetId, tabName, fileId || null, MIN_TEXT, SIM_LEN_RATIO, SIM_SCOPE === 'global']
    );
    const top = rows[0];
    if (!top || !(Number(top.score) >= SIM_THRESHOLD)) {
      return { verdict: 'pass', score: top ? Number(top.score) : 0, scope: SIM_SCOPE };
    }
    return {
      verdict: 'warn', score: Number(top.score), scope: SIM_SCOPE,
      matchFileId: top.file_id, matchReviewer: top.reviewer_name || '', matchRow: top.row_index,
      matchTab: top.tab_name || '',
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 유사도 대조 실패(통과 처리): ${e.message}`);
    return { verdict: 'skip' };
  }
}

/**
 * 작성자 표기(마스킹) 재사용 — 같은 `김**` 이 **다른 리뷰어**의 제출에 반복 등장하면
 * 한 계정으로 여러 명의 리뷰를 대신 쓰고 있다는 신호다.
 *
 * ★ 이름 대조가 아니다(마스킹이라 실명과 맞출 수 없다). **같은 표기의 재등장 패턴**만 본다.
 * ★ 흔한 마스킹(`김**`)은 동명이인이 많아 **경고까지만** — 절대 차단하지 않는다.
 * ★ 최소 길이 가드: `*` 하나뿐인 값 등 너무 짧은 표기는 신호가 못 된다.
 */
async function findAuthorReuse({ authorMask, fileId, sheetId, tabName, reviewerName } = {}) {
  const a = String(authorMask || '').trim();
  if (a.length < 2 || !AUTHOR_REUSE) return { verdict: 'skip' };
  try {
    const { rows } = await _db().query(
      `SELECT DISTINCT reviewer_name, tab_name
         FROM review_inspections
        WHERE ocr_author = $1
          AND file_id <> COALESCE($2, '')
          AND COALESCE(reviewer_name,'') <> COALESCE($3,'')
          AND ($4::boolean OR (sheet_id = $5 AND tab_name = $6))
        LIMIT 5`,
      [a, fileId || null, reviewerName || '', SIM_SCOPE === 'global', sheetId, tabName]
    );
    if (!rows.length) return { verdict: 'pass', ocr: a };
    return {
      verdict: 'warn', ocr: a,
      others: rows.map(r => r.reviewer_name).filter(Boolean).slice(0, 5),
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 작성자 재사용 대조 실패(통과): ${e.message}`);
    return { verdict: 'skip' };
  }
}

/**
 * 파일 1장의 2차 검수 — 판정 후 review_inspections 에 업서트.
 * ★ 절대 throw 하지 않는다: 업로드는 이미 끝난 뒤의 후처리라, 여기서 예외가 오르면
 *   "파일은 올라갔는데 제출이 실패"로 보이는 사고가 난다(csBridge 와 같은 규율).
 */
async function inspectSubmission({
  base64, mimeType, fileId, fileHash, sheetId, tabName, rowIndex, reviewerName, slotKey = 'review',
  ...opts
} = {}) {
  if (!ENABLED || !fileId || !sheetId || !tabName) return null;
  try {
    const hash = fileHash || hashBase64(base64);

    // 리뷰 슬롯이 아니면 형식 판정만 남기고 끝낸다(영수증엔 상품명·본문 대조가 무의미).
    const isReview = String(slotKey || 'review') === 'review';

    // ★ 기대값을 **먼저** 읽는다 — 예시이미지 선택에 기대 채널이 필요하고,
    //   같은 samples 를 써야 review-upload 의 verifyCapture 와 캐시가 공유된다.
    const exp = isReview ? await loadTabExpectations({ sheetId, tabName }) : { expectedChannel: null, productNames: [] };

    let cls = null;
    if (base64) {
      try {
        // ★ 첨부 시점 1차 필터가 이미 같은 이미지를 판정했다면 캐시 히트 = AI 콜 0
        const { classifySubmissionImage } = require('./gemini.service');
        const samples = opts.samples || await submissionSamples({ expectedChannel: exp.expectedChannel, slotKey });
        cls = await classifySubmissionImage(base64, mimeType || 'image/jpeg', { samples });
      } catch (_) { cls = null; }   // fail-open
    }

    const checks = {};

    // ① 형식·채널
    // ★★ 구매확정 작업(reviewType 'confirm')의 리뷰 자리는 **구매확정 완료 화면이 정상 제출**이다 —
    //   1차 필터 안전핀(087)·captureVerify._expectedKind 와 같은 규율. 이 분기가 없으면
    //   구매확정 탭의 정상 제출 전건이 "리뷰 화면이 아닌 것으로 판정됨" 불량이 된다(실측 신고).
    //   리뷰 화면도 불량으로 몰지 않는다(잡는 범위를 좁히는 fail-open 방향만).
    //   공고를 뒤늦게 구매확정으로 바꾼 탭은 리뷰검수 [♻ 재검수]로 소급 재판정한다(reinspectTab).
    const _okKinds = exp.reviewType === 'confirm' ? ['review', 'purchase_confirm'] : ['review'];
    if (!cls) {
      checks.format = { verdict: 'skip', reason: 'no_ai' };
    } else if (isReview && !_okKinds.includes(cls.kind) && cls.confidence >= BLOCK_CONFIDENCE) {
      checks.format = { verdict: 'fail', kind: cls.kind, confidence: cls.confidence };
    } else {
      checks.format = {
        verdict: (exp.expectedChannel && cls.channel && cls.channel !== exp.expectedChannel) ? 'warn' : 'pass',
        kind: cls.kind, channel: cls.channel || '', expectedChannel: exp.expectedChannel || '',
        confidence: cls.confidence,
      };
    }

    // ② 상품명 (리뷰 슬롯만)
    checks.product = isReview
      ? matchProductName(cls && cls.productName, exp.productNames)
      : { verdict: 'skip' };

    // ③ 같은 파일 — 슬롯 무관(영수증 재탕도 잡을 값어치가 있다)
    // ★ 같은 리뷰어가 **다른 작업**에 낸 같은 캡처는 "한 화면에 여러 리뷰"일 수 있다 →
    //   classifyDuplicateContext 가 warn/pass 로 완화한다(같은 작업 재사용·타인 도용은 그대로 fail).
    checks.duplicate = await classifyDuplicateContext({
      dup: await findDuplicate({ fileHash: hash, fileId, sheetId, tabName, rowIndex, reviewerName }),
      cls, exp, sheetId, tabName, reviewerName,
    });

    // ④ 본문 겹침 (리뷰 슬롯만)
    checks.similarity = isReview
      ? await findSimilarText({ text: cls && cls.reviewText, fileId, sheetId, tabName })
      : { verdict: 'skip' };

    // ⑤ 작성자 — 실명 대조는 하지 않는다(마스킹이라 불가). 대신 **같은 표기의 재사용**만 본다.
    checks.author = isReview
      ? await findAuthorReuse({ authorMask: cls && cls.authorMask, fileId, sheetId, tabName, reviewerName })
      : { verdict: 'skip', ocr: (cls && cls.authorMask) || '' };

    const status = computeStatus(checks);
    await _upsertInspection({
      fileId, sheetId, tabName, rowIndex, reviewerName, slotKey, status, checks,
      channel: (cls && cls.channel) || null, device: (cls && cls.device) || null,
      ocrProduct: (cls && cls.productName) || null,
      ocrText: (cls && cls.reviewText) || null,
      ocrAuthor: (cls && cls.authorMask) || null,
      fileHash: hash, confidence: (cls && cls.confidence) || null,
    });
    return { status, checks };
  } catch (e) {
    logger.warn(`[reviewInspect] 검수 실패(무시): ${e.message}`);
    return null;
  }
}

async function _upsertInspection(p) {
  try {
    await _db().query(
      `INSERT INTO review_inspections
         (file_id, sheet_id, tab_name, row_index, reviewer_name, slot_key, status, checks,
          channel, device, ocr_product, ocr_text, ocr_author, file_hash, ai_confidence,
          inspected_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
       ON CONFLICT (file_id) DO UPDATE
          SET status = EXCLUDED.status, checks = EXCLUDED.checks,
              channel = EXCLUDED.channel, device = EXCLUDED.device,
              ocr_product = EXCLUDED.ocr_product, ocr_text = EXCLUDED.ocr_text,
              ocr_author = EXCLUDED.ocr_author, file_hash = EXCLUDED.file_hash,
              ai_confidence = EXCLUDED.ai_confidence,
              row_index = EXCLUDED.row_index, reviewer_name = EXCLUDED.reviewer_name,
              inspected_at = NOW(), updated_at = NOW(),
              attempts = review_inspections.attempts + 1`,
      [p.fileId, p.sheetId, p.tabName, p.rowIndex ?? null, p.reviewerName || null, p.slotKey || 'review',
       p.status, JSON.stringify(p.checks || {}), p.channel, p.device, p.ocrProduct, p.ocrText,
       p.ocrAuthor, p.fileHash, p.confidence]
    );
  } catch (e) {
    logger.warn(`[reviewInspect] 판정 기록 실패(무시): ${e.message}`);
  }
}

/** 제출 원장에 파일 지문 기록(중복 대조의 재료). 실패해도 업로드엔 영향 없음. */
async function saveFileHash({ fileId, fileHash } = {}) {
  if (!fileId || !fileHash) return;
  try {
    await _db().query('UPDATE review_submissions SET file_hash = $1 WHERE file_id = $2', [fileHash, fileId]);
  } catch (e) {
    logger.warn(`[reviewInspect] 지문 기록 실패(무시): ${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * M2 배치 스윕 — 미검수 재시도 + 과거 제출분 따라잡기
 *
 * ★ 인라인 검수는 **신규 제출만** 본다. AI 가 죽어 있던 건(pending)과
 *   기능 배포 이전 제출분은 여기서 따라잡는다.
 * ★ 시트 API 무접촉(쿼터 영향 0). Drive 다운로드 + AI 는 **사이클 캡**으로 통제한다.
 * ★ 재시도 상한을 넘으면 `unverifiable` 로 종결 — 무한 재시도 금지
 *   (스마트빌드 실패 시트 처리와 같은 규율).
 * ════════════════════════════════════════════════════════════════ */
const SWEEP_BATCH = Number(process.env.REVIEW_INSPECT_BATCH || 20);
const SWEEP_DAYS = Number(process.env.REVIEW_INSPECT_BACKFILL_DAYS || 30);
const SWEEP_MAX_ATTEMPTS = Number(process.env.REVIEW_INSPECT_MAX_ATTEMPTS || 3);

/** 스윕 대상 — ① 재시도(pending, 상한 미만) ② 검수 이력 없는 과거 제출분(최근분 우선). */
async function _sweepTargets(limit) {
  const { rows } = await _db().query(
    `(SELECT s.file_id, s.sheet_id, s.tab_name, s.row_index, s.reviewer_name, s.slot_key,
             s.file_hash, COALESCE(i.attempts, 0) AS attempts, 0 AS pri
        FROM review_inspections i
        JOIN review_submissions s ON s.file_id = i.file_id
       WHERE i.status = 'pending' AND COALESCE(i.attempts, 0) < $2
       ORDER BY i.updated_at ASC
       LIMIT $1)
     UNION ALL
     (SELECT s.file_id, s.sheet_id, s.tab_name, s.row_index, s.reviewer_name, s.slot_key,
             s.file_hash, 0 AS attempts, 1 AS pri
        FROM review_submissions s
        LEFT JOIN review_inspections i ON i.file_id = s.file_id
       WHERE i.file_id IS NULL
         AND s.uploaded_at > NOW() - ($3 || ' days')::interval
       ORDER BY s.uploaded_at DESC
       LIMIT $1)
     ORDER BY pri, attempts
     LIMIT $1`,
    [limit, SWEEP_MAX_ATTEMPTS, String(SWEEP_DAYS)]
  );
  return rows;
}

/** 재시도 상한을 넘긴 pending 을 종결한다(관리자 화면이 옛 건으로 차는 것 방지). */
async function _giveUpStale() {
  try {
    const { rowCount } = await _db().query(
      `UPDATE review_inspections
          SET status = 'unverifiable', updated_at = NOW()
        WHERE status = 'pending' AND COALESCE(attempts, 0) >= $1`,
      [SWEEP_MAX_ATTEMPTS]
    );
    return rowCount || 0;
  } catch (_) { return 0; }
}

/**
 * 스윕 1사이클. ★ 절대 throw 하지 않는다(cron 이 죽으면 안 된다).
 * @returns {{scanned:number, done:number, failed:number, gaveUp:number}}
 */
/**
 * 소급 재검수 — 그 탭의 의심(suspect)·불량(fail)·판정불가(unverifiable)를 pending 으로
 * 되돌리고 즉시 스윕 1회를 돌린다. **공고 리뷰타입을 뒤늦게 바꾼 경우**(예: 구매확정으로
 * 전환 — 옛 판정이 전부 "리뷰 화면 아님" 불량으로 남는 실측 신고)의 소급 적용 정식 경로.
 * ★ resolved(관리자 확인 종결)·pass 는 건드리지 않는다 — 사람의 종결과 통과 판정은 보존.
 * ★ attempts 0 리셋 — 재시도 상한으로 unverifiable 종결된 건도 다시 본다.
 * ★ 스윕이 이미 도는 중이면 busy 로 알리고 초기화만 남긴다(10분 크론이 이어받는다).
 */
async function reinspectTab({ sheetId, tabName, limit = 100 } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName이 필요합니다.' };
  const { rowCount } = await _db().query(
    `UPDATE review_inspections
        SET status = 'pending', attempts = 0, updated_at = NOW()
      WHERE sheet_id = $1 AND tab_name = $2
        AND status IN ('fail', 'suspect', 'unverifiable')`,
    [sheetId, tabName]);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
  const { withJobLock } = require('../utils/jobLock');
  const sweep = await withJobLock('review_inspect_sweep',
    () => runInspectSweep({ limit: cap }),
    { onBusy: () => ({ busy: true }) });
  return { ok: true, reset: rowCount || 0, ...(sweep || {}) };
}

async function runInspectSweep({ limit } = {}) {
  const out = { scanned: 0, done: 0, failed: 0, gaveUp: 0 };
  if (!ENABLED) return out;
  try {
    out.gaveUp = await _giveUpStale();
    const targets = await _sweepTargets(Math.min(Number(limit) || SWEEP_BATCH, 100));
    out.scanned = targets.length;
    if (!targets.length) return out;

    const { downloadFile } = require('./drive.service');
    for (const t of targets) {
      try {
        const f = await downloadFile(t.file_id);
        if (!f || !f.buffer) throw new Error('파일을 받지 못했습니다');
        const b64 = f.buffer.toString('base64');
        const r = await inspectSubmission({
          base64: b64, mimeType: f.mimeType || 'image/jpeg',
          fileId: t.file_id, fileHash: t.file_hash || hashBase64(b64),
          sheetId: t.sheet_id, tabName: t.tab_name, rowIndex: t.row_index,
          reviewerName: t.reviewer_name, slotKey: t.slot_key || 'review',
        });
        // 과거분은 원장에 지문이 없다 — 이번에 계산한 값을 채워 이후 중복 대조의 재료로 만든다
        if (!t.file_hash) await saveFileHash({ fileId: t.file_id, fileHash: hashBase64(b64) });
        if (r) out.done += 1; else out.failed += 1;
      } catch (e) {
        out.failed += 1;
        // 실패해도 행은 남겨 attempts 가 올라가게 한다(상한 초과 시 위에서 종결)
        await _upsertInspection({
          fileId: t.file_id, sheetId: t.sheet_id, tabName: t.tab_name, rowIndex: t.row_index,
          reviewerName: t.reviewer_name, slotKey: t.slot_key || 'review',
          status: 'pending', checks: { sweep: { verdict: 'skip', error: String(e.message || '').slice(0, 120) } },
          channel: null, device: null, ocrProduct: null, ocrText: null, ocrAuthor: null,
          fileHash: t.file_hash || null, confidence: null,
        });
      }
    }
  } catch (e) {
    logger.warn(`[reviewInspect] 스윕 실패(무시): ${e.message}`);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * 관리자 검수 탭(M3) 조회
 * ════════════════════════════════════════════════════════════════ */

const _LIST_STATUSES = ['pending', 'pass', 'suspect', 'fail', 'unverifiable', 'resolved'];

/**
 * 검수 목록. 기본은 **손볼 것만**(의심+불량) — 통과 건까지 나열하면 정작 볼 게 묻힌다.
 * @param status 'open'(기본, suspect+fail) | 'all' | 개별 status
 */
async function listInspections({ sheetId, tabName, status = 'open', limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (sheetId) { params.push(sheetId); where.push(`i.sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); where.push(`i.tab_name = $${params.length}`); }
  if (status === 'open') {
    where.push(`i.status IN ('suspect','fail')`);
  } else if (status !== 'all' && _LIST_STATUSES.includes(status)) {
    params.push(status); where.push(`i.status = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  const { rows } = await _db().query(
    `SELECT i.id, i.file_id, i.sheet_id, i.tab_name, i.row_index, i.reviewer_name, i.slot_key,
            i.status, i.checks, i.channel, i.ocr_product, i.ocr_text, i.ai_confidence,
            i.resolution, i.inspected_at, i.resolved_at, i.resolved_by, i.created_at,
            s.file_url, s.file_name
       FROM review_inspections i
       LEFT JOIN review_submissions s ON s.file_id = i.file_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE i.status WHEN 'fail' THEN 0 WHEN 'suspect' THEN 1 ELSE 2 END,
               i.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** 탭별 검수 현황 집계(상단 요약 + nav 뱃지). */
async function inspectionSummary({ sheetId, tabName } = {}) {
  const where = [];
  const params = [];
  if (sheetId) { params.push(sheetId); where.push(`sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); where.push(`tab_name = $${params.length}`); }
  const { rows } = await _db().query(
    `SELECT status, COUNT(*)::int AS c FROM review_inspections
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY status`,
    params
  );
  const out = { pass: 0, suspect: 0, fail: 0, pending: 0, unverifiable: 0, resolved: 0, open: 0 };
  for (const r of rows) if (out[r.status] !== undefined) out[r.status] = r.c;
  out.open = out.suspect + out.fail;
  return out;
}

/**
 * 관리자 확인 종결. ★ 원판정(checks)은 지우지 않는다 — 나중에 "왜 통과시켰나"를
 * 되짚을 수 있어야 기준을 고칠 수 있다(오탐 누적이 임계값 조정의 근거다).
 */
/* ── 사람 확인 = 학습 신호 ────────────────────────────────────────────
 * 확인 처리를 [정상(ok = AI 오탐)]/[불량 맞음(bad)] 두 갈래로 기록한다(migration 092).
 * ★ [정상] 처리에서 상품명 의심 건의 캡처 표기를 그 탭의 **인정 별칭**으로 자동 등록 —
 *   같은 표기의 오탐이 다시 나오지 않는다(수동 검수가 그대로 판별 기준을 키우는 학습 루프).
 *   별칭은 기대 상품명에 가산 병합만 하므로(우선순위 규칙 불변) 잡는 범위가 좁아질 뿐
 *   정상 제출을 새로 불량으로 모는 방향의 회귀가 없다.
 */
const _RESOLUTIONS = ['ok', 'bad'];

/** 인정 상품명 별칭 자동 등록 — 개행 목록, 정규화 중복 제거, 상한(60줄·줄당 120자·총 4000자). */
async function _addProductAliases({ sheetId, tabName, names } = {}) {
  const add = (Array.isArray(names) ? names : [])
    .map(s => String(s || '').replace(/[\n\r]+/g, ' ').trim().slice(0, 120)).filter(Boolean);
  if (!add.length || !sheetId || !tabName) return 0;
  try {
    const { rows } = await _db().query(
      'SELECT inspect_product_aliases FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]);
    if (!rows.length) return 0;
    const cur = String(rows[0].inspect_product_aliases || '')
      .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    const merged = _mergeProductNames(cur, add).slice(0, 60);
    const added = merged.length - cur.length;
    if (added <= 0) return 0;
    await _db().query(
      'UPDATE tab_configs SET inspect_product_aliases = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
      [merged.join('\n').slice(0, 4000), sheetId, tabName]);
    return added;
  } catch (e) {
    logger.warn(`[reviewInspect] 별칭 등록 실패(무시 — migration 092 확인): ${e.message}`);
    return 0;
  }
}

/** [정상] 확인 건에서 학습할 별칭 후보 — 상품명 의심으로 잡혔던 캡처 표기만. */
function _aliasCandidate(row) {
  if (!row) return null;
  const pr = (row.checks && row.checks.product) || {};
  if (pr.verdict !== 'warn') return null;
  const v = _cleanProductForMatch(row.ocr_product || pr.ocr || '');
  return v && v.length >= 4 ? v : null;   // 너무 짧은 조각은 별칭으로 안 삼는다(아무거나 통과 방지)
}

async function resolveInspection({ fileId, by, resolution } = {}) {
  const rkind = _RESOLUTIONS.includes(resolution) ? resolution : null;
  const { rows } = await _db().query(
    `UPDATE review_inspections
        SET status = 'resolved', resolution = COALESCE($3, resolution),
            resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
      WHERE file_id = $1 AND status <> 'resolved'
      RETURNING sheet_id, tab_name, ocr_product, checks`,
    [fileId, by || '', rkind]
  );
  let aliasAdded = 0;
  if (rkind === 'ok' && rows[0]) {
    const cand = _aliasCandidate(rows[0]);
    if (cand) {
      aliasAdded = await _addProductAliases({
        sheetId: rows[0].sheet_id, tabName: rows[0].tab_name, names: [cand],
      });
    }
  }
  return { ok: true, resolved: rows.length, aliasAdded };
}

/**
 * 검수 건 → 리뷰어 연락처(phone8) 해석. **한 왕복**으로 4갈래를 함께 읽고 위에서부터 고른다.
 *
 * ★★ 왜 4갈래인가(실사고): 종전엔 ①만 봤는데, 검수 건의 `row_index` 는 **NULL 일 수 있고**
 *   (업로드 시 이름↔행 매칭이 모호하면 `review_submissions.row_index` 가 비고 그대로 복제된다)
 *   행이 있어도 **시트 연락처 칸이 비어 있으면** `review_index.phone8` 이 없다 → "연락처를 찾지 못함".
 * ★★ 완화 금지: 아래 순서와 게이트는 **틀린 사람에게 반려 안내가 가지 않게** 하는 장치다.
 *   ① 시트 현재값(그 줄의 연락처) — 소유권의 최종 진실(search.service 규율과 동일)
 *   ② 업로드 원장이 **결정적으로** 연결한 인덱스 행(`review_submissions.review_index_id`)
 *   ③ 확정 신원(`participation_links`) — ★ **이름이 같을 때만**(재배정된 행의 옛 주인 차단.
 *      ①이 비었을 때만 보는 것도 search.service 의 stale-pl 규율 그대로)
 *   ④ 같은 작업에서 **이름이 정확히 일치하는 리뷰어가 딱 한 명**일 때만(동명이인이면 포기)
 * ★ 못 찾으면 **사유를 구분해** 돌려준다 — "왜 못 보냈는지"를 모르면 담당자가 손쓸 수가 없다.
 */
async function resolveReviewerPhone8(fileId) {
  const { rows } = await _db().query(
    `SELECT i.sheet_id, i.tab_name, i.row_index, i.reviewer_name,
            (SELECT r.phone8 FROM review_index r
              WHERE r.sheet_id = i.sheet_id AND r.tab_name = i.tab_name
                AND r.row_index = i.row_index AND COALESCE(r.phone8,'') <> '' LIMIT 1) AS p_row,
            (SELECT r.phone8 FROM review_submissions s
                JOIN review_index r ON r.id = s.review_index_id
              WHERE s.file_id = i.file_id AND COALESCE(r.phone8,'') <> '' LIMIT 1) AS p_link,
            (SELECT pl.phone8 FROM participation_links pl
              WHERE pl.sheet_id = i.sheet_id AND pl.tab_name = i.tab_name
                AND pl.row_index = i.row_index AND COALESCE(pl.phone8,'') <> ''
                AND REPLACE(COALESCE(pl.name,''),' ','') = REPLACE(COALESCE(i.reviewer_name,''),' ','')
                AND COALESCE(i.reviewer_name,'') <> '' LIMIT 1) AS p_pl,
            (SELECT MIN(r.phone8) FROM review_index r
              WHERE r.sheet_id = i.sheet_id AND r.tab_name = i.tab_name
                AND COALESCE(r.phone8,'') <> '' AND COALESCE(i.reviewer_name,'') <> ''
                AND REPLACE(COALESCE(r.reviewer_name,''),' ','') = REPLACE(COALESCE(i.reviewer_name,''),' ','')
              HAVING COUNT(DISTINCT r.phone8) = 1) AS p_name,
            (SELECT COUNT(DISTINCT r.phone8) FROM review_index r
              WHERE r.sheet_id = i.sheet_id AND r.tab_name = i.tab_name
                AND COALESCE(r.phone8,'') <> '' AND COALESCE(i.reviewer_name,'') <> ''
                AND REPLACE(COALESCE(r.reviewer_name,''),' ','') = REPLACE(COALESCE(i.reviewer_name,''),' ','')) AS name_cnt
       FROM review_inspections i WHERE i.file_id = $1 LIMIT 1`,
    [fileId]);
  const r = rows[0];
  if (!r) return { row: null, error: '검수 건을 찾지 못했습니다.' };

  const pick = [['row', r.p_row], ['link', r.p_link], ['participation', r.p_pl], ['name', r.p_name]]
    .find(([, v]) => v);
  if (pick) return { row: r, phone8: pick[1], via: pick[0] };

  // ★ 사유 구분 — 담당자가 무엇을 고쳐야 하는지 알아야 한다.
  const cnt = Number(r.name_cnt || 0);
  let why;
  if (cnt > 1) why = `같은 이름(${r.reviewer_name || ''})이 이 작업에 ${cnt}명이라 연락처를 특정할 수 없습니다`;
  else if (r.row_index == null) why = '이 캡처가 시트 어느 줄인지 연결되어 있지 않습니다';
  else why = `시트 ${r.row_index}행의 연락처 칸이 비어 있습니다`;
  return { row: r, error: `리뷰어 연락처를 찾지 못해 메시지를 보내지 못했습니다 — ${why}. 1:1 문의로 직접 안내해 주세요.` };
}

/**
 * [✕ 불량 맞음] → 리뷰어 1:1 문의 채팅에 반려 사유 자동 통지.
 * ★ 확인(원장 기록)과 분리된 후처리 — 실패해도 불량 확인은 유지되고, 결과를 응답에 실어
 *   관리자가 알게 한다(조용한 미전송 금지). 절대 throw 하지 않는다.
 * ★ 연락처 해석은 `resolveReviewerPhone8` 단일 출처(위 4갈래 게이트).
 */
async function notifyInspectionReject({ fileId, message, by, card } = {}) {
  const msg = String(message || '').trim();
  if (!fileId || !msg) return { sent: false, error: '전송할 사유가 없습니다.' };
  try {
    const got = await resolveReviewerPhone8(fileId);
    const r = got.row;
    if (!r) return { sent: false, error: got.error || '검수 건을 찾지 못했습니다.' };
    if (!got.phone8) return { sent: false, error: got.error };
    r.phone8 = got.phone8;
    const out = await require('./csBridge.service').postInspectionReject({
      sheetId: r.sheet_id, tabName: r.tab_name, rowIndex: r.row_index,
      reviewerName: r.reviewer_name, phone8: r.phone8, message: msg, by,
      // ★ 사진 카드 재료 — "어떤 작업의 어떤 사진인지"를 채팅에서 바로 보게 한다.
      //   ★ 리뷰어에게 나가는 값이라 **관리자 실명·시트 제목은 담지 않는다**(meta 는 응답에 그대로 실린다).
      card: card ? { fileId, ...card, work: r.tab_name || '' } : null,
    });
    if (!out) return { sent: false, error: '메시지 전송에 실패했습니다 — 1:1 문의로 직접 안내해 주세요.' };
    return { sent: true, threadId: out.threadId };
  } catch (e) {
    logger.warn(`[reviewInspect] 반려 통지 실패(${fileId}): ${e.message}`);
    return { sent: false, error: '메시지 전송에 실패했습니다 — 1:1 문의로 직접 안내해 주세요.' };
  }
}

/**
 * 일괄 확인 처리 — 그 탭의 미확인 의심·불량 전부를 한 번에 종결한다(1632건 백로그용).
 * ★ adminOrMaster 전용(라우트) — 대량 종결은 되돌리기 어렵다.
 * ★ resolution 'ok' 면 상품명 의심 건들의 캡처 표기를 별칭으로 **한 번에** 학습한다.
 */
async function resolveInspectionsBulk({ sheetId, tabName, resolution = 'ok', by } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName이 필요합니다.' };
  const rkind = _RESOLUTIONS.includes(resolution) ? resolution : 'ok';
  const { rows } = await _db().query(
    `UPDATE review_inspections
        SET status = 'resolved', resolution = $4, resolved_at = NOW(), resolved_by = $3, updated_at = NOW()
      WHERE sheet_id = $1 AND tab_name = $2 AND status IN ('suspect', 'fail')
      RETURNING sheet_id, tab_name, ocr_product, checks`,
    [sheetId, tabName, by || '', rkind]
  );
  let aliasAdded = 0;
  if (rkind === 'ok' && rows.length) {
    const cands = rows.map(_aliasCandidate).filter(Boolean).slice(0, 30);
    if (cands.length) aliasAdded = await _addProductAliases({ sheetId, tabName, names: cands });
  }
  return { ok: true, resolved: rows.length, aliasAdded };
}

/** 한 건의 스코프 판정용 — 그 파일이 어느 (시트,탭)인지. */
async function inspectionScope(fileId) {
  const { rows } = await _db().query(
    'SELECT sheet_id, tab_name FROM review_inspections WHERE file_id = $1 LIMIT 1', [fileId]
  );
  return rows[0] || null;
}

/** 검수 결과 CSV — 업체 전달 전 사람이 훑어보는 용도. UTF-8 BOM(엑셀). */
function inspectionsCsv(rows) {
  const head = ['상태', '탭', '행', '리뷰어', '채널', '판정사유', '캡처 상품명', '검수시각'];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const reason = (c) => {
    const o = [];
    if (c?.format?.verdict === 'fail') o.push('리뷰 화면 아님');
    if (c?.format?.verdict === 'warn') o.push('채널 다름');
    if (c?.product?.verdict === 'warn') o.push('상품명 다름');
    if (c?.duplicate?.verdict === 'fail') o.push(`같은 파일(${c.duplicate.matchTab || ''} ${c.duplicate.matchReviewer || ''})`.trim());
    if (c?.similarity?.verdict === 'warn') o.push(`본문 ${Math.round((c.similarity.score || 0) * 100)}% 겹침`);
    if (c?.author?.verdict === 'warn') o.push(`작성자 표기 재사용(${(c.author.others || []).join(',')})`);
    return o.join(' / ');
  };
  const body = (rows || []).map(r => [
    r.status, r.tab_name, r.row_index ?? '', r.reviewer_name || '',
    channelLabel(r.channel) || '', reason(r.checks || {}), r.ocr_product || '',
    r.inspected_at ? new Date(r.inspected_at).toISOString() : '',
  ].map(esc).join(','));
  return '﻿' + [head.join(','), ...body].join('\n');
}

module.exports = {
  precheckPolicy, expectedChannelKey, channelLabel,
  productNamesFromWorkOrder, productNameSettings, saveProductNames, saveProductAliases,
  loadSamplesFor, sampleSettings, saveSample,
  loadReceiptSamplesFor, receiptSampleSettings, saveReceiptSample,
  loadRouteSamples, routeSampleSettings, saveRouteSample, submissionSamples,
  findAuthorReuse, runInspectSweep, reinspectTab, inspectionsCsv,
  listInspections, inspectionSummary, resolveInspection, resolveInspectionsBulk, inspectionScope,
  notifyInspectionReject,
  resolveReviewerPhone8,
  classifyDuplicateContext,
  hashBase64, matchProductName, computeStatus,
  loadTabExpectations, findDuplicate, findOwnDuplicate, findSimilarText,
  inspectSubmission, saveFileHash,
  ENABLED, PRECHECK_ENABLED, PRECHECK_BLOCK,
  BLOCK_CONFIDENCE, SIM_THRESHOLD, MIN_TEXT, SIM_LEN_RATIO, BLOCK_EXEMPT_CHANNELS,
  parseSampleUrls, SAMPLE_SLOT_CAP, SAMPLE_ATTACH_CAP, _trimSamples,
  __setPoolForTest,
};
