/**
 * campaignShortagePrompt.test.js — 어제 모집 부족 인원 팝업 회귀가드 (2026-10-02)
 * 실행: node tests/campaignShortagePrompt.test.js   (실제 DB 실행은 campaignShortagePromptPg.test.js)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const svc = require('../src/services/campaignShortage.service');
let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 부족 계산(순수) ──
const c = { id: 'c', participation_mode: true, daily_limit: 3, recruit_total: 10, start_date: '2026-09-28', published_at: '2026-09-27T00:00:00Z' };
const TODAY0 = Date.parse('2026-10-01T15:00:00Z');   // 2026-10-02 00:00 KST
const counts = { plans: null, activeHolds: 0 };
const f = (o) => Object.assign({ allConfirmed: 3, beforeYesterday: 1, yesterday: 2, todayStartMs: TODAY0, used: null }, o);
let s = svc.computeShortage(c, counts, f(), '2026-10-01');
ok('어제 계획 3 − 확정 2 = 1명 부족', s && s.shortage === 1 && s.yesterdayQuota === 3);
ok('다 채웠으면 묻지 않음', svc.computeShortage(c, counts, f({ yesterday: 3 }), '2026-10-01') === null);
ok('어제 시작 전이면 묻지 않음', svc.computeShortage(Object.assign({}, c, { start_date: '2026-10-02' }), counts, f(), '2026-10-01') === null);
ok('오늘 게시한 공고는 묻지 않음(게시 시각 기준)', svc.computeShortage(Object.assign({}, c, { published_at: '2026-10-02T01:00:00Z' }), counts, f(), '2026-10-01') === null);
ok('어제 0명 참여(신청 기록 없음)도 부족으로 묻는다 — 가장 큰 부족', svc.computeShortage(c, counts, f({ yesterday: 0, allConfirmed: 1 }), '2026-10-01').shortage === 3);
ok('게시 시각 모르면 생성 시각으로 본다', svc.computeShortage(Object.assign({}, c, { published_at: null, created_at: '2026-09-20T00:00:00Z' }), counts, f(), '2026-10-01').shortage === 1);
ok('어제 날짜별 조절(0명)이 있으면 그 값이 계획', svc.computeShortage(c, { plans: { '2026-10-01': 0 } }, f({ yesterday: 0 }), '2026-10-01') === null);
ok('어제 조절 5명 · 확정 2 → 3명 부족', svc.computeShortage(c, { plans: { '2026-10-01': 5 } }, f(), '2026-10-01').shortage === 3);
ok('남은 총인원으로 자른다(10 중 9 확정 → 1명)', svc.computeShortage(c, counts, f({ allConfirmed: 9, beforeYesterday: 8, yesterday: 0 }), '2026-10-01').shortage === 1);
ok('정원 소진이면 묻지 않음', svc.computeShortage(c, counts, f({ allConfirmed: 10, beforeYesterday: 9, yesterday: 0 }), '2026-10-01') === null);
ok('진행 중(결제 중) 자리도 정원을 차지', svc.computeShortage(c, { activeHolds: 1 }, f({ allConfirmed: 9, beforeYesterday: 8, yesterday: 0 }), '2026-10-01') === null);
ok('주말 미게시 공고의 쉬는 날(어제 토요일)은 묻지 않음',
  svc.computeShortage(Object.assign({}, c, { skip_weekends: true }), counts, f({ yesterday: 0 }), '2026-10-03') === null);

// ── 받는 사람 ──
ok('담당 닉네임 일치(만두)', svc.isRecipient('만두', { manager: '만두' }, null));
ok('실명 → 닉네임(박세희 → 만두)', svc.isRecipient('박세희', { manager: '만두' }, null));
ok('다른 담당자(박은비=망고)는 아님', !svc.isRecipient('박은비', { manager: '만두' }, null));
ok('작업오더를 보낸 AE', svc.isRecipient('김AE', { manager: '' }, { created_by: '김AE' }));
ok('작업오더 manager_name(지난 담당 실명)만으로는 받는 사람 아님', !svc.isRecipient('박세희', { manager: '망고' }, { manager_name: '박세희' }));
ok('이름 없으면 아무에게도 아님', !svc.isRecipient('', { manager: '' }, null));

// ── 배선 ──
const src = read('src/services/campaignShortage.service.js');
ok('대상 = 참여형·게시 중·종료일 뒤에 붙이기·보류 아님·안 물음 표시 없음',
  /participation_mode = TRUE AND status = 'active'/.test(src) && /carry_strategy,'next'\) = 'extend'/.test(src)
  && /!st\.isCarryHold\(c\)/.test(src) && /shortage_prompt_off_at IS NULL/.test(src));
ok('오늘 더하기 = [📅 인원]과 같은 savePlans 경로(직접 INSERT 금지)',
  /require\('\.\/campaignPlan\.service'\)\.savePlans/.test(src) && !/INSERT INTO campaign_daily_plans/.test(src));
ok('확정 수 = 정원 깔때기를 오늘·어제 기준으로 두 번(신청 표만 세지 않음)', /st\.fetchCampaignCounts\(db, ids, prevNow\)/.test(src) && /Math\.max\(appsY, ordersY\)/.test(src) && /usage = st\.totalQuotaUsage\(c, counts\)/.test(src) && /if \(!usage \|\| !usage\.known\) continue/.test(src));
ok('결정 기록은 변경과 같은 트랜잭션(savePlans beforeCommit · 기간 늘리기는 자체 트랜잭션+행 잠금)',
  /beforeCommit: async \(client\) => \{[\s\S]{0,200}return record\(client, amount/.test(src) && /SELECT \* FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(src) && /'23505'/.test(src) && !/state: 'claimed'/.test(src));
ok('잠근 순간 오늘 인원을 다시 계산 — 바뀌었으면 거절(낡은 값으로 덮지 않음)', /afterLock: async \(client, camp, schedule\)/.test(src) && /code: 'stale_today'/.test(src));
const plan = read('src/services/campaignPlan.service.js');
ok('savePlans 훅은 미전달이면 무동작(종전 동작)', /if \(opts && typeof opts\.afterLock === 'function'\)/.test(plan) && /if \(opts && typeof opts\.beforeCommit === 'function'\) await opts\.beforeCommit\(client\)/.test(plan)
  && plan.indexOf('opts.beforeCommit(client)') < plan.indexOf("await client.query('COMMIT');\n    // 작업표 원본"));
ok('블로그 공고 제외', /COALESCE\(rc\.work_kind,''\) <> 'blog'/.test(src));
ok('시트 일정 기능이 켜지면 시트 연결 공고는 묻지 않음(실패와 일정 없음을 구분할 수 없음)', /scheduleUnknown\(c\) \|\|/.test(src) && /schMap === null \|\| !st\.isUsableSchedule\(scheduleFor\(schMap, c\)\)/.test(src));
ok('잠근 순간 오늘 다시 열 수 있는지 재확인', /const again = _canRaiseToday\(camp, stNow, lockNow\)/.test(src));
const routesSrc = read('src/routes/campaign.routes.js');
ok('게시로 바뀌는 네 경로가 게시 시각을 남긴다(수정·게시 토글·스코프 편집·처음부터 게시)', (routesSrc.match(/published_at = CASE WHEN/g) || []).length === 3 && /SET published_at = NOW\(\) WHERE id = \$1 AND published_at IS NULL/.test(routesSrc));
ok('게시 시각 컬럼은 부팅 프리플라이트에 등록', /\['recruit_campaigns', 'published_at'\]/.test(read('index.js')));
const jsSrc = read('../frontend/js/shortage-prompt.js');
ok('화면: 첫 조회 실패면 1분마다 다시 시도 · 멈출 때 진행 표시 초기화', /if \(!S\.loadedOnce\)/.test(jsSrc) && /S\.gen\+\+; S\.loading = false;/.test(jsSrc));
ok('잠금 사이 자정이 지나면 거절', /'day_changed'\)/.test(src) && /st\.kstTodayStr\(lockNow\) !== cur\.today/.test(src));
ok('작업보드 갱신만 실패하면 "반영됨 + 경고"로 말한다', /e\.code === 'worktable_projection_failed'/.test(src) && /function _worktableNote/.test(src) && /ws\.warn \|\| ws\.rowAudit/.test(src));
ok('오늘에 더할 자리는 저장 게이트와 같은 소비량(totalQuotaUsage · 모르면 0)', /if \(!usage\.known\) return 0/.test(src));
ok('화면: 1시간 뒤 다시 표시는 다시 받는 데 성공한 뒤에만 지운다', /if \(!ok\) return;/.test(read('../frontend/js/shortage-prompt.js')));
ok('주문 원장은 깔때기가 합쳤을 때만(countBasis)', /cn\.countBasis === 'max' && cp\.countBasis === 'max'/.test(src));
ok('오늘에 더할 자리 = 총원 − 오늘 이전 확정 − 앞날 계획 − 오늘 정원', /function _roomToday/.test(src) && /if \(d > today\) future \+=/.test(src));
ok('같은 공고·날짜 결정 하나 = 부분 유니크 인덱스', /CREATE UNIQUE INDEX IF NOT EXISTS uq_cpe_shortage_decision[\s\S]*WHERE action = 'shortage_decision'/.test(read('migrations/174_campaign_published_at.sql')));
ok('작업오더 쪽은 created_by 만 조회', /linkedWorkOrdersForCampaigns\(db, ids, \['created_by'\]\)/.test(src) && !/manager_name/.test(src.replace(/\/\/.*$/gm, '')));
ok('같은 날 한 번만 — 처리 기록으로 거른다', /detail->>'date' = \$3/.test(src) && /_decidedFor/.test(src));
ok('반영 전 서버가 다시 계산(화면 숫자 불신)', /listShortages\(admin, \{ db, now, campaignIds/.test(src));

const routes = require('../src/routes/trackB.routes');
const layer = (p, m) => routes.stack.find(l => l.route && l.route.path === p && l.route.methods[m]);
const names = (l) => l.route.stack.map(x => x.name);
ok('목록 라우트 = 내부 직원(광고주 차단)', names(layer('/shortage-prompts', 'get')).includes('internalMiddleware'));
ok('반영 라우트 = 내부 직원(광고주 차단)', names(layer('/shortage-prompts/apply', 'post')).includes('internalMiddleware'));

const wd = read('../frontend/workdesk.html');
ok('workdesk: 모듈 로드', /<script src="js\/shortage-prompt\.js[^"]*"><\/script>/.test(wd));
ok('workdesk: 내부 직원만 시작 · 모듈이 늦게 로드돼도 맡겨 두고 시작', /if\(_isInternalRole\(\)\)\{ const _sp=/.test(wd) && /window\.__SHORTAGE_PENDING=_sp/.test(wd) && /window\.__SHORTAGE_PENDING\) \{ var p = window\.__SHORTAGE_PENDING/.test(read('../frontend/js/shortage-prompt.js')));
ok('workdesk: 로그아웃·세션 만료 때 멈춤', (wd.match(/window\.ShortagePrompt\.stop\(\)/g) || []).length >= 2);
ok('workdesk: 반영 뒤 화면 갱신 훅', /window\.SHORTAGE_ON_APPLIED=function/.test(wd));

const js = read('../frontend/js/shortage-prompt.js');
ok('화면: 버튼은 고르기만 — 반영 버튼에서만 서버 호출', /data-a="pick"/.test(js) && (js.match(/BASE \+ '\/apply'/g) || []).length === 1 && /function apply\(\)/.test(js));
ok('화면: 1시간 뒤 다시는 서버를 부르지 않고 이 브라우저에만 기억', /choice === 'later'/.test(js) && /writeSnooze/.test(js) && /SNOOZE_MS = 60 \* 60 \* 1000/.test(js));
ok('화면: 결과 안내는 화면 정중앙 · 클릭 막지 않음 · 반드시 사라짐',
  /#spMsg\{position:fixed;left:50%;top:50%/.test(js) && /pointer-events:none/.test(js) && /setTimeout\(gone/.test(js));
ok('화면: 시트·외부 문자열은 escape(onclick 보간 없음)', /esc\(it\.title\)/.test(js) && !/onclick=/.test(js));

ok('화면: 늦게 온 응답은 버린다(로그아웃 뒤)', /gen !== S\.gen/.test(js) && /S\.gen\+\+/.test(js));
ok('화면: 로그아웃하면 닫기 기억도 지운다', /wd_shortage_dismiss_v1_'\) === 0\) sessionStorage\.removeItem/.test(js));
ok('화면: 실패하면 다시 띄운다', /if \(failed\) \{ S\.loadedOnce = false; setTimeout\(function \(\) \{ if \(!S\.loading\) load\(true\)/.test(js));
ok('화면: 실제로 바뀐 공고가 있을 때만 화면 갱신 + 열린 작업만 다시 읽음', /if \(applied\.length\)/.test(js) && /x\.linkedSheetId===c\.sheetId && x\.linkedTabName===c\.tabName/.test(wd));

// ── 오늘 다시 열리는가 ──
const vm = require('vm');
const fnSrc = src.slice(src.indexOf('function _canRaiseToday'), src.indexOf('async function _loadCandidates'));
const sb = { st: require('../src/services/campaignState.service') }; vm.createContext(sb);
vm.runInContext(fnSrc + ';this.f=_canRaiseToday;', sb);
const kstAt = (h, m) => new Date(Date.UTC(2026, 9, 2, h - 9, m));
const cw = { window_start: '09:00', window_end: '18:00', close_buffer_min: 10 };
ok('모집 중이면 가능', sb.f(cw, { state: 'open' }, kstAt(12, 0)).ok);
ok('오늘 인원이 차서 닫힘 + 마감 시각 전이면 가능', sb.f(cw, { state: 'daily_done' }, kstAt(12, 0)).ok);
ok('마감 시각(버퍼 포함)이 지나면 불가', !sb.f(cw, { state: 'daily_done' }, kstAt(17, 55)).ok);
ok('cutoff 불가', !sb.f(cw, { state: 'cutoff' }, kstAt(17, 55)).ok);
ok('0명 조절·쉬는 날(rest_day) 불가', !sb.f(cw, { state: 'daily_done', stateReason: 'rest_day' }, kstAt(12, 0)).ok);
ok('총원 충족 불가', !sb.f(cw, { state: 'soft_full' }, kstAt(12, 0)).ok);
ok('자율주문(시간창 없음)은 하루 종일 가능', sb.f({}, { state: 'daily_done' }, kstAt(23, 30)).ok);

ok('적용된 173 는 처음 모양 그대로(컬럼 두 개만) — 뒤에 덧붙이지 않는다', (() => { const m = read('migrations/173_campaign_shortage_prompt.sql'); return /shortage_prompt_off_at/.test(m) && !/published_at/.test(m) && !/CREATE UNIQUE INDEX/.test(m); })());
ok('보관 해제도 게시 시각을 새로 남긴다(보관 중은 리뷰어에게 안 보였다)', /published_at = CASE WHEN status = 'active' THEN NOW\(\) ELSE published_at END/.test(require('fs').readFileSync(require('path').join(__dirname,'../src/services/campaignArchive.service.js'),'utf8')));
ok('반영 실패 뒤 재조회도 실패하면 계속 재시도(loadedOnce 되돌림)', /if \(failed\) \{ S\.loadedOnce = false;/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('리뷰어 숨김(테스트) 공고 제외 · 이월 보류는 isCarryHold 단일 출처', /COALESCE\(reviewer_hidden, FALSE\) = FALSE/.test(src) && /rows\.filter\(c => !st\.isCarryHold\(c\) &&/.test(src) && !/carry_mode,'auto'\) <> 'hold'/.test(src));
ok('날짜별 계획 킬스위치가 꺼지면 오늘 더하기 막음', /canAddToday: PLAN_ON\(\) &&/.test(src) && /CAMPAIGN_DAILY_PLAN !== '0'/.test(src));
ok('173 컬럼도 부팅 점검 대상', /\['recruit_campaigns', 'shortage_prompt_off_at'\]/.test(require('fs').readFileSync(require('path').join(__dirname,'../index.js'),'utf8')));
ok('자정을 넘기면 새 날짜 목록을 다시 받는다', /if \(S\.date && kstYesterday\(\) !== S\.date\)/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('리뷰어앱 스코프 편집으로 게시 전환해도 게시 시각 기록', /published_at = CASE WHEN \$3 = 'active' AND status IS DISTINCT FROM 'active' THEN NOW\(\)/.test(require('fs').readFileSync(require('path').join(__dirname,'../src/routes/campaign.routes.js'),'utf8')));
ok('잠근 행으로 다시 확인 = 공용 함수를 두 갈래가 함께 씀(오늘 더하기·기간 늘리기)', /await _lockedRecheck\(client, camp, d, it, cur, admin, opts\)/.test(src) && /await _lockedRecheck\(client, lk\[0\], d, it, cur, admin, opts\)/.test(src) && /!c\.archived_at && !c\.shortage_prompt_off_at/.test(src));
ok('상품별 하루 한도 공고는 오늘 더하기 막음(목록·잠금 둘 다)', /_optionCappedIds\(db, ids, /.test(src) && /_optionCappedIds\(client, \[d\.campaignId\], /.test(src) && /if \(optCapped === null \|\| optCapped\.has\(String\(c\.id\)\)\) continue/.test(src));
ok('반영 요청은 50건씩 나눠 보낸다', /for \(var bi = 0; bi < send\.length; bi \+= 50\)/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('잠근 순간 어제 부족 인원도 다시 계산 — 바뀌었으면 거절', /_loadFacts\(client, \[d\.campaignId\], lockNow/.test(src) && /'stale_shortage'\)/.test(src));
ok('계획 킬스위치가 꺼지면 어제 계획도 무시', /const plans = \(PLAN_ON\(\) && counts\.plans\) \|\| null/.test(src));
ok('이미 처리됨은 처리 기록 유니크 충돌일 때만', /e\.code === '23505' && e\.constraint === 'uq_cpe_shortage_decision'/.test(src));
ok('반영 요청은 화면 날짜를 싣고 서버가 다르면 거절', /date: S\.date \}/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')) && /opts\.date && String\(opts\.date\) !== cur\.date/.test(src));
ok('열린 팝업도 자정이 지나면 닫고 새 목록', /if \(S\.open && S\.date && kstYesterday\(\) !== S\.date/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('잠근 행으로 후보 조건 전체(이월 방식·보류 포함)·받는 사람 재확인', /if \(!_stillEligible\(camp\)\)/.test(src) && /carry_strategy \|\| 'next'\) === 'extend'/.test(src) && /'not_recipient'\)/.test(src));
ok('함께 쓰는 작업표라 줄을 안 바꾼 경우 경고로 말한다', /reason === 'shared_worktable'\) \|\| \(rb && rb\.reason === 'shared_worktable'\)/.test(src));
ok('어제 이후 인원 규칙이 바뀐 공고·어제 마감 뒤 게시 공고는 묻지 않음', /c\.quota_rules_changed_at && new Date\(c\.quota_rules_changed_at\)\.getTime\(\) >= yStartMs/.test(src) && /if \(pubMs >= cutoffMs\) return null/.test(src));
ok('175 트리거 = 인원 규칙 칸이 실제로 달라질 때만', (() => { const m = read('migrations/175_campaign_quota_rules_changed_at.sql'); return /BEFORE UPDATE ON recruit_campaigns/.test(m) && /NEW\.daily_limit\s+IS DISTINCT FROM OLD\.daily_limit/.test(m) && /NEW\.skip_weekends\s+IS DISTINCT FROM OLD\.skip_weekends/.test(m); })());
ok('176 = 이월 방식·보류 변경도 기록', (() => { const m = read('migrations/176_campaign_quota_rules_carry.sql'); return /NEW\.carry_strategy\s+IS DISTINCT FROM OLD\.carry_strategy/.test(m) && /NEW\.carry_mode\s+IS DISTINCT FROM OLD\.carry_mode/.test(m); })());
ok('175 칸도 부팅 점검 · 오늘 반영 후 목록 캐시 비움', /\['recruit_campaigns', 'quota_rules_changed_at'\]/.test(require('fs').readFileSync(require('path').join(__dirname,'../index.js'),'utf8')) && /cr\.invalidateListCache\(\)/.test(src));
ok('작업오더에서 정원을 빌려 쓰는 공고는 묻지 않음', /eff\.dailySource === 'work_order' \|\| eff\.totalSource === 'work_order'\) return null/.test(src));
ok('오늘 더할 인원은 하루 상한 9999 안에서', /MAX_DAY_COUNT - todayQuota/.test(src));
ok('작업표 줄 경고는 만든 쪽 문구(ra.message·ra.over)', /ra\.message \|\|/.test(src) && /ra\.over != null/.test(src) && !/ra\.excess/.test(src));
ok('참여형으로 바꾼 날도 게시 시각을 새로 남김', /COALESCE\(\$20, participation_mode\) = TRUE AND participation_mode IS DISTINCT FROM TRUE/.test(require('fs').readFileSync(require('path').join(__dirname,'../src/routes/campaign.routes.js'),'utf8')));
ok('177 = 작업 종류 변경도 기록 · 배포 시각으로 기존 공고 채움', (() => { const m = read('migrations/177_campaign_quota_rules_init.sql'); return /NEW\.work_kind\s+IS DISTINCT FROM OLD\.work_kind/.test(m) && /UPDATE recruit_campaigns SET quota_rules_changed_at = NOW\(\) WHERE quota_rules_changed_at IS NULL/.test(m); })());
ok('필요 마이그레이션 미적용이면 팝업을 끈다 · 확정 시각 미상 공고 제외', /'177_campaign_quota_rules_init\.sql'/.test(src) && /if \(unknownTime === null \|\| unknownTime\.has\(String\(c\.id\)\)\) continue/.test(src));
ok('고를 게 없어도 15분마다 다시 받는다', /if \(now - \(S\.lastFetch \|\| 0\) < REFRESH_MS\) return;/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('178 = 연결 작업표 변경도 기록', (() => { const m = read('migrations/178_campaign_quota_rules_link.sql'); return /NEW\.linked_sheet_id\s+IS DISTINCT FROM OLD\.linked_sheet_id/.test(m) && /NEW\.linked_tab_name\s+IS DISTINCT FROM OLD\.linked_tab_name/.test(m); })());
ok('주문 원장 조회 실패·함께 쓰는 작업표면 어제 수를 모른다 → 묻지 않음', /if \(!ln \|\| !lp \|\| !ln\.ok \|\| !lp\.ok\) continue/.test(src) && /ln\.sharedTab \|\| lp\.sharedTab \|\|/.test(src));
ok('작업 종류는 공고>탭(resolveWorkKind) · 옵션 변경 공고 제외 · 연결 탭 미상 주문도 제외', /resolveWorkKind\(\{ campaignKind: c\.work_kind, tabKind: c\._tab_work_kind \}\)/.test(src) && !/OR updated_at >= \$2/.test(src) && /WHERE os\.sheet_id = k\.sh\s+AND \(\(os\.deleted_at IS NULL AND os\.submitted_at IS NULL\)/.test(src));
ok('잠근 순간 더할 수 있는 인원이 화면과 다르면 거절', /if \(full !== it\.addable\) throw/.test(src));
ok('필요한 마이그레이션 173~179 전부 기록돼야 켠다', /'173_campaign_shortage_prompt\.sql'/.test(src) && /'179_campaign_quota_rules_visibility\.sql'/.test(src) && /=== REQUIRED_MIGRATIONS\.length/.test(src));
ok('179 = 리뷰어 노출·참여형 전환도 기록', (() => { const m = read('migrations/179_campaign_quota_rules_visibility.sql'); return /NEW\.reviewer_hidden\s+IS DISTINCT FROM OLD\.reviewer_hidden/.test(m) && /NEW\.participation_mode IS DISTINCT FROM OLD\.participation_mode/.test(m); })());
ok('주문 원장 판정은 설정된 운영 방식 기준 · 옵션 총원 한도도 제외 · 잠금 중 미상 주문 재확인 · 탭 작업 종류 변경 제외', /st\.COUNT_BASIS === 'max' && st\.TABLE_QUOTA_MODE === 'on'/.test(src) && /COALESCE\(recruit_total,0\) > 0/.test(src) && /_unknownTimeIds\(client, \[camp\], /.test(src) && /c\._tab_updated_at/.test(src));
ok('180 = 옵션 한도·상태·이름·추가·삭제 시 공고 규칙 변경 기록(결제금액 동기화 제외)', (() => { const m = read('migrations/180_campaign_option_rules_changed.sql'); return /AFTER INSERT OR DELETE ON campaign_options/.test(m) && /AFTER UPDATE OF status, daily_limit, recruit_total, opt_key ON campaign_options/.test(m) && !/pay_amount IS DISTINCT/.test(m); })() && /'180_campaign_option_rules_changed\.sql'/.test(src));
ok('커밋 직전 원장 소비 지문 재대조(두 갈래) · 오늘 공고 밖 주문도 오늘 소비 · gid 범위 · 시트 연결이면 일정 모름', (src.match(/await _assertSigSame\(client/g) || []).length === 2 && /counts\.todayOrders\) \|\| 0\)/.test(src) && /k\.gid <> '' AND NULLIF\(os\.tab_gid,''\) = k\.gid/.test(src) && /sheetScheduleOn && !!c\.linked_sheet_id/.test(src));
ok('[반영] 때 고르지 않은 공고는 이번 로그인 동안 다시 안 띄움', /!S\.deferred\[it\.campaignId\]/.test(require('fs').readFileSync(require('path').join(__dirname,'../../frontend/js/shortage-prompt.js'),'utf8')));
ok('저장 게이트도 오늘 공고 밖 주문을 오늘 소비로', /Number\(quotaCounts && quotaCounts\.todayOrders\) \|\| 0/.test(require('fs').readFileSync(require('path').join(__dirname,'../src/services/campaignPlan.service.js'),'utf8')));
ok('어제 이후 취소된 주문이 있는 공고는 묻지 않음(두 좌표 모두)', (src.match(/OR (os\.)?deleted_at >= \$6/g) || []).length === 2);
console.log(`\ncampaignShortagePrompt: ${passed} passed`);
process.exit(0);
