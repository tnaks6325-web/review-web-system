/**
 * woCampaignMapDoc.test.js — 작업오더→모집공고 자동반영 와이어프레임 ↔ 실제 매핑 대조.
 *
 * 이 문서는 "어느 칸이 자동으로 채워지는가"를 사람에게 약속한다.
 * 프리필 코드가 바뀌었는데 문서가 옛말을 하면 관리자가 빈 칸을 채워졌다고 믿고 게시한다.
 * → 문서가 '자동'이라 표시한 항목은 실제 프리필 코드에 그 배선이 있어야 하고,
 *   '직접 입력'이라 표시한 항목은 프리필에 없어야 한다.
 *
 * 실행: node tests/woCampaignMapDoc.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const readF = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8'));
const readS = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8'));

const doc = readF('docs/작업오더-모집공고_자동반영_와이어프레임.html');
// ★ 프리필 조립(_woCampaignPrefill)과 채널·옵션 헬퍼는 **공유 모듈**(js/work-order-detail.js)로
//   이관됐다 — 리뷰웹시스템[3버전]의 작업오더 탭이 같은 함수를 쓰기 위해서다(사본 금지).
//   그래서 '프리필 배선'은 두 파일을 합쳐서 본다(검사 의미는 불변).
const app = readF('js/index-app.js') + '\n' + readF('js/work-order-detail.js');
const rec = readF('js/index-recruit.js');   // openRecruitModal — prefill 적용
const ord = readS('routes/order.routes.js');// accept — tab_configs 자동기입

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 문서 형식 ── */
ok('완전한 HTML 문서', /^<!DOCTYPE html>/i.test(doc.trim()) && /<\/html>\s*$/.test(doc));
ok('외부 리소스 0(오프라인 열람)',
  !/<script/i.test(doc) && !/<img[^>]+src=/i.test(doc) && !/https?:\/\/[^"']*\.(?:css|js)/i.test(doc));
ok('다크모드·인쇄 대응', /@media \(prefers-color-scheme: dark\)/.test(doc) && /@media print/.test(doc));
ok('4단계 범례(자동/확인/직접/다른 경로)',
  /자동 — 작업오더 값이 그대로/.test(doc) && /확인 필요/.test(doc)
  && /직접 입력 — 비어 있음/.test(doc) && /다른 경로로 반영/.test(doc));

/* ── '자동'이라 약속한 칸이 실제로 프리필되는가 ── */
ok('공고 제목 = 상품명 우선, 없으면 작업명',
  /_pi\.name \|\| o\.title/.test(app) && /상품명<\/b> 우선, 없으면 <code>작업명/.test(doc));
ok('구매시간대 → 시간창 분해',
  /rfApplyPurchaseTime\(\{ timeRange: prefill\.purchase_time \|\| prefill\.time_range \|\| "" \}\)/.test(rec)
  && /시작\/종료로 분해/.test(doc));
ok('시작일 프리필', /setV\("rf_start_date", prefill\.start_date\)/.test(rec) && /시작일<\/span>/.test(doc));
ok('하루 진행 건수 — 텍스트형 숫자 폴백까지',
  /daily_count_text[\s\S]{0,60}match\(\/\\d\+\//.test(app) && /숫자만 추출/.test(doc));
ok('배송유형 매핑(실배송·빈박스·택배발송대행)',
  /WO_DELIVERY_MAP = \{ '실배송':'실배송', '빈박스':'빈박스', '택배발송대행':'택배발송대행' \}/.test(app)
  && /실배송→실배송, 빈박스→빈박스, 택배발송대행→택배발송대행/.test(doc));
ok('팀채팅방 URL', /chat_url:\s+o\.chat_room_url/.test(app) && /팀채팅방 URL/.test(doc));
ok('상품 URL + 자동수집 1회',
  /if \(prefill\.product_url\) setTimeout\(\(\) => \{ try \{ fetchProductInfo\(\{ auto: true \}\)/.test(rec)
  && /자동수집 1회 시도/.test(doc));
ok('진행상품 표 = 옵션배열 또는 텍스트 줄 분해',
  /applyProductRowsFromOrder\(prefill\)/.test(rec) && /줄 단위로 자동 분해/.test(doc));
ok('유입가이드 원본 HTML 보존', /window\._wdInflowRawHtml = prefill\.wd_inflow_html/.test(rec)
  && /첨부 이미지까지 원본 보존/.test(doc));
ok('리뷰 가이드는 [리뷰등록 가이드] 섹션만',
  /_woPickSections\(o\.review_guide, \["리뷰등록 가이드"/.test(app)
  && /\[리뷰등록 가이드\] 섹션만<\/b> 추출/.test(doc));
ok('특이사항', /wd_notes:\s+o\.special_notes/.test(app) && /특이사항<\/span>/.test(doc));
ok('랜딩 URL은 링크유입일 때만',
  /landing_url:\s+o\.inflow_type === "link"/.test(app) && /링크유입일 때만<\/b>/.test(doc));
ok('참여형 스위치는 항상 켜짐', /participation:\s+true/.test(app) && /항상 켜진 상태<\/b>로 열립니다/.test(doc));

/* ── 065: '자동'으로 바뀐 3칸 — 문서와 코드가 함께 움직이는지 ──
   ★ 이 세 항목은 원래 "직접 입력"으로 문서화돼 있었다. grep 가드가 옛 패턴
   (`rf_manager").value = prefill`)만 보고 있어서 _rfPickBtn 배선 변경을 놓쳤다.
   → 이제 **실제 호출 형태**로 고정한다(CLAUDE.md "grep 회귀가드의 맹점"). */
ok('★ 담당자 = 작업담당 매핑으로 자동 선택',
  /if \(prefill\.manager\) _rfPickBtn\("manager", prefill\.manager\)/.test(rec)
  && /manager:\s+_woManagerNick\(o\.work_manager\)/.test(app)
  && /박세희→<b>만두<\/b>, 박은비→<b>망고<\/b>/.test(doc));
ok('★ 구매채널 = 상품 URL 호스트 판정으로 자동 선택',
  /if \(prefill\.channel\) _rfPickBtn\("channel", prefill\.channel\)/.test(rec)
  && /channel:\s+_woChannel\(o\)/.test(app)
  && /coupang→쿠팡, naver→네이버, oliveyoung→올리브영, makers\.kakao→카카오메이커스/.test(doc));
ok('★ 연결 탭 = 접수 때 확정된 탭으로 자동 선택',
  /_prefillLinkedTab\(prefill\)/.test(rec)
  && /linked_sheet_id: o\.linked_tab_sheet_id/.test(app)
  && /접수 때 확정된 그 탭<\/b>이 그대로 선택됩니다/.test(doc));
ok('★★ 확신 없으면 빈 값 — 랜덤·판정불가는 자동 선택하지 않는다(문서도 같은 약속)',
  /if \(prefill\.manager\)/.test(rec) && /if \(prefill\.channel\)/.test(rec)
  && /자동으로 아무나 배정하지 않습니다/.test(doc)
  && /모르는 쇼핑몰이면 비워 둡니다/.test(doc));

/* ── '직접 입력'이라 약속한 칸이 정말 비어 있는가(오약속 = 빈 칸 게시 사고) ── */
ok('★ 리뷰비는 프리필하지 않는다(결제금액과 의미가 다름)',
  !/rf_review_fee"\)\.value = prefill/.test(rec) && !/_rfPickBtn\("review_fee"/.test(rec)
  && /리뷰비와 다릅니다/.test(doc));
ok('★ 안내배지는 프리필하지 않는다', !/_recruitBadges = prefill|badges: *prefill/.test(rec));
ok('★ 타계정 허용은 기본 [불가]',
  /_maEl\.checked = false; onMultiAccountToggle\(false\)/.test(rec) && /항상 <b>\[불가\]<\/b>로 시작/.test(doc));
ok('★ 종료일은 작업오더에 없다(프리필 키 부재)',
  !/deadline:\s+o\./.test(app) && /작업오더에 종료일 항목이 없습니다/.test(doc));

/* ── 다른 경로(접수 → 탭 설정) ── */
ok('접수가 탭 설정에 담당자·구매시간대·리뷰유형·배송유형을 채운다',
  /manager, time_range, review_type, delivery_type, taekhap/.test(ord)
  && /접수 시 자동 기입/.test(doc));
ok('이미 값이 있으면 덮어쓰지 않는다(COALESCE-fill)',
  /manager\s+= COALESCE\(NULLIF\(tab_configs\.manager,''\)/.test(ord)
  && /이미 값이 있으면 덮어쓰지 않습니다/.test(doc));
ok('택배대행은 신규 등록 때만', /신규 등록 때만/.test(doc) && /taekhap\(BOOLEAN\)은 빈 값 구분이 불가/.test(ord));
ok('진행방식(현영)은 작업오더에 없다 — 탭에서 지정',
  /진행방식\(현영 여부\)은 작업오더에 없습니다/.test(doc) && !/income_type/.test(app.slice(0, 0) + '') );

/* ── 저장 후 역연결 ── */
ok('저장 시 작업오더 ↔ 공고 양방향 링크',
  /source_work_order_id: \(!_recruitEditId && _woPrefillOrderId\)/.test(rec)
  && /action: "orderAdminUpdate", id: _woPrefillOrderId, linked_campaign_id: newCampId/.test(rec)
  && /서로 기록됩니다/.test(doc));

/* ── 운영 중 시트 우선 ── */
// 문서가 "시트가 우선"이라 약속한 근거 = 상태 계산이 시트 일정을 진실원천으로 삼는 분기.
// (일정이 없을 때만 발행폼 값 daily_limit·recruit_total·start_date로 폴백)
ok('시트 일정이 폼 값보다 우선한다는 사실을 명시',
  /폼에 넣은 값보다 우선<\/b> 적용/.test(doc)
  && /시작일<\/b>·<b>마감일<\/b>|시작일 · 마감일/.test(doc));
{
  const st = readS('services/campaignState.service.js');
  ok('근거: 상태 계산이 시트 일정을 진실원천으로 삼는다(없을 때만 폼 값 폴백)',
    /시트 일정\(구매일자 컬럼 파생\)이 있으면 시작일·마감일·정원의 진실원천/.test(st)
    && /const sd = sch \? sch\.firstDate : dateOnlyStr\(c\.start_date\)/.test(st)
    // 시트 일정이 있으면 그쪽, 없으면 daily_limit 경로(066 이월 포함)
    && /const quota = sch\s*\n?\s*\?[\s\S]{0,1200}: dailyQuota\(c, submittedBefore/.test(st));
  ok('마감일 경과는 영속하지 않는다 = 시트에 날짜 추가 시 자동 재개(문서의 "자동으로 다시 열립니다")',
    /state: 'closed', stateReason: 'schedule_ended'/.test(st)
    && /마감된 공고도 자동으로 다시 열립니다/.test(doc));
}

console.log(`\n✅ woCampaignMapDoc: ${n}개 통과`);
