'use strict';
/**
 * 결정 356 — 리뷰어 화면(campaign.html) 차례 타이머 가드.
 *  ① 화면 어림(_chainPreview) = 서버 규칙(shapeLink) — 같은 입력이면 같은 판정·같은 시각(5,000가지)
 *  ② 토큰은 서버가 '만료/없음'이라고 할 때만 지운다 — 로컬 0초는 _confirmHoldExpiry 로만(RED-13)
 *  ③ 서버가 차례를 알리지 않으면(구서버·끄는 스위치) 종전 문구·종전 동작(RED-04)
 *  ④ chain_after_close = 이 명의만 막고 다음 명의 계속 · 같은 본문(_doApply 와 _applyMany) · 재시도 없음(결정 353)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../src/services/campaignHoldChain.service');
const camp = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'campaign.html'), 'utf8');
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else { failed++; console.log('❌ ' + n); } };
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); return i >= 0 && j > i ? s.slice(i, j) : ''; };

// ① 어림 = 서버 규칙
const block = between(camp, '/* ═══ ★ 결정 356 — 차례 타이머(화면 쪽)', '/* ═══ 작업내용 표시 정규화');
ok('① 차례 블록 존재', block.length > 500);
{
  const M = 60000, T0 = Date.parse('2026-11-09T08:00:00Z'); let seed = 3, n = 0, bad = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 5000; i++) {
    const now = T0 + Math.floor(rnd() * 50) * M, windowed = rnd() < 0.8, buf = [0, 5, 10][Math.floor(rnd() * 3)], close = T0 + 60 * M;
    const c = { hold_ttl_min: rnd() < 0.5 ? 20 : null, sub_hold_ttl_min: rnd() < 0.5 ? 15 : 10, close_buffer_min: buf,
      closesAt: windowed ? new Date(close).toISOString() : null, cutoffAt: windowed ? new Date(close - buf * M).toISOString() : null };
    const holds = {}; for (let j = 0; j < Math.floor(rnd() * 3); j++) holds['h' + j] = { expiresAt: new Date(now + Math.floor(rnd() * 40) * M).toISOString() };
    const ctx = { _camp: c, CampCards: { serverNow: () => now }, _allHolds: () => holds, PREVIEW: false };
    vm.createContext(ctx); vm.runInContext(block, ctx);
    const order = [{ type: 'self', phone8: '1' }]; for (let j = 0; j < Math.floor(rnd() * 4); j++) order.push({ type: 'sub', phone8: 's' + j });
    const pv = ctx._chainPreview(order);
    const live = Object.values(holds).map(h => Date.parse(h.expiresAt)).filter(e => e > now);
    order.forEach((r, k) => {
      const ttl = r.type === 'sub' ? (Number(c.sub_hold_ttl_min) || 15) : (Number(c.hold_ttl_min) || C.MAIN_HOLD_TTL_DEFAULT_MIN);
      const s = C.shapeLink({ startMs: Math.max(now, ...live), ttlMin: ttl, closesMs: Date.parse(c.closesAt || ''), cutoffMs: Date.parse(c.cutoffAt || ''), nowMs: now });
      n++;
      if (pv[k].ok !== !s.refuse || pv[k].startsAt !== s.turnStartsAt.getTime() || (!s.refuse && pv[k].endsAt !== s.expiresAt.getTime())) bad++;
      if (!s.refuse) live.push(s.expiresAt.getTime());
    });
  }
  ok('① 화면 어림 = 서버 규칙(판정·시작·끝 모두 같음)', n > 9000 && bad === 0);
}

// ② 토큰 삭제는 서버 판정으로만
const tick = between(camp, 'function _tickTabs(){', 'setInterval(() => { const b = $(\'acctTabs\')');
ok('② 보지 않는 탭 0초 → _confirmHoldExpiry(직접 _expireOtherTab 없음)', /_confirmHoldExpiry\(p8\)/.test(tick) && !/_expireOtherTab\(/.test(tick));
const up = between(camp, 'function _onHoldTimeUp(){', 'let _enterSeq');
ok('② 보는 명의 0초 → 제출 중이면 기다림(351) · 그 밖엔 _confirmHoldExpiry(직접 releaseExpiredHold 없음)',
  /if\(_formSubmitting\(\)\)\{ pollOnce\(\); setTimeout\(_onHoldTimeUp, 2000\); return; \}/.test(up)
  && /_confirmHoldExpiry\(h\.phone8, \{ active:true \}\)/.test(up) && !/releaseExpiredHold\(/.test(up));
const ask = between(camp, 'async function _confirmHoldExpiry(', 'function _chainPreview(');
ok('② _confirmHoldExpiry: expired/no_hold 일 때만 정리 · 혼자면 만료 화면 먼저(351) · 확인 불가면 토큰 유지',
  /if\(j && \(j\.reason === 'expired' \|\| j\.reason === 'no_hold'\)\)\{[^}]*releaseExpiredHold\(h\) : _expireOtherTab\(p8\); \}/.test(ask)
  && /if\(alone\) show\('vExpired'\);/.test(ask) && !/clearHold\(/.test(ask));
const merge = between(camp, 'function _applyChainView(list){', 'const _expiryAsk');
ok('② _applyChainView: 지우지 않음 · 모르는 명의는 복구만(30초에 한 번)', !/clearHold|delete m\[/.test(merge) && /recoverActiveHolds\(\)/.test(merge) && /30000/.test(merge));

// ③ 서버가 알리지 않으면 종전
ok('③ 차례 표시·잠금·플래그는 _camp.holdChain === true 일 때만', /function _chainOn\(\)\{ return !!\(_camp && _camp\.holdChain === true\) && _acctMultiPick\(\); \}/.test(camp)
  && /function _refreshChainLocks\(box, rows\)\{\s*\n\s*if\(!_chainOn\(\)\) return;/.test(camp));
ok('③ 종전 문구 유지(차례 없을 때)', camp.includes("'체크한 명의 모두 지금 바로 제한시간이 시작돼요 — 본계정 '"));
ok('③ 대기 표시는 서버가 준 chainState 로만', /const ws = h\.chainState === 'waiting' \? Date\.parse\(h\.startsAt \|\| ''\) : NaN;/.test(tick));

// ④ apply
const da = between(camp, 'async function _doApply(', '/* ═══ ★ 결정 353');
const am = between(camp, 'async function _applyMany(', 'function _applyReasonText(');
ok('④ 같은 플래그 줄이 _doApply·_applyMany 둘 다', /if\(_chainOn\(\)\) body\.sequential = true;/.test(da) && /if\(_chainOn\(\)\) body\.sequential = true;/.test(am));
ok('④ _applyMany 는 여전히 체크한 수만큼 한 번씩(/apply 1곳 · 재시도 없음)', (am.match(/\/apply'/g) || []).length === 1 && /for\(let i = 0; i < sels\.length; i\+\+\)\{/.test(am));
ok('④ chain_after_close = 명의 사유(멈춤 목록 아님) · 본계정도 잠금', /'chain_after_close'\];/.test(camp)
  && !/\['closed','cutoff'[^\]]*chain_after_close/.test(am) && /if\(j\.reason === 'chain_after_close'\)\{ const _cp = _p8\(sub \? sub\.phone : s\.phone8\);/.test(am));
ok('④ 응답 못 받은 요청은 복구만(다시 보내지 않음)', /if\(fail\.some\(f => \/\^연결 오류\/\.test\(f\.why \|\| ''\)\)\) \{ try\{ await recoverActiveHolds\(\); \}/.test(am));
ok('④ 시트 잠금 행은 못 고른다 · 위 명의를 바꾸면 다시 계산', /if\(div\.classList\.contains\('chain-late'\)\) return;/.test(camp) && /_refreshChainLocks\(box, rows\);/.test(camp));
ok('④ 결정 351 가드 경로 그대로(서버 만료 → releaseExpiredHold)', /else if\(j\.reason === 'expired'\)\{ await releaseExpiredHold\(h\); \}/.test(camp)
  && /if\(j\.reason === 'expired'\)\{ await releaseExpiredHold\(h\); return; \}/.test(camp));
console.log(`\n${failed ? '❌' : '✅'} campaignHoldChainFront: ${passed}개 통과${failed ? ` · ${failed}개 실패` : ''}`);
if (failed) process.exit(1);
