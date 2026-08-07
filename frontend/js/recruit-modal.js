/* ══════════════════════════════════════════════════════════════
   모집공고 발행·수정 모달 (공유 마크업 · v2 레일 배치)

   원래 admin.html 에 인라인으로 있던 #recruitModal(rf_* 필드)을 **모듈로 뺐다**.
   리뷰웹시스템[3버전]에서도 같은 모달로 발행·수정하려면 마크업이 한 벌이어야 한다 —
   사본을 만들면 필드가 하나만 늘어도 두 화면이 어긋나고, 저장 로직(index-recruit.js)이
   한쪽에서만 동작한다(레포가 반복해서 경고하는 그 드리프트).

   ── v2 재구성(디자인 시안 C — docs/design-recruit-modal-v2.html) ──
   · **참여형이 기본**: 참여형 스위치(녹색 박스)를 화면에서 없앴다. 체크박스 자체는
     hidden 으로 살아 있어(저장 페이로드·서버 분기 무변경) 신규 공고는 항상 켜져 열리고,
     레거시(일반) 공고를 열면 index-recruit 프리필이 꺼서 전용 카드가 숨고 안내가 뜬다.
   · **통일 카드 문법**: 색 박스 4종(녹·녹·보라·주황)을 전부 버리고 흰 카드(.rf-card)
     + 회색 헤더바 한 벌로 통일. 라벨은 82px 우측정렬 한 종(.rf-hrow).
   · **레일 = 배치 편집기**: 좌측 목차 레일에서 ⠿ 를 끌면 본문 카드가 같은 순서로
     재배열되고 localStorage(rf_layout_v1)에 관리자별 저장된다(서버 변경 0).
     고정 2(연결=맨 위 · 게시·점검=맨 아래) + 자유 5(진행상품/모집조건/리뷰비/상품정보/작업내용).
     레일은 진행 상태판 겸용(● 필수 미입력 · ⚠ 경고 · ✓ 입력됨) + 클릭 = 해당 카드로 스크롤.

   ★ 필드 ID는 한 글자도 바꾸지 않았다 — index-recruit.js 의 프리필·저장 로직과
     회귀가드(recruitModalLayout.test.js)가 ID로 묶여 있다.
   ★ 마운트는 멱등 — 이미 있으면 아무 것도 하지 않는다(두 번 부르는 화면 대비).

   사용: <div id="recruitModalMount"></div> 를 두고 이 스크립트를 로드하면 자동 마운트.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var HTML = `<div id="recruitModal" class="modal-overlay hidden" style="display:none">
  <div class="modal-box rf-box" style="max-width:1280px;width:97%;max-height:94vh;display:flex;flex-direction:column;overflow:hidden">
    <div class="modal-header">
      <h3 id="recruitModalTitle"><i class="fas fa-bullhorn"></i> 모집공고 등록</h3>
      <button class="btn-icon-sm" onclick="closeRecruitModal()"><i class="fas fa-times"></i></button>
    </div>
    <!-- 좌: 레일(목차·배치 편집) / 중: 입력 카드 / 우: 미리보기(고정).
         미리보기를 아래로 쌓으면 입력란이 화면 밖으로 밀려 "고치면서 확인"이 안 된다 — 옆으로.
         좁은 화면은 CSS가 레일을 접고 세로로 되돌린다. -->
    <div class="rf-split">
      <nav class="rf-rail">
        <div class="rf-rail-t">섹션 <span style="font-weight:600;letter-spacing:0">— ⠿ 끌어서 배치</span></div>
        <div id="rfRailList"></div>
        <div class="rf-rtip">● 필수 미입력 · ⚠ 경고 · ✓ 입력됨<br>레일에서 끌면 본문 순서가 함께 바뀌고, 이 브라우저의 내 화면에 저장됩니다.</div>
        <div class="rf-rpre">
          <button type="button" class="rf-rpbtn" onclick="RecruitModal.preset('default')">↺ 기본 순서(발행 흐름)</button>
          <button type="button" class="rf-rpbtn" onclick="RecruitModal.preset('edit')">✏️ 수정 최적화</button>
        </div>
      </nav>
      <div class="rf-main">
    <div class="modal-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;flex:1;min-height:0">

      <!-- ═══ 🔗 연결 · 기본 (고정 맨 위 — 시트·탭 연결이 옵션표 프리필·현영 판정·시트 일정 등 모든 자동값의 전제) ═══ -->
      <div class="rf-card" data-sec="link">
        <div class="rf-ch"><span class="rf-pinbadge">고정</span><span class="rf-ct">🔗 연결 · 기본</span><span class="rf-cn">시트·탭이 없으면 공고가 동작하지 않습니다</span></div>
        <div class="rf-cb">
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">시트명 <span class="rform-req">*</span></span>
          <select id="rf_linked_campaign" class="rform-input" onchange="onLinkedCampaignChange(this)">
            <option value="">① 캠페인(시트) 선택</option>
          </select></div>
        <div class="rf-hrow"><span class="rf-hl">탭명 <span class="rform-req">*</span></span>
          <select id="rf_linked_tab" class="rform-input" onchange="onLinkedTabChange(this)" disabled>
            <option value="">② 탭 선택 (시트 먼저)</option>
          </select></div>
      </div>
      <div id="rf_linked_tab_info" style="display:none;font-size:.72rem;color:var(--ok,#12b886);font-weight:600;margin:-4px 0 4px 90px">
        <i class="fas fa-link"></i> <span id="rf_linked_tab_text"></span>
      </div>
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">담당자 <span class="rform-req">*</span></span>
          <div>
            <div style="display:flex;gap:6px;flex-wrap:wrap" id="rf_manager_btns">
              <button class="rchan-btn" data-group="manager" data-val="만두" onclick="selectRfBtn('manager',this)">🥟 만두</button>
              <button class="rchan-btn" data-group="manager" data-val="망고" onclick="selectRfBtn('manager',this)">🥭 망고</button>
            </div>
            <input id="rf_manager" type="hidden">
          </div></div>
        <div class="rf-hrow"><span class="rf-hl">구매채널 <span class="rform-req">*</span></span>
          <div>
            <div style="display:flex;gap:6px;flex-wrap:wrap" id="rf_channel_btns">
              <button class="rchan-btn" data-group="channel" data-val="쿠팡" onclick="selectRfBtn('channel',this)">🛒 쿠팡</button>
              <button class="rchan-btn" data-group="channel" data-val="네이버" onclick="selectRfBtn('channel',this)">🟢 네이버</button>
              <button class="rchan-btn" data-group="channel" data-val="올리브영" onclick="selectRfBtn('channel',this)">🫒 올리브영</button>
              <button class="rchan-btn" data-group="channel" data-val="카카오메이커스" onclick="selectRfBtn('channel',this)">💛 카카오메이커스</button>
              <button class="rchan-btn" data-group="channel" data-val="직접입력" onclick="selectRfBtn('channel',this)">✏️ 직접</button>
            </div>
            <input id="rf_channel_custom" type="text" class="rform-input" placeholder="채널명 직접 입력" style="margin-top:6px;display:none" maxlength="30">
            <input id="rf_channel" type="hidden">
          </div></div>
      </div>
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">배송유형</span>
          <select id="rf_delivery_type" class="rform-input">
            <option value="">선택 안 함</option>
            <option value="빈택배">빈택배</option>
            <option value="실배송">실배송</option>
            <option value="회수건">회수건</option>
          </select></div>
        <div class="rf-hrow"><span class="rf-hl">팀채팅방 <span class="rform-req">*</span></span>
          <input id="rf_chat_url" type="url" class="rform-input" placeholder="https://open.kakao.com/..."></div>
      </div>
        </div>
      </div>

      <!-- 레거시(일반) 공고 안내 — 참여형이 꺼진 공고를 열었을 때만 보인다(신규는 참여형 기본) -->
      <div id="rf_legacy_note" class="rf-card rf-legacy" style="display:none">
        <div class="rf-cb" style="flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="flex:1;min-width:220px;font-size:.75rem;font-weight:700;color:#92400E">📜 레거시(일반) 공고 — 진행상품·모집 조건·작업내용 카드는 참여형 전용이라 표시되지 않습니다.</span>
          <button type="button" class="rchan-btn" onclick="rfLegacyConvert()" style="white-space:nowrap">⚡ 참여형으로 전환</button>
        </div>
      </div>

      <!-- ═══ 📦 진행상품 · 옵션 (참여형 전용 · 표가 정원의 진실원본) ═══ -->
      <div class="rf-card" data-sec="prod" data-part-only style="display:none">
        <div class="rf-ch"><span class="rf-ct">📦 진행상품</span><span class="rf-cn">작업 종류를 먼저 고르세요 · 정원은 표에서 자동 산출</span>
          <button type="button" class="rchan-btn" id="rf_opt_addbtn" onclick="addOptRow()" style="font-size:.72rem;white-space:nowrap"><i class="fas fa-plus"></i> 상품 추가</button></div>
        <div class="rf-cb">
        <div id="rf_opt_wrap" class="rf-pm-none">
          <!-- ★ 작업 종류(2026-08-07 우레온 건) — [옵션 없는 작업]에는 옵션명 칸 자체가 없다.
               상품명 조각이 옵션명으로 승격되던 사고의 입구를 화면에서 제거한다. -->
          <div id="rf_prod_mode_sw" class="rf-pmsw">
            <button type="button" class="rf-pm-btn on" data-mode="none" onclick="setProdMode('none')">옵션 없는 작업</button>
            <button type="button" class="rf-pm-btn" data-mode="opt" onclick="setProdMode('opt')">옵션 있는 작업</button>
            <span class="rf-pm-note" id="rf_prod_mode_note"></span>
            <input id="rf_prod_mode" type="hidden" value="none">
          </div>
          <div class="rf-prod-head" data-pm="none">
            <span>상품명</span><span style="text-align:right">결제금액</span>
            <span style="text-align:right">총인원</span><span style="text-align:right">일건수</span><span></span>
          </div>
          <div class="rf-prod-head" data-pm="opt">
            <span></span><span>옵션명</span><span style="text-align:right">결제금액</span>
            <span style="text-align:right">옵션인원</span><span style="text-align:right">일건수</span><span></span>
          </div>
          <div id="rf_opt_rows"></div>
          <div id="rf_opt_summary" style="font-size:.68rem;color:var(--t3,#94A3B8);margin-top:4px"></div>
          <div class="rf-pm-help" data-pm="none" style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:2px">옵션 없이 진행하는 작업입니다 · 총인원/일건수 0 = 제한 없음 · 여러 상품이면 [상품 추가]</div>
          <div class="rf-pm-help" data-pm="opt" style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:2px">리뷰어가 참여할 때 옵션을 고릅니다 · 상품 총인원은 옵션인원 합계(자동) · 마감 옵션은 흐리게 남습니다(↩ 재개 가능)</div>
          <!-- 표에서 자동 생성되는 저장용 값(작업내용 원문·캠페인 정원) — 화면엔 표만 보인다 -->
          <textarea id="rf_wd_product" style="display:none"></textarea>
          <input id="rf_daily_limit" type="hidden" value="">
          <input id="rf_recruit_total" type="hidden" value="">
        </div>
        </div>
      </div>

      <!-- ═══ 📅 모집 조건 (참여형 전용 — id=rf_part_section 을 카드 자체에 둬 기존 토글 계약 유지) ═══ -->
      <div class="rf-card" data-sec="cond" id="rf_part_section" style="display:none">
        <div class="rf-ch"><span class="rf-ct">📅 모집 조건</span><span class="rf-cn">언제 · 몇 명을 모으나 — 시트 일정이 인식되면 시트가 우선합니다</span></div>
        <div class="rf-cb">
          <div class="rf-grid2">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
              <div><label class="rform-label">시작일 <span id="rf_start_day" style="font-weight:400;color:#9CA3AF"></span></label>
                <input id="rf_start_date" type="date" class="rform-input" onchange="onRecruitDatesChange()"></div>
              <div><label class="rform-label">종료일 <span id="rf_deadline_day" style="font-weight:400;color:#9CA3AF"></span></label>
                <input id="rf_deadline" type="date" class="rform-input" onchange="onRecruitDatesChange()"></div>
            </div>
            <div><label class="rform-label">구매시간대 <span style="font-weight:400;color:#9CA3AF">(비우면 자율주문)</span></label>
              <div style="display:flex;gap:6px;align-items:center">
                <input id="rf_window_start" type="time" class="rform-input" oninput="renderPartCheck()" style="flex:1">
                <span style="color:#9CA3AF;font-weight:800">~</span>
                <input id="rf_window_end" type="time" class="rform-input" oninput="renderPartCheck()" style="flex:1">
              </div>
            </div>
          </div>
          <div id="rf_deadline_warn" style="display:none;font-size:.68rem;font-weight:700;margin-top:4px"></div>
          <div class="rf-grid2" style="margin-top:8px">
            <div class="rf-hrow" style="margin:0"><span class="rf-hl">시간 표기</span>
              <div>
                <input id="rf_time_range" type="text" class="rform-input" placeholder="예) 두시 ~ 네시 · 자율" maxlength="30" oninput="onRecruitTimeRangeInput()">
                <div id="rf_autoorder_note" style="display:none;font-size:.66rem;color:#0ca678;font-weight:700;margin-top:3px">⏱ 자율주문 — 구매시간이 자동으로 비워집니다.</div>
              </div></div>
            <div class="rf-hrow" style="margin:0"><span class="rf-hl">랜딩 URL</span>
              <input id="rf_landing_url" type="text" class="rform-input" placeholder="https:// — 링크유입일 때 [상품 페이지 열기]로 노출"></div>
          </div>
          <!-- 타계정 허용 / 현금영수증 — 색 박스 대신 같은 문법의 필드행(v2 통일) -->
          <div class="rf-grid2" style="margin-top:8px;align-items:start">
            <div class="rf-hrow rf-hrow-top" style="margin:0"><span class="rf-hl">타계정</span>
              <div>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:.76rem">
                  <input type="checkbox" id="rf_multi_account" onchange="onMultiAccountToggle(this.checked)" style="width:15px;height:15px;accent-color:var(--p,#3182F6)">
                  👥 타계정 허용 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.66rem">— 명의당 1건</span>
                </label>
                <div id="rf_multi_section" style="display:none;margin-top:7px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                    <div><label class="rform-label">하루 한도 <span style="font-weight:400;color:#9CA3AF">(0=무제한)</span></label>
                      <input id="rf_multi_daily" type="number" min="0" class="rform-input" placeholder="예: 1" value="1" oninput="renderPartCheck()"></div>
                    <div><label class="rform-label">제한시간(분)</label>
                      <input id="rf_sub_ttl" type="number" min="1" class="rform-input" value="10"></div>
                  </div>
                  <div style="font-size:.64rem;color:var(--t3,#94A3B8);margin-top:4px">타계정 5개 보유 리뷰어는 하루 한도 1이면 5일에 걸쳐 참여합니다.</div>
                </div>
              </div></div>
            <div class="rf-hrow rf-hrow-top" style="margin:0"><span class="rf-hl">현금영수증</span>
              <div>
                <div id="rf_cashrcpt_ro" style="font-size:.74rem;color:var(--t3,#94A3B8);font-weight:700">탭을 연결하면 진행방식에서 판정합니다</div>
                <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">탭 설정 · 읽기 전용 — 발행 여부는 대시보드 탭설정(진행방식)에서 바꿉니다</div>
              </div></div>
          </div>
          <details style="margin-top:8px"><summary style="font-size:.74rem;font-weight:700;color:var(--t3,#94A3B8);cursor:pointer">고급 설정 (참여 제한시간·마감 버퍼)</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
              <div><label class="rform-label">참여 제한시간(분)</label><input id="rf_hold_ttl" type="number" min="5" class="rform-input" value="15"></div>
              <div><label class="rform-label">종료 전 신규참여 마감(분)</label><input id="rf_close_buffer" type="number" min="0" class="rform-input" value="10"></div>
            </div>
          </details>
        </div>
      </div>

      <!-- ═══ 💰 리뷰비 · 입금 (레거시 공고에도 적용되는 상시 카드) ═══ -->
      <div class="rf-card" data-sec="fee">
        <div class="rf-ch"><span class="rf-ct">💰 리뷰비 · 입금</span><span class="rf-cn">참여한 리뷰어에겐 참여 시점 금액이 영구 고정됩니다</span></div>
        <div class="rf-cb">
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">리뷰비 (원)</span>
          <input id="rf_review_fee" type="number" class="rform-input" placeholder="예) 2500" min="0" step="100" oninput="renderFeeSchedule()"></div>
        <div class="rf-hrow"><span class="rf-hl">통장표시</span>
          <input id="rf_transfer_memo" type="text" class="rform-input" placeholder="예) 파우더망고" maxlength="8"></div>
      </div>
      <!-- 이체은행(086) — 작업오더 '물건비' 수취방식에서 자동 판정(현금→하나 / 계산서→케이뱅크).
           [자동]으로 두면 계속 작업오더를 따라가고, 직접 고르면 그 값이 항상 우선한다. -->
      <div class="rf-hrow"><span class="rf-hl">이체은행</span>
        <div>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="rf_transfer_bank_btns">
            <button class="rchan-btn" data-group="transfer_bank" data-val="" onclick="selectRfBtn('transfer_bank',this)">🔄 자동</button>
            <button class="rchan-btn" data-group="transfer_bank" data-val="hana" onclick="selectRfBtn('transfer_bank',this)">🟩 하나은행</button>
            <button class="rchan-btn" data-group="transfer_bank" data-val="kbank" onclick="selectRfBtn('transfer_bank',this)">🟦 케이뱅크</button>
          </div>
          <div id="rf_transfer_bank_hint" style="font-size:.66rem;color:#8B94A1;margin-top:4px">현금이체 → 하나은행 · 수수료(세금계산서) → 케이뱅크</div>
          <input id="rf_transfer_bank" type="hidden">
        </div></div>
      <!-- 기간별 리뷰비(082) — 날짜마다 다른 금액을 지급할 때만 켠다. 끄면(구간 0개) 위 '리뷰비' 한 값으로 종전과 동일 -->
      <div class="rf-fee-box">
        <label class="rf-fee-sw">
          <input type="checkbox" id="rf_fee_sched_on" onchange="onFeeScheduleToggle(this.checked)">
          📅 기간별 리뷰비
          <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.68rem">— 예) 7월 1,000원 · 8월 1,500원</span>
        </label>
        <div id="rf_fee_sched_section" style="display:none;margin-top:8px">
          <div class="rf-fee-head"><span>적용 시작일</span><span style="text-align:right">리뷰비(원)</span><span>메모(관리자만)</span><span></span></div>
          <div id="rf_fee_rows"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">
            <button type="button" class="rchan-btn" style="font-size:.72rem" onclick="addFeeRow()"><i class="fas fa-plus"></i> 구간 추가</button>
            <div id="rf_fee_summary" style="font-size:.66rem;color:var(--t3,#94A3B8)"></div>
          </div>
          <div id="rf_fee_check" style="margin-top:6px"></div>
        </div>
      </div>
        </div>
      </div>

      <!-- ═══ 🛍 상품 정보 (리뷰타입·배지·URL·썸네일 — 레거시 공고에도 적용되는 상시 카드) ═══ -->
      <div class="rf-card" data-sec="info">
        <div class="rf-ch"><span class="rf-ct">🛍 상품 정보</span><span class="rf-cn">리뷰타입 · 안내배지 · URL · 썸네일</span></div>
        <div class="rf-cb">
      <!-- 리뷰타입 (★ 087) — 값 목록의 단일 출처는 server/src/utils/reviewType.js.
           data-val 은 **표준 key**라 서버 저장값과 그대로 왕복한다(라벨은 화면 표기 전용).
           ★ 참여형 전용 카드가 아닌 상시 카드에 둔다 — 레거시 공고도 리뷰타입을 지정해야 한다. -->
      <div class="rf-hrow"><span class="rf-hl">리뷰타입</span>
        <div>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="rf_review_type_btns">
            <button class="rchan-btn" data-group="review_type" data-val="" onclick="selectRfBtn('review_type',this)">미지정</button>
            <button class="rchan-btn" data-group="review_type" data-val="photo" onclick="selectRfBtn('review_type',this)">📷 포토</button>
            <button class="rchan-btn" data-group="review_type" data-val="text" onclick="selectRfBtn('review_type',this)">📝 텍스트</button>
            <button class="rchan-btn" data-group="review_type" data-val="confirm" onclick="selectRfBtn('review_type',this)">✅ 구매확정</button>
            <button class="rchan-btn" data-group="review_type" data-val="star" onclick="selectRfBtn('review_type',this)">⭐ 별점</button>
            <button class="rchan-btn" data-group="review_type" data-val="mixed" onclick="selectRfBtn('review_type',this)">🧩 혼합</button>
          </div>
          <div id="rf_review_type_hint" style="font-size:.7rem;color:var(--t3,#94A3B8);margin-top:5px"></div>
          <input id="rf_review_type" type="hidden">
        </div></div>
      <!-- 안내배지 -->
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">안내배지</span>
        <div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px" id="rf_badge_presets">
            <button class="rbadge-preset" onclick="addPresetBadge('현영건')">현영건</button>
            <button class="rbadge-preset" onclick="addPresetBadge('로켓와우')">로켓와우</button>
            <button class="rbadge-preset" onclick="addPresetBadge('3.3% 공제')">3.3% 공제</button>
            <button class="rbadge-preset" onclick="addPresetBadge('텍스트 제공')">텍스트 제공</button>
            <button class="rbadge-preset" onclick="addPresetBadge('포토리뷰')">포토리뷰</button>
            <button class="rbadge-preset" onclick="addPresetBadge('옵션지정')">옵션지정</button>
            <button class="rbadge-preset" onclick="addPresetBadge('와우 필수')">와우 필수</button>
            <button class="rbadge-preset" onclick="addPresetBadge('사진 5장+')">사진 5장+</button>
            <button class="rbadge-preset" onclick="addPresetBadge('일반결제')">일반결제</button>
            <button class="rbadge-preset" onclick="addPresetBadge('구매확정')">구매확정</button>
          </div>
          <div id="rf_badges_wrap"
            style="display:flex;flex-wrap:wrap;gap:6px;padding:7px 10px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;min-height:40px;cursor:text;align-items:center"
            onclick="document.getElementById('rf_badge_input').focus()">
            <input id="rf_badge_input" type="text" placeholder="배지 직접 입력 후 Enter"
              style="border:none;outline:none;font-size:.78rem;flex:1;min-width:100px;padding:2px 4px;background:transparent"
              onkeydown="handleBadgeInput(event)">
          </div>
        </div>
      </div>
      <!-- 상품 URL / 썸네일 -->
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">상품 URL</span>
        <div>
          <div style="display:flex;gap:5px">
            <input id="rf_product_url" type="url" class="rform-input" placeholder="상품확인용 URL" style="flex:1;min-width:0">
            <button type="button" class="rchan-btn" onclick="fetchProductInfo()" style="white-space:nowrap"><i class="fas fa-cloud-download-alt"></i> 가져오기</button>
            <button type="button" class="rchan-btn" onclick="openRecruitProductUrl()" style="white-space:nowrap" title="상품 페이지를 새 탭에서 엽니다">↗</button>
          </div>
          <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">가져오기: 네이버·올리브영 (쿠팡 제한적)</div>
          <div id="rf_product_preview" style="display:none;margin-top:6px;align-items:center;gap:10px;border:1px solid var(--border,#E2E8F0);border-radius:8px;padding:8px;background:var(--bg2,#fafafa)">
            <img id="rf_pp_img" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border,#E2E8F0);background:#fff">
            <div style="min-width:0;flex:1">
              <div id="rf_pp_name" style="font-weight:700;font-size:.8rem;word-break:break-word"></div>
              <div id="rf_pp_price" style="font-size:.8rem;color:var(--p,#3182f6);font-weight:700;margin-top:2px"></div>
            </div>
          </div>
          <input id="rf_thumbnail" type="hidden">
          <input id="rf_product_name" type="hidden">
          <input id="rf_price" type="hidden">
        </div></div>
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">썸네일</span>
        <div>
          <div style="display:flex;gap:5px">
            <input id="rf_thumb_url" type="url" class="rform-input" style="flex:1;min-width:0;font-size:.72rem" placeholder="쿠팡 이미지 주소 붙여넣기">
            <button type="button" class="rchan-btn" onclick="fetchCampThumbFromUrl()" style="white-space:nowrap"><i class="fas fa-image"></i> 가져오기</button>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input id="rf_thumb_file" type="file" accept="image/*" style="font-size:.7rem;flex:1;min-width:0" onchange="uploadCampThumb(this)">
            <img id="rf_thumb_preview" alt="썸네일 미리보기" style="height:38px;border-radius:7px;border:1px solid var(--border,#E2E8F0);display:none">
          </div>
        </div></div>
        </div>
      </div>

      <!-- ═══ 📝 작업내용 (참여형 전용 — id=rf_work_section 을 카드 자체에 둬 기존 토글 계약 유지) ═══ -->
      <div class="rf-card" data-sec="work" id="rf_work_section" style="display:none">
        <div class="rf-ch"><span class="rf-ct">📝 작업내용</span><span class="rf-cn">참여한 리뷰어에게만 공개</span></div>
        <div class="rf-cb">
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">유입가이드</span>
            <div>
              <textarea id="rf_wd_inflow" class="rform-input" rows="3" placeholder="키워드 검색 or 링크 진입 방법 안내"></textarea>
              <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">있으면 리뷰어 화면에 [상품 페이지 열기]가 뜨지 않습니다(가이드유입)</div>
              <div id="rf_clean_inflow"></div>
            </div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">리뷰가이드</span>
            <div>
              <textarea id="rf_wd_review" class="rform-input" rows="2" placeholder="별점/포토 비율 등"></textarea>
              <div id="rf_clean_review"></div>
            </div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">특이사항</span>
            <textarea id="rf_wd_notes" class="rform-input" rows="2" placeholder="선택 — 참여한 리뷰어에게만 공개"></textarea></div>
        </div>
      </div>

      <!-- ═══ ✅ 게시 · 자동 점검 (고정 맨 아래 — 저장 버튼 직전 확인) ═══ -->
      <div class="rf-card" data-sec="pub">
        <div class="rf-ch"><span class="rf-pinbadge">고정</span><span class="rf-ct">✅ 게시 · 자동 점검</span><span class="rf-cn">제목 · 유의사항 · 상태 — 저장 직전 확인</span></div>
        <div class="rf-cb">
      <div class="rf-hrow"><span class="rf-hl">공고 제목 <span class="rform-req">*</span></span>
        <input id="rf_title" type="text" class="rform-input" placeholder="예) 쿠팡 립밤 리뷰 모집" maxlength="100"></div>
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">유의사항</span>
        <div>
          <textarea id="rf_notes" class="rform-input" rows="2"
            placeholder="참여 전 모두에게 공개되는 짧은 안내만 — 예) 와우회원 전용 · 계정당 1회" style="resize:vertical"></textarea>
          <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">공고 카드에 노출되는 안내문</div>
          <div id="rf_clean_notes"></div>
        </div></div>
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">상태</span>
          <select id="rf_status" class="rform-input">
            <option value="draft">임시저장</option>
            <option value="active">모집중</option>
            <option value="closed">마감</option>
          </select></div>
        <div class="rf-hrow"><span class="rf-hl">모집인원<br><span style="font-weight:400;font-size:.62rem">(레거시)</span></span>
          <input id="rf_max_slots" type="number" class="rform-input" placeholder="0=무제한" min="0" value="0"></div>
      </div>
      <!-- 🧪 085: 리뷰어 미노출(비공개/테스트 공고) — ★ 참여형 여부와 무관하게 항상 보이는 자리.
           참여형 섹션 안에 두면 레거시 공고는 숨길 수 없고, 평소엔 접혀 있어 존재를 모른다. -->
      <div id="rf_hidden_box" style="border:1.5px dashed var(--border,#94A3B8);border-radius:9px;padding:9px 10px;background:#F8FAFC;margin-top:4px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:800;font-size:.78rem;color:#475569">
          <input type="checkbox" id="rf_reviewer_hidden" style="width:15px;height:15px;accent-color:#475569">
          🧪 리뷰어에게 숨김 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.66rem">— 내부 테스트용</span>
        </label>
        <div style="font-size:.64rem;color:var(--t3,#94A3B8);margin-top:4px;line-height:1.5">
          리뷰어 공고 목록에 <b>뜨지 않습니다</b>. 참여·제출은 정상 동작하므로 <b>공고 링크로 직접 들어가</b> 테스트할 수 있어요.
          <span style="color:#B45309">링크를 아는 사람은 들어올 수 있습니다.</span>
        </div>
      </div>
      <!-- 게시 전 자동 점검 — 참여형 전용(레거시 공고엔 점검 항목이 없다) -->
      <div data-part-only style="margin-top:8px;border-top:1px solid var(--border,#EDF1F6);padding-top:8px">
        <div style="font-size:.76rem;font-weight:800;margin-bottom:6px">🧮 게시 전 자동 점검</div>
        <div id="rf_part_check" style="display:flex;flex-direction:column;gap:5px"></div>
      </div>
      <!-- 참여형 여부(기본 ON) — v2에서 스위치 UI 를 없앴다. 값은 이 hidden 체크박스가 계속 들고 있어
           저장 페이로드·서버 분기·프리필(index-recruit.js)이 전부 무변경으로 동작한다. -->
      <input type="checkbox" id="rf_participation" checked onchange="onParticipationToggle(this.checked)" style="display:none">
        </div>
      </div>

    </div>
      </div><!-- /rf-main -->

      <!-- 우측 고정 미리보기 — 왼쪽에서 값을 고치면 여기가 바로 따라 그려진다 -->
      <aside class="rf-side">
    <!-- ── 실시간 미리보기 패널 ── -->
    <div id="rf_preview_section" style="display:flex;flex-direction:column;flex:1;min-height:0;margin:0 14px">
      <div style="padding:10px 0 4px;text-align:center;font-size:.8rem;font-weight:600;color:var(--p,#3182F6)">
        <i class="fas fa-eye"></i> 미리보기
      </div>
      <div id="rf_preview_area" style="padding:0 0 14px;flex:1;min-height:0;overflow-y:auto">
        <!-- 홈·목록에서 리뷰어가 실제로 보는 카드 — campaign-cards.js의 같은 렌더러(cardHtml)로 그려
             제목·채널·배송유형·리뷰비·안내배지·구매시간대·썸네일을 고치면 여기가 바로 따라 그려진다. -->
        <div style="font-size:.68rem;color:var(--t4,#94A3B8);text-align:center;margin-bottom:6px">
          <i class="fas fa-th-large"></i> 홈·목록에서 보이는 카드
        </div>
        <div id="rf_preview_listcard" style="max-width:340px;margin:0 auto 16px;pointer-events:none"></div>
        <div style="font-size:.68rem;color:var(--t4,#94A3B8);text-align:center;margin-bottom:8px">
          <i class="fas fa-mobile-alt"></i> 리뷰어가 참여한 뒤 실제로 보는 화면
        </div>
        <!-- 실제 리뷰어 페이지(campaign.html)와 동일한 공용 렌더러(js/campaign-workdetail.js)로 그린다.
             모형이 아니라 같은 코드라서 화면이 어긋나지 않는다. -->
        <div style="background:#F0F2FA;border-radius:16px;padding:12px;max-width:400px;margin:0 auto">
          <div style="display:flex;align-items:center;gap:10px;background:#FEF3C7;border:1.5px solid #F59E0B;
                      border-radius:12px;padding:10px 14px;margin-bottom:12px">
            <span style="flex:1;font-size:.78rem;font-weight:700;color:#92400E">⏳ 구매양식 제출까지</span>
            <span style="font-size:1.15rem;font-weight:900;color:#92400E" id="rf_prev_ttl">15:00</span>
          </div>
          <div id="rf_preview_card"></div>
          <button type="button" id="rf_preview_full" style="display:none;width:100%;margin-bottom:12px;padding:10px;
                  background:#E0F2FE;color:#075985;border:1px solid #BAE6FD;border-radius:10px;font-size:.78rem;
                  font-weight:800;cursor:pointer;font-family:inherit">
            <i class="fas fa-eye"></i> 전체 화면으로 보기 (참여 전 → 작업가이드 → 제출완료)
          </button>
          <div style="background:#fff;border:1px solid #3182f6;border-radius:14px;padding:14px">
            <div style="font-size:.78rem;font-weight:800;color:#1b64da;margin-bottom:8px">🧾 구매양식 — 구매를 마친 뒤 여기서 바로 제출</div>
            <div style="border:1px dashed #C7D2E3;border-radius:10px;padding:18px;text-align:center;font-size:.74rem;color:#9CA3AF">
              연결된 시트의 구매양식이 이 자리에 표시됩니다
            </div>
          </div>
        </div>
      </div>
    </div>
      </aside>
    </div><!-- /rf-split -->
    <div class="modal-footer" style="padding:12px 18px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border,#E2E8F0)">
      <button onclick="closeRecruitModal()"
        style="padding:8px 18px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;background:#fff;color:var(--t2,#475569);font-size:.82rem;cursor:pointer;font-weight:600">취소</button>
      <button id="recruitSaveBtn" onclick="saveRecruitPost()"
        style="padding:8px 18px;background:var(--p,#3182F6);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-save"></i> 저장
      </button>
    </div>
  </div>
</div>`;

  // 모달 전용 CSS — 마크업과 한 벌이라 같이 옮겼다(admin.html 에 남겨두면
  //   리뷰웹시스템[3버전]에서 모달이 스타일 없이 뜬다). 1회만 주입한다.
  // ★ 모달 '껍데기' CSS(.modal-overlay/.modal-box/.rform-* 등)는 원래 admin.html 이
  //   링크하는 css/index.css 에만 있었다 — 리뷰웹시스템[3버전]은 그 테마를 안 쓰므로 모달이
  //   오버레이가 아니라 **페이지 하단에 일반 블록으로 흘렀다**(실측).
  //   → 필요한 규칙만 `#recruitModal` 로 **스코프해서** 모듈에 동봉한다.
  //     · 스코프 = 호스트 페이지의 다른 모달·폼을 건드리지 않는다
  //     · CSS 변수는 폴백 값을 넣어 admin 테마 변수가 없는 화면에서도 제대로 보인다
  var SHELL_CSS = `#recruitModal.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:5000;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fadeIn .2s ease}
#recruitModal .modal-box{background:var(--card,#FFFFFF);border-radius:24px;width:100%;max-width:460px;max-height:calc(100vh - 40px);box-shadow:0 8px 48px rgba(15,23,42,.18),0 2px 12px rgba(15,23,42,.10);overflow:hidden;display:flex;flex-direction:column;animation:slideUp .22s ease}
#recruitModal .modal-header{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--border,#E2E8F0);background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 100%)}
#recruitModal .modal-header h3{font-size:1rem;font-weight:700}
#recruitModal .modal-header .btn-icon-sm{background:rgba(15,23,42,.06);color:var(--t2,#475569);border:1px solid var(--border,#E2E8F0)}
#recruitModal .modal-header .btn-icon-sm:hover{background:rgba(15,23,42,.12);color:var(--t1,#0F172A)}
#recruitModal .modal-body{padding:20px;overflow-y:auto;flex:1;min-height:0}
#recruitModal .rform-input{padding:8px 11px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;font-size:.82rem;color:var(--t1,#0F172A);outline:none;transition:border-color .15s;font-family:inherit;width:100%;box-sizing:border-box}
#recruitModal .rform-input:focus{border-color:var(--p,#3182F6)}
#recruitModal textarea.rform-input{line-height:1.5}
#recruitModal .rform-label{font-size:.78rem;font-weight:700;color:var(--t2,#475569)}
#recruitModal .rform-group{display:flex;flex-direction:column;gap:5px}
#recruitModal .rform-req{color:var(--err,#EF4444)}
#recruitModal .rchan-btn{padding:5px 13px;border:1.5px solid var(--border,#E2E8F0);border-radius:20px;background:#fff;font-size:.75rem;font-weight:600;color:var(--t2,#475569);cursor:pointer;transition:all .12s}
#recruitModal .rchan-btn:hover{border-color:var(--p,#3182F6);color:var(--p,#3182F6)}
#recruitModal .rchan-btn.active{background:var(--p,#3182F6);border-color:var(--p,#3182F6);color:#fff}
#recruitModal .rbadge-preset{ display:inline-flex;align-items:center;gap:4px; padding:3px 10px;border-radius:20px; border:1.5px dashed #a6c8fb; background:#f5f9ff;color:#1b64da; font-size:.72rem;font-weight:600; cursor:pointer;transition:all .15s; white-space:nowrap; }
#recruitModal .rbadge-preset::before{content:"+";font-weight:700;opacity:.7}
#recruitModal .rbadge-preset:hover{background:#e8f1fe;border-color:#3182f6;border-style:solid;transform:translateY(-1px)}
#recruitModal .rbadge-preset:active{transform:translateY(0);background:#cce0fb}
#recruitModal .admin-header .btn-icon-sm{color:rgba(255,255,255,.8)}
#recruitModal .btn-icon-sm{width:34px;height:34px;background:rgba(255,255,255,.18);border:none;border-radius:50%;color:#fff;font-size:.9rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:var(--tr,all .15s);flex-shrink:0}
#recruitModal .btn-icon-sm:hover{background:rgba(255,255,255,.3)}
#recruitModal.hidden{display:none!important}
/* 폰트어썸이 없는 화면에서도 아이콘 자리가 레이아웃을 밀지 않게 */
#recruitModal .fas:not([class*="fa-"]){display:none}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`;

  /* 폰트어썸이 없는 호스트(리뷰웹시스템[3버전])에서는 아이콘이 **빈 자리**로 뜬다 —
     닫기(×)가 보이지 않으면 모달을 못 닫는다. CSS만으로는 폰트 유무를 알 수 없어
     마운트 시 1회 탐지해 글리프 폴백을 넣는다(폰트어썸이 있으면 아무 것도 안 한다). */
  var ICON_FALLBACK = {
    'fa-times': '\\2715', 'fa-bullhorn': '\\1F4E2', 'fa-link': '\\1F517',
    'fa-cloud-download-alt': '\\2B07', 'fa-image': '\\1F5BC', 'fa-eye': '\\1F441',
    'fa-mobile-alt': '\\1F4F1', 'fa-plus': '\\FF0B', 'fa-save': '\\1F4BE',
  };
  function injectIconFallback() {
    if (document.getElementById('recruit-modal-iconfb')) return;
    var probe = document.createElement('i');
    probe.className = 'fas fa-times';
    probe.style.cssText = 'position:absolute;left:-9999px';
    document.body.appendChild(probe);
    var fam = (getComputedStyle(probe).fontFamily || '');
    document.body.removeChild(probe);
    if (/font\s*awesome/i.test(fam)) return;          // 폰트어썸 있음 — 폴백 불필요
    var rules = Object.keys(ICON_FALLBACK).map(function (k) {
      return '#recruitModal .' + k + '::before{content:"' + ICON_FALLBACK[k] + '"}';
    });
    var st = document.createElement('style');
    st.id = 'recruit-modal-iconfb';
    st.textContent = '#recruitModal .fas{font-style:normal;line-height:1}\n' + rules.join('\n');
    document.head.appendChild(st);
  }

  /* ═══ v2 레이아웃 CSS — 레일(배치 편집) / 카드 한 벌 / 미리보기 ═══
     ★ 이 블록은 @media 밖 최상위에 있어야 한다 — 안에 넣으면 특정 폭에서만 적용된다(실측 버그).
     ★ 변수는 전부 폴백을 단다 — admin 테마(css/index.css)가 없는 화면(리뷰웹시스템[3버전])에서
       var(--border) 가 무효값이 되면 테두리·색이 통째로 날아간다.
     ★ 선택자는 #recruitModal 또는 .rf-* 만 — 호스트 화면 오염 금지(회귀가드가 토큰을 센다). */
  var CSS = `.rf-split{display:flex;flex:1;min-height:0;overflow:hidden}
.rf-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.rf-side{width:340px;flex-shrink:0;border-left:1px solid var(--border,#E2E8F0);background:#F7F9FC;
         display:flex;flex-direction:column;min-height:0}
/* ── 레일(목차 = 배치 편집기) ── */
.rf-rail{width:176px;flex-shrink:0;border-right:1px solid var(--border,#E2E8F0);background:#FAFCFF;
         display:flex;flex-direction:column;min-height:0;overflow-y:auto;padding:10px 8px}
.rf-rail-t{font-size:.62rem;font-weight:800;color:var(--t3,#94A3B8);letter-spacing:.08em;padding:2px 8px 8px}
.rf-ritem{display:flex;gap:6px;align-items:center;padding:8px 8px;border-radius:9px;font-size:.72rem;font-weight:700;
          color:var(--t2,#475569);margin-bottom:2px;cursor:pointer;border:1.5px solid transparent;user-select:none}
.rf-ritem:hover{background:#F1F5FB}
.rf-ritem.on{background:#EEF4FE;color:#1B64DA;border-color:#CFE0FB}
.rf-ritem.rf-lift{opacity:.45;outline:2px dashed var(--p,#3182F6);outline-offset:1px}
.rf-rhnd{cursor:grab;color:#B0BAC9;font-weight:800;letter-spacing:-1px;flex-shrink:0}
.rf-rhnd:active{cursor:grabbing}
.rf-rno{width:17px;height:17px;border-radius:50%;background:#E7EDF6;color:#94A3B8;font-size:.6rem;font-weight:800;
        display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rf-ritem.on .rf-rno{background:var(--p,#3182F6);color:#fff}
.rf-rno-pin{background:transparent;font-size:.66rem}
.rf-rlb{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rf-rmk{font-size:.66rem;font-weight:800;flex-shrink:0}
.rf-rmk.req{color:#DC2626}
.rf-rmk.okk{color:#0B8A64}
.rf-rmk.wrn{color:#B45309}
.rf-rpin,.rf-rpinb{opacity:.82}
.rf-rtip{font-size:.6rem;color:#A9B4C4;font-weight:600;line-height:1.6;padding:8px 8px 6px;margin-top:auto}
.rf-rpre{display:flex;flex-direction:column;gap:4px;padding:0 6px 4px}
.rf-rpbtn{padding:6px 8px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;background:#fff;font-size:.66rem;
          font-weight:700;color:var(--t2,#475569);cursor:pointer;font-family:inherit;text-align:center}
.rf-rpbtn:hover{border-color:var(--p,#3182F6);color:var(--p,#3182F6)}
/* ── 카드 한 벌(색 박스 폐기 — 모든 묶음이 같은 문법) ── */
.rf-card{border:1px solid var(--border,#E2E8F0);border-radius:12px;background:var(--card,#fff);overflow:hidden;flex-shrink:0}
.rf-ch{display:flex;align-items:center;gap:8px;padding:8px 13px;background:#F8FAFD;border-bottom:1px solid var(--border,#E2E8F0)}
.rf-ct{font-size:.78rem;font-weight:800;color:var(--t1,#0F172A);white-space:nowrap}
.rf-cn{flex:1;font-size:.64rem;font-weight:700;color:var(--t3,#94A3B8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rf-cb{padding:11px 13px;display:flex;flex-direction:column;gap:2px}
.rf-pinbadge{font-size:.6rem;font-weight:800;color:#B0BAC9;border:1px dashed var(--border,#E2E8F0);border-radius:6px;padding:1px 6px;flex-shrink:0}
.rf-legacy{border-left:3px solid #F59E0B;background:#FFFDF6}
/* 밀도 — 라벨·입력 간격을 좁혀 한 화면에 더 담는다 */
.rf-main .rform-label{margin-bottom:2px;font-size:.72rem}
.rf-main .rform-input{padding:7px 9px;font-size:.82rem}
.rf-main textarea.rform-input{min-height:52px}
.rf-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;align-items:start;margin-bottom:8px}
@media (max-width:1100px){ .rf-grid2{grid-template-columns:1fr} }
/* 가로 표기 — 라벨 82px 우측정렬 **한 종**(v2 통일 — 종전 64/76px 혼재가 들쭉날쭉의 원인) */
.rf-hrow{display:grid;grid-template-columns:82px 1fr;gap:8px;align-items:center;margin-bottom:8px}
.rf-hrow.rf-hrow-top{align-items:start}
.rf-hrow.rf-hrow-top .rf-hl{padding-top:7px}
.rf-hrow .rf-hl{font-size:.72rem;font-weight:700;color:var(--t2,#475569);text-align:right;line-height:1.25}
.rf-hrow .rform-input{margin:0}
@media (max-width:1100px){
  .rf-hrow,.rf-hrow.rf-hrow-top{grid-template-columns:1fr;gap:3px}
  .rf-hrow .rf-hl{text-align:left;padding-top:0}
}
/* 진행상품 표 — 상품명 · 옵션명 · 결제금액 · 총인원 · 일건수
   ★ 2모드(2026-08-07): [옵션 없는 작업]은 옵션명 칸 자체가 없고, [옵션 있는 작업]은
     상품 그룹 머리(상품명 · 총인원 자동합계) 아래에 옵션 행이 들여쓰기로 붙는다.
     행 DOM(.rf-opt-row + .rf-opt-prod/.rf-opt-name/…)은 **두 모드 공통**이라
     저장 계약(readOptRows/_readProdRows)이 갈라지지 않는다 — 보이는 칸만 CSS로 바뀐다. */
.rf-prod-head,.rf-opt-row{display:grid;grid-template-columns:1.6fr 1fr .85fr .62fr .62fr 26px;gap:6px;align-items:center}
.rf-prod-head{font-size:.62rem;font-weight:800;color:var(--t3,#94A3B8);padding:0 2px 4px;border-bottom:1px solid var(--border,#E2E8F0);margin-bottom:5px}
.rf-opt-row{margin-bottom:6px}
.rf-opt-row .rform-input{font-size:.74rem;padding:6px 7px;margin:0}
.rf-opt-row .rf-opt-pay,.rf-opt-row .rf-opt-rt,.rf-opt-row .rf-opt-dl{text-align:right}
.rf-opt-row .rf-opt-prod.rf-dup{background:#FAFBFD;color:var(--t2,#475569)}
/* 작업 종류 스위치 */
#recruitModal .rf-pmsw{display:flex;align-items:center;gap:0;margin-bottom:9px;flex-wrap:wrap}
#recruitModal .rf-pm-btn{border:1px solid var(--border,#E2E8F0);background:var(--card,#fff);color:var(--t2,#475569);
  font-size:.73rem;font-weight:800;padding:6px 13px;cursor:pointer;margin:0}
#recruitModal .rf-pm-btn:first-of-type{border-radius:9px 0 0 9px}
#recruitModal .rf-pm-btn:nth-of-type(2){border-radius:0 9px 9px 0;border-left:0}
#recruitModal .rf-pm-btn.on{background:var(--p,#3182F6);border-color:var(--p,#3182F6);color:#fff}
#recruitModal .rf-pm-note{font-size:.66rem;color:var(--t3,#94A3B8);font-weight:700;margin-left:9px}
/* 모드별 열 구성 — 숨긴 칸은 값이 남아 있어도 _readProdRows/readOptRows 가 모드를 보고 무시한다 */
#recruitModal .rf-pm-none .rf-prod-head[data-pm="opt"],#recruitModal .rf-pm-opt .rf-prod-head[data-pm="none"],
#recruitModal .rf-pm-none .rf-pm-help[data-pm="opt"],#recruitModal .rf-pm-opt .rf-pm-help[data-pm="none"]{display:none}
#recruitModal .rf-pm-none .rf-prod-head[data-pm="none"],#recruitModal .rf-pm-none .rf-opt-row{grid-template-columns:1.6fr .85fr .62fr .62fr 26px}
#recruitModal .rf-pm-none .rf-opt-name{display:none}
#recruitModal .rf-pm-opt .rf-prod-head[data-pm="opt"],#recruitModal .rf-pm-opt .rf-opt-row{grid-template-columns:18px 1.6fr .85fr .62fr .62fr 26px}
#recruitModal .rf-pm-opt .rf-opt-prod{display:none}
#recruitModal .rf-pm-opt .rf-opt-row::before{content:'└';color:var(--t4,#CBD5E1);font-size:.72rem;text-align:center}
/* 상품 그룹 머리(옵션 있는 작업 전용) */
#recruitModal .rf-gp{border:1px solid var(--border,#E2E8F0);border-radius:10px;padding:9px 10px;margin-bottom:9px;background:#FCFDFF}
#recruitModal .rf-gp-head{display:grid;grid-template-columns:1fr .62fr 26px;gap:6px;align-items:center;margin-bottom:7px}
#recruitModal .rf-gp-head .rform-input{font-size:.76rem;font-weight:700;padding:6px 7px;margin:0}
#recruitModal .rf-gp-total{font-size:.72rem;font-weight:800;text-align:right;color:var(--t2,#475569)}
#recruitModal .rf-gp-add{border:1px dashed var(--border,#CBD5E1);background:transparent;color:var(--t2,#475569);
  border-radius:8px;font-size:.7rem;font-weight:800;padding:5px 10px;cursor:pointer;margin-top:2px}
/* 기간별 리뷰비(082) — 시작일 · 금액 · 메모 (종료일은 받지 않는다: 빈틈·겹침 원천 차단)
   v2: 녹색 강조 박스 → 카드 안의 점선 서브블록(통일 문법 — 켜고 끄는 것은 체크 하나) */
#recruitModal .rf-fee-box{border:1.5px dashed var(--border,#E2E8F0);border-radius:10px;padding:9px 11px;background:#FAFCFF;margin-top:4px}
#recruitModal .rf-fee-sw{display:flex;align-items:center;gap:9px;font-weight:800;font-size:.78rem;cursor:pointer}
#recruitModal .rf-fee-sw input{width:16px;height:16px;accent-color:var(--p,#3182F6)}
#recruitModal .rf-fee-head,#recruitModal .rf-fee-row{display:grid;grid-template-columns:1.05fr .8fr 1.35fr 24px;gap:6px;align-items:center}
#recruitModal .rf-fee-head{font-size:.62rem;font-weight:800;color:var(--t3,#94A3B8);padding:0 2px 4px;
  border-bottom:1px solid var(--border,#E2E8F0);margin-bottom:6px}
#recruitModal .rf-fee-row{margin-bottom:6px}
#recruitModal .rf-fee-row .rform-input{font-size:.74rem;padding:6px 7px;margin:0}
#recruitModal .rf-fee-row .rf-fee-amt{text-align:right}
#recruitModal .rf-fee-row.rf-fee-now{background:#ECFDF5;border-radius:8px;padding:3px;margin:0 -3px 6px}
#recruitModal .rf-fee-del{border:none;background:none;color:#CBD5E1;font-size:.95rem;font-weight:800;cursor:pointer}
#recruitModal .rf-fee-del:hover{color:#EF4444}
#recruitModal .rf-fee-chk{font-size:.7rem;font-weight:700;display:flex;gap:6px;align-items:flex-start;margin-top:4px}
#recruitModal .rf-fee-chk.ok{color:#0ca678}
#recruitModal .rf-fee-chk.warn{color:#B45309}
#recruitModal .rf-fee-chk.err{color:#DC2626}
/* 좁은 화면: 레일을 접고 세로로 되돌린다(입력이 우선 — 배치 편집은 넓은 화면 전용) */
@media (max-width:900px){
  .rf-split{flex-direction:column;overflow-y:auto}
  .rf-rail{display:none}
  .rf-side{width:auto;border-left:none;border-top:2px dashed var(--border,#E2E8F0)}
  .rf-side.collapsed{display:none}
  .rf-pvtoggle{display:block}
}
.rf-pvtoggle{display:none;width:100%;margin:0;padding:9px;background:#EEF3FD;color:var(--p,#3182F6);
             border:none;border-top:1px solid var(--border,#E2E8F0);font-size:.76rem;font-weight:800;cursor:pointer;font-family:inherit}
/* 🧹 4칸 정리 도우미(개선 ③·④) — 감지 경고 + 전/후 미리보기(적용은 사람이) */
.rf-clean-warn{font-size:.7rem;font-weight:700;color:#B45309;display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:5px}
.rf-clean-warn .rchan-btn{font-size:.68rem;padding:3px 10px;background:#FEF3C7;border-color:#F59E0B;color:#92400E}
.rf-clean-pv{border:1.5px dashed #F0B45E;border-radius:9px;background:#FFFDF6;padding:8px 10px;margin-top:6px;font-size:.7rem;color:var(--t2,#475569)}
.rf-clean-pv .rf-cpv-t{font-weight:800;color:#92400E;margin-bottom:4px}
.rf-clean-pv pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:4px 0;line-height:1.65}
.rf-clean-pv .cut{background:#FEE2E2;text-decoration:line-through;border-radius:3px;padding:0 2px}
.rf-clean-pv .keep{background:#DCFCE7;border-radius:3px;padding:0 2px}
.rf-clean-pv .rf-cpv-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}`;
  function injectCss() {
    if (document.getElementById('recruit-modal-css')) return;
    var st = document.createElement('style');
    st.id = 'recruit-modal-css';
    st.textContent = SHELL_CSS + '\n' + CSS;
    document.head.appendChild(st);
  }

  /* ═══════════════════════════════════════════════════════════════
     v2 섹션 배치 — 레일 = 배치 편집기
     · 고정 2: link(맨 위 — 모든 자동값의 전제) / pub(맨 아래 — 저장 직전 확인)
     · 자유 5: prod / cond / fee / info / work — 레일 ⠿ 드래그로 재배치
     · 저장: localStorage.rf_layout_v1 (관리자별·브라우저별 — 서버 변경 0).
       알 수 없는 키는 무시, 빠진 키는 기본 순서 위치로 붙여 버전업에도 안전.
       저장 실패는 기본 순서 폴백(fail-soft).
     · 레거시 공고: 참여형 전용 카드(display:none)는 레일에서도 빠지고 번호가 다시 매겨진다.
       index-recruit 의 onParticipationToggle 이 RecruitModal.refreshRail() 을 불러 동기화.
     ═══════════════════════════════════════════════════════════════ */
  var SEC_FREE = ['prod', 'cond', 'fee', 'info', 'work'];
  var PRESETS = {
    'default': ['prod', 'cond', 'fee', 'info', 'work'],   // 발행 워크플로 순
    'edit':    ['cond', 'fee', 'prod', 'info', 'work'],   // 수정 최적화 — 자주 고치는 것 위로
  };
  var LAYOUT_KEY = 'rf_layout_v1';
  var _drag = null;

  function _mBody() { return document.querySelector('#recruitModal .modal-body'); }
  function _mCard(k) { var b = _mBody(); return b ? b.querySelector('.rf-card[data-sec="' + k + '"]') : null; }

  function loadLayout() {
    try {
      var a = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      return Array.isArray(a) ? a : null;
    } catch (_) { return null; }
  }
  function saveLayout(order) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(order)); } catch (_) { /* fail-soft */ }
  }

  /** 자유 섹션을 order 순으로 pub(맨 아래 고정) 앞에 재배치. 모르는 키 무시·빠진 키는 기본 순서로 보충 */
  function applyLayout(order) {
    var b = _mBody(); if (!b) return;
    var valid = (order || []).filter(function (k) { return SEC_FREE.indexOf(k) >= 0; });
    SEC_FREE.forEach(function (k) { if (valid.indexOf(k) < 0) valid.push(k); });
    var pub = _mCard('pub');
    valid.forEach(function (k) { var c = _mCard(k); if (c && pub) b.insertBefore(c, pub); });
    renderRail();
  }

  function currentOrder() {
    var b = _mBody(), out = [];
    if (!b) return out;
    Array.prototype.forEach.call(b.querySelectorAll('.rf-card[data-sec]'), function (c) {
      var k = c.getAttribute('data-sec');
      if (SEC_FREE.indexOf(k) >= 0) out.push(k);
    });
    return out;
  }

  /** 레일을 본문 카드(보이는 것만)에서 다시 그린다 — 목록의 단일 출처는 본문 DOM */
  function renderRail() {
    var rail = document.getElementById('rfRailList'), b = _mBody();
    if (!rail || !b) return;
    var html = [], no = 0;
    Array.prototype.forEach.call(b.querySelectorAll('.rf-card[data-sec]'), function (c) {
      if (c.style.display === 'none') return;    // 레거시 공고에서 숨은 참여형 카드
      var k = c.getAttribute('data-sec');
      var t = c.querySelector('.rf-ct'); t = t ? t.textContent : k;
      var pin = (k === 'link'), pinb = (k === 'pub');
      var noHtml = (pin || pinb) ? '<span class="rf-rno rf-rno-pin">📌</span>'
                                 : '<span class="rf-rno">' + (++no) + '</span>';
      var hnd = (pin || pinb) ? '' : '<span class="rf-rhnd" title="끌어서 배치">⠿</span>';
      html.push('<div class="rf-ritem' + (pin ? ' rf-rpin' : '') + (pinb ? ' rf-rpinb' : '') +
        '" data-key="' + k + '">' + hnd + noHtml +
        '<span class="rf-rlb">' + t + '</span><span class="rf-rmk" data-mk="' + k + '"></span></div>');
    });
    rail.innerHTML = html.join('');
    bindRail(rail);
    updateRailMarks();
  }

  function bindRail(rail) {
    Array.prototype.forEach.call(rail.children, function (it) {
      var key = it.getAttribute('data-key');
      it.addEventListener('click', function () {
        var c = _mCard(key);
        if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveRail(key); }
      });
      var h = it.querySelector('.rf-rhnd');
      if (!h) return;                                        // 고정 항목은 드래그 없음
      h.addEventListener('mousedown', function () { it.draggable = true; });
      it.addEventListener('dragstart', function () {
        _drag = it;
        setTimeout(function () { it.classList.add('rf-lift'); }, 0);
      });
      it.addEventListener('dragend', function () {
        it.classList.remove('rf-lift');
        it.draggable = false;
        if (_drag === it) commitRailOrder();                 // drop 미발화(밖에 놓음)에도 확정
        _drag = null;
      });
    });
    if (!rail._rfDnD) {
      rail._rfDnD = 1;
      rail.addEventListener('dragover', function (e) {
        if (!_drag) return;
        e.preventDefault();
        var els = Array.prototype.filter.call(rail.children, function (el) {
          return el !== _drag && el.querySelector('.rf-rhnd');   // 자유 항목 사이로만
        });
        var after = null;
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { after = els[i]; break; }
        }
        if (after) rail.insertBefore(_drag, after);
        else {
          var pinb = rail.querySelector('.rf-rpinb');            // 하단 고정(pub) 위까지만
          if (pinb) rail.insertBefore(_drag, pinb); else rail.appendChild(_drag);
        }
      });
      rail.addEventListener('drop', function (e) { e.preventDefault(); });
    }
  }

  /** 레일 순서 → 본문 재배치 + 저장. 숨은 카드(레일에 없음)는 현재 위치를 유지한 채 병합 */
  function commitRailOrder() {
    var rail = document.getElementById('rfRailList');
    if (!rail) return;
    var order = [];
    Array.prototype.forEach.call(rail.children, function (it) {
      var k = it.getAttribute('data-key');
      if (SEC_FREE.indexOf(k) >= 0) order.push(k);
    });
    var merged = order.slice();
    currentOrder().forEach(function (k) { if (merged.indexOf(k) < 0) merged.push(k); });
    var b = _mBody(), pub = _mCard('pub');
    merged.forEach(function (k) { var c = _mCard(k); if (c && pub) b.insertBefore(c, pub); });
    saveLayout(merged);
    renderRail();
  }

  /* ── 레일 상태 표시(● 필수 미입력 · ⚠ 경고 · ✓ 입력됨) — 가벼운 판정만(진실은 저장 시 서버 게이트) ── */
  function _val(id) {
    var el = document.getElementById(id);
    return el && el.value ? String(el.value).trim() : '';
  }
  function _railMark(key) {
    switch (key) {
      case 'link':
        return (_val('rf_linked_tab') && _val('rf_manager') && _val('rf_channel') && _val('rf_chat_url')) ? 'ok' : 'req';
      case 'pub': {
        if (!_val('rf_title')) return 'req';
        var pc = document.getElementById('rf_part_check');
        var t = pc ? (pc.textContent || '') : '';
        var w = (t.match(/[⚠⛔]/g) || []).length;
        return w ? ('warn:' + w) : 'ok';
      }
      case 'prod': { var r = document.getElementById('rf_opt_rows'); return (r && r.children.length) ? 'ok' : ''; }
      case 'cond': return (_val('rf_start_date') || _val('rf_window_start')) ? 'ok' : '';
      case 'fee':  return _val('rf_review_fee') ? 'ok' : '';
      case 'info': return (_val('rf_thumbnail') || _val('rf_thumb_url') || _val('rf_product_url')) ? 'ok' : '';
      case 'work': return (_val('rf_wd_inflow') || _val('rf_wd_review')) ? 'ok' : '';
    }
    return '';
  }
  function updateRailMarks() {
    var rail = document.getElementById('rfRailList');
    if (!rail) return;
    Array.prototype.forEach.call(rail.querySelectorAll('.rf-rmk'), function (mk) {
      var s = _railMark(mk.getAttribute('data-mk'));
      if (s === 'ok') { mk.className = 'rf-rmk okk'; mk.textContent = '✓'; mk.title = '입력됨'; }
      else if (s === 'req') { mk.className = 'rf-rmk req'; mk.textContent = '●'; mk.title = '필수 미입력'; }
      else if (s && s.indexOf('warn:') === 0) { mk.className = 'rf-rmk wrn'; mk.textContent = '⚠' + s.slice(5); mk.title = '자동 점검 경고'; }
      else { mk.className = 'rf-rmk'; mk.textContent = ''; mk.title = ''; }
    });
  }
  function setActiveRail(key) {
    var rail = document.getElementById('rfRailList');
    if (!rail) return;
    Array.prototype.forEach.call(rail.children, function (it) {
      it.classList.toggle('on', it.getAttribute('data-key') === key);
    });
  }

  /* 입력 변화 → 상태 표시 갱신(디바운스) + 본문 스크롤 → 현재 섹션 하이라이트(스크롤 스파이) */
  function bindLive() {
    var m = document.getElementById('recruitModal');
    if (!m || m._rfLive) return;
    m._rfLive = 1;
    var t = null;
    var kick = function () { clearTimeout(t); t = setTimeout(updateRailMarks, 180); };
    m.addEventListener('input', kick);
    m.addEventListener('change', kick);
    var b = _mBody();
    if (b) {
      b.addEventListener('scroll', function () {
        if (b._rfTick) return;
        b._rfTick = 1;
        requestAnimationFrame(function () {
          b._rfTick = 0;
          var top = b.scrollTop + 60, act = null;
          Array.prototype.forEach.call(b.querySelectorAll('.rf-card[data-sec]'), function (c) {
            if (c.style.display === 'none') return;
            if (c.offsetTop <= top) act = c.getAttribute('data-sec');
          });
          if (act) setActiveRail(act);
        });
      });
    }
  }

  /* 레거시 공고 → 참여형 전환(안내 카드의 버튼) — hidden 체크박스를 켜고 기존 토글을 태운다 */
  window.rfLegacyConvert = function () {
    var pe = document.getElementById('rf_participation');
    if (!pe) return;
    pe.checked = true;
    if (typeof window.onParticipationToggle === 'function') window.onParticipationToggle(true);
  };

  function mount(id) {
    injectCss();
    var host = document.getElementById(id || 'recruitModalMount');
    if (!host) {
      // 마운트 지점이 없으면 **body 직속**으로 만든다 — 스크롤 컨테이너(.ovwrap 등)
      // 안에 두면 화면 흐름에 섞여 보이거나 조상 transform 에 갇힌다.
      if (!document.body) return false;    // <head> 에서 로드된 경우 — DOM 준비 후 재시도
      host = document.createElement('div');
      host.id = 'recruitModalMount';
      document.body.appendChild(host);
    }
    if (!document.getElementById('recruitModal')) host.innerHTML = HTML;   // 멱등
    injectIconFallback();
    applyLayout(loadLayout());     // 저장된 배치 복원(없으면 기본 순서) + 레일 렌더
    bindLive();
    return true;
  }

  window.RecruitModal = {
    mount: mount,
    html: HTML,
    refreshRail: renderRail,       // index-recruit onParticipationToggle 이 호출(레거시 카드 숨김 동기화)
    marks: updateRailMarks,
    applyLayout: applyLayout,
    preset: function (name) {
      var p = PRESETS[name] || PRESETS['default'];
      applyLayout(p);
      saveLayout(p.slice());
    },
  };
  // 스크립트가 마운트 지점 뒤에 로드되면 즉시, 아니면 DOM 준비 후
  if (!mount()) document.addEventListener('DOMContentLoaded', function () { mount(); });
})();
