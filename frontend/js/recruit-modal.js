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
  <div class="modal-box rf-box" style="max-width:1124px;width:97%;max-height:94vh;display:flex;flex-direction:column;overflow:hidden">
    <div class="modal-header">
      <h3 id="recruitModalTitle"><i class="fas fa-bullhorn"></i> 모집공고 등록</h3>
      <button class="btn-icon-sm" onclick="closeRecruitModal()"><i class="fas fa-times"></i></button>
    </div>
    <!-- 좌: 레일(목차·배치 편집) / 중: 입력 카드 / 우: 미리보기(고정).
         미리보기를 아래로 쌓으면 입력란이 화면 밖으로 밀려 "고치면서 확인"이 안 된다 — 옆으로.
         좁은 화면은 CSS가 레일을 접고 세로로 되돌린다. -->
    <div class="rf-split">
      <nav class="rf-rail" aria-label="모집공고 편집 단계">
        <div class="rf-rail-t">모집공고 편집<span>현재 단계가 자동으로 바뀝니다.</span></div>
        <div id="rfRailList" class="rf-step-list">
          <button type="button" class="rf-step on" data-rf-step="link"><span class="rf-step-no">1</span><span>연결 · 기본</span><span class="rf-rmk" data-mk="link"></span></button>
          <button type="button" class="rf-step" data-rf-step="prod"><span class="rf-step-no">2</span><span>진행상품 · 상품 정보</span><span class="rf-rmk" data-mk="prod"></span></button>
          <button type="button" class="rf-step" data-rf-step="cond"><span class="rf-step-no">3</span><span>모집 조건</span><span class="rf-rmk" data-mk="cond"></span></button>
        </div>
        <div id="rf_side_audit" class="rf-side-audit"><div class="rf-side-audit-head"><span>자동 점검</span><strong id="rf_side_audit_score">–</strong></div><div id="rf_part_check"></div></div>
      </nav>
      <!-- 이전 카드 편집기는 렌더링하지 않는다. 필드 순서 이동식 UI를 방지한다. -->
      <template id="rf_legacy_card_editor_markup"><div class="rf-main">
    <div id="editorScroller" class="modal-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;flex:1;min-height:0" tabindex="0" aria-label="모집공고 수정 항목">

      <!-- 게시 정보는 시안과 같이 중앙 편집부 최상단에 직접 둔다. 저장 필드 ID는 유지한다. -->
      <section class="rf-card rf-publish-card" data-sec="pub">
        <div class="rf-cb">
          <div class="rf-hrow rf-title-row"><span class="rf-hl">공고 제목 <span class="rform-req">*</span></span>
            <div class="rf-title-control"><input id="rf_title" type="text" class="rform-input" placeholder="예) 쿠팡 립밤 리뷰 모집" maxlength="100"><div id="rf_status_buttons" class="rf-status-buttons"><button type="button" data-rf-status="draft" onclick="RecruitModal.setStatus('draft')">일시대기</button><button type="button" data-rf-status="active" onclick="RecruitModal.setStatus('active')">모집중</button><button type="button" data-rf-status="closed" onclick="RecruitModal.setStatus('closed')">마감</button></div></div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">유의사항</span><div><textarea id="rf_notes" class="rform-input" rows="2" placeholder="참여 전 모두에게 공개되는 짧은 안내만 — 예) 와우회원 전용 · 계정당 1회" style="resize:vertical"></textarea><div class="rf-help">공고 카드에 노출되는 안내문</div><div id="rf_clean_notes"></div></div></div>
          <div class="rf-hrow"><span class="rf-hl">모집인원 <small>(레거시)</small></span><input id="rf_max_slots" type="number" class="rform-input" placeholder="0=무제한" min="0" value="0"></div>
          <select id="rf_status" class="rform-input" onchange="RecruitModal.syncStatusButtons()" hidden><option value="draft">임시저장</option><option value="active">모집중</option><option value="closed">마감</option></select>
          <div id="rf_hidden_box" class="rf-hidden-row"><label><input type="checkbox" id="rf_reviewer_hidden"> 🧪 리뷰어에게 숨김 <span>— 내부 테스트용</span></label><div>리뷰어 공고 목록에 뜨지 않지만, 공고 링크로 직접 테스트할 수 있습니다.</div></div>
          <input type="checkbox" id="rf_participation" checked onchange="onParticipationToggle(this.checked)" style="display:none">
        </div>
      </section>

      <!-- ═══ 🔗 연결 · 기본 (고정 맨 위 — 연결하면 옵션표 프리필·현영 판정·시트 일정을 자동으로 쓴다) ═══ -->
      <div class="rf-card" data-sec="link">
        <div class="rf-ch"><span class="rf-pinbadge">고정</span><span class="rf-ct">🔗 연결 · 기본</span><span id="rf_link_heading_note" class="rf-cn">시트·탭 연결은 나중에 추가할 수 있습니다</span></div>
        <div class="rf-cb">
      <div id="rf_sheet_link_row" class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">시트명 <span class="rf-optional">선택</span></span>
          <select id="rf_linked_campaign" class="rform-input" onchange="onLinkedCampaignChange(this)">
            <option value="">① 캠페인(시트) 선택</option>
          </select><div id="rf_linked_campaign_reference" class="rf-linked-reference" aria-live="polite">작업오더에서 연결되면 자동 표시됩니다.</div></div>
        <div class="rf-hrow"><span class="rf-hl">탭명 <span class="rf-optional">선택</span></span>
          <select id="rf_linked_tab" class="rform-input" onchange="onLinkedTabChange(this)" disabled>
            <option value="">② 탭 선택 (시트 먼저)</option>
          </select><div id="rf_linked_tab_reference" class="rf-linked-reference" aria-live="polite">작업오더에서 연결되면 자동 표시됩니다.</div></div>
      </div>
      <div id="rf_linked_tab_info" hidden style="display:none;font-size:.72rem;color:var(--ok,#12b886);font-weight:600;margin:-4px 0 4px 90px">
        <i class="fas fa-link"></i> <span id="rf_linked_tab_text"></span>
      </div>
      <div id="rf_work_order_link_info" hidden style="display:none;font-size:.72rem;color:var(--ok,#12b886);font-weight:700;margin:-4px 0 4px 90px"></div>
      <!-- 탭이 비어 있을 때: 왜 비었는지(작업오더의 탭을 못 찾음) + 제목 유사도 추천.
           ★ 조용한 빈칸 금지 — 자동점검은 "gid 가 필요해요"라고만 하고 사유를 말하지 않는다. -->
      <div id="rf_linked_tab_note" style="display:none"></div>
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
            <option value="실배송">실배송</option>
            <option value="빈박스">빈박스</option>
            <option value="택배발송대행">택배발송대행</option>
          </select>
          <div id="rf_delivery_toggle" class="rf-delivery-toggle" role="group" aria-label="배송유형">
            <button type="button" data-rf-delivery="실배송">실배송</button>
            <button type="button" data-rf-delivery="빈박스">빈박스</button>
            <button type="button" data-rf-delivery="택배발송대행">택배발송대행</button>
          </div></div>
        <div class="rf-hrow rf-parity-time-row"><span class="rf-hl">구매시간대</span>
          <div class="rf-parity-time-control">
            <input id="rf_time_range" type="hidden" value=""><input id="rf_window_start" type="hidden" value=""><input id="rf_window_end" type="hidden" value="">
            <div class="rf-time-control"><button id="rf_free_time_toggle" type="button" class="rf-time-free" aria-pressed="false" onclick="rfSetFreeTime(!this.classList.contains('on'))"><span class="rf-time-switch" aria-hidden="true"><span class="rf-time-knob"></span></span><span id="rf_free_time_state">시간 지정</span></button>
              <div id="rf_time_range_control" class="rf-time-range"><button id="rf_window_start_button" type="button" class="rf-time-field" data-rf-time-trigger aria-haspopup="dialog" aria-expanded="false" onclick="rfOpenTimePicker('rf_window_start')">13:00</button><span class="rf-time-divider" aria-hidden="true">~</span><button id="rf_window_end_button" type="button" class="rf-time-field" data-rf-time-trigger aria-haspopup="dialog" aria-expanded="false" onclick="rfOpenTimePicker('rf_window_end')">18:00</button>
                <div id="rf_time_picker" class="rf-time-picker" role="dialog" aria-label="구매 시간 선택" hidden><div class="rf-time-picker-head"><strong id="rf_time_picker_title">구매 시작 시간</strong><button type="button" onclick="rfCloseTimePicker()" aria-label="시간 선택 닫기">×</button></div><div class="rf-time-picker-body"><div><span>시</span><div id="rf_time_picker_hours" class="rf-time-hour-grid"></div></div><div><span>분</span><div id="rf_time_picker_minutes" class="rf-time-minute-grid"></div></div></div></div>
              </div></div>
          </div>
        </div>
        <div class="rf-hrow"><span class="rf-hl">현금영수증</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:.76rem">
            <input type="checkbox" id="rf_cash_receipt_required" onchange="syncRecruitAutomaticBadges()" style="width:15px;height:15px;accent-color:var(--p,#3182F6)">
            발행 필요 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.66rem">카드와 구매 안내에 자동 표기</span>
          </label></div>
      </div>
      <div class="rf-hrow"><span class="rf-hl">팀채팅방 <span class="rform-req">*</span></span>
          <input id="rf_chat_url" type="url" class="rform-input" placeholder="https://open.kakao.com/..."></div>
      <div class="rf-hrow rf-parity-date-row" onclick="rfOpenStartDatePicker(event)"><span class="rf-hl">모집 시작일 <span class="rform-req">*</span></span><div class="rf-parity-date-control"><input id="rf_start_date" type="date" class="rform-input" onchange="onRecruitDatesChange()"><span id="rf_start_day" class="rf-date-day"></span></div></div>
      <div class="rf-hrow"><span class="rf-hl">주말 포함 여부</span><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:.76rem"><input type="checkbox" id="rf_skip_weekends" style="width:15px;height:15px;accent-color:var(--p,#3182F6)">주말 제외 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.66rem">주말에는 카드만 보이고 신청은 월요일에 재개됩니다</span></label></div>
        </div>
      </div>

      <!-- 시안 순서: 연결·기본 다음에는 리뷰비·입금이 이어진다. -->
      <section class="rf-card rf-fee-card" data-sec="fee">
        <div class="rf-cb">
          <div class="rf-hrow"><span class="rf-hl">리뷰비</span><input id="rf_review_fee" type="number" class="rform-input" placeholder="예) 2500" min="0" step="100" oninput="renderFeeSchedule()"></div>
          <div class="rf-hrow"><span class="rf-hl">입금명</span><input id="rf_transfer_memo" type="text" class="rform-input" placeholder="예) 파우더망고" maxlength="8"></div>
          <div class="rf-hrow"><span class="rf-hl">이체은행</span><div><div id="rf_transfer_bank_btns" class="rf-inline-buttons"><button class="rchan-btn" data-group="transfer_bank" data-val="" onclick="selectRfBtn('transfer_bank',this)">자동</button><button class="rchan-btn" data-group="transfer_bank" data-val="hana" onclick="selectRfBtn('transfer_bank',this)">하나은행</button><button class="rchan-btn" data-group="transfer_bank" data-val="kbank" onclick="selectRfBtn('transfer_bank',this)">케이뱅크</button></div><input id="rf_transfer_bank" type="hidden"><div id="rf_transfer_bank_hint" class="rf-help">현금이체 → 하나은행 · 세금계산서 → 케이뱅크</div></div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">기간별 리뷰비</span><div class="rf-fee-box"><label class="rf-fee-sw"><input type="checkbox" id="rf_fee_sched_on" onchange="onFeeScheduleToggle(this.checked)"> 기간별 리뷰비 사용</label><div id="rf_fee_sched_section" style="display:none"><div class="rf-fee-head"><span>적용 시작일</span><span>리뷰비(원)</span><span>메모</span><span></span></div><div id="rf_fee_rows"></div><button type="button" class="rchan-btn" onclick="addFeeRow()">+ 구간 추가</button><div id="rf_fee_summary"></div><div id="rf_fee_check"></div></div></div></div>
        </div>
      </section>

      <!-- 레거시(일반) 공고 안내 — 참여형이 꺼진 공고를 열었을 때만 보인다(신규는 참여형 기본) -->
      <div id="rf_legacy_note" class="rf-card rf-legacy" style="display:none">
        <div class="rf-cb" style="flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="flex:1;min-width:220px;font-size:.75rem;font-weight:700;color:#92400E">📜 레거시(일반) 공고 — 진행상품·모집 조건·작업내용 카드는 참여형 전용이라 표시되지 않습니다.</span>
          <button type="button" class="rchan-btn" onclick="rfLegacyConvert()" style="white-space:nowrap">⚡ 참여형으로 전환</button>
        </div>
      </div>
      <!-- 일반 공고도 리뷰타입·안내배지·썸네일 설정은 유지한다. 참여형일 때는 진행상품 안으로 이동한다. -->
      <div id="rf_legacy_product_settings_slot"></div>

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
          <div id="rf_product_settings_slot"></div>
        </div>
        </div>
      </div>

      <!-- 이전 조건 위치는 렌더링하지 않는다. 활성 조건 템플릿은 작업내용 뒤에 있다. -->
      <template id="rf_legacy_condition_markup">
      <div class="rf-card" data-legacy-sec="cond" id="rf_part_section" style="display:none">
        <div class="rf-ch"><span class="rf-ct">📅 모집 조건</span><span class="rf-cn">언제 · 몇 명을 모으나 — 시트 일정이 인식되면 시트가 우선합니다</span></div>
        <div class="rf-cb">
          <div class="rf-grid2">
            <div class="rf-hrow"><span class="rf-hl">종료일 <span id="rf_deadline_day" style="font-weight:400;color:#9CA3AF"></span></span>
              <input id="rf_deadline" type="date" class="rform-input" onchange="onRecruitDatesChange()"></div>
          </div>
          <div id="rf_deadline_warn" style="display:none;font-size:.68rem;font-weight:700;margin-top:4px"></div>
          <div class="rf-grid2" style="margin-top:8px">
            <div class="rf-hrow" style="margin:0"><span class="rf-hl">랜딩 URL</span>
              <input id="rf_landing_url" type="text" class="rform-input" placeholder="https:// — 링크유입일 때 [상품 페이지 열기]로 노출"></div>
          </div>
          <!-- ★ 098 이월 반영: 자동(기본=현행) / 보류 후 수동 반영 — 시안 frontend/docs/이월보류_수동반영_와이어프레임.html -->
          <div class="rf-hrow" style="margin:8px 0 0"><span class="rf-hl">모집이월 방식</span>
            <div>
              <input id="rf_carry_mode" type="hidden" value="auto">
              <div style="display:inline-flex;border:1px solid var(--border,#CBD5E1);border-radius:9px;overflow:hidden">
                <button type="button" id="rf_carry_auto" onclick="rfCarrySet('auto')" style="border:0;background:var(--p,#2563EB);color:#fff;padding:6px 13px;font-size:.72rem;font-weight:700;cursor:pointer">자동 반영 (기본)</button>
                <button type="button" id="rf_carry_hold" onclick="rfCarrySet('hold')" style="border:0;background:var(--card,#fff);color:var(--t3,#64748B);padding:6px 13px;font-size:.72rem;font-weight:700;cursor:pointer">보류 후 수동 반영</button>
              </div>
              <div style="font-size:.64rem;color:var(--t3,#94A3B8);margin-top:4px">자동 = 미달분이 다음날 정원에 자동으로 얹힙니다 · 보류 = 쌓아두고 카드 ⏸ 칩·[📅 인원]에서 골라 반영</div>
              <div id="rf_carry_hold_note" style="display:none;margin-top:5px;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:8px;padding:7px 10px;font-size:.68rem;color:#5B21B6">⏸ 보류로 저장하면 자동 이월이 멈추고, 이미 자동 이월로 늘어나 있던 오늘 정원은 기본 일건수로 돌아가며 그만큼 보류로 이동합니다. 반영하지 않아도 물량은 사라지지 않습니다(총량까지 계속 모집 · 종료일만 뒤로).<br>※ 연결 탭의 구매일자로 일정이 잡히는 공고(시트 일정)는 정원을 시트가 정하므로 이 설정이 적용되지 않습니다 — 그때는 [📅 인원]에서 날짜별로 조절하세요.</div>
            </div>
          </div>
          <!-- 타계정 허용 — 색 박스 대신 같은 문법의 필드행(v2 통일) -->
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
          </div>
          <details style="margin-top:8px"><summary style="font-size:.74rem;font-weight:700;color:var(--t3,#94A3B8);cursor:pointer">고급 설정 (참여 제한시간·마감 버퍼)</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
              <div><label class="rform-label">참여 제한시간(분)</label><input id="rf_hold_ttl" type="number" min="5" class="rform-input" value="15"></div>
              <div><label class="rform-label">종료 전 신규참여 마감(분)</label><input id="rf_close_buffer" type="number" min="0" class="rform-input" value="10"></div>
            </div>
          </details>
        </div>
      </div>
      </template>

      <!-- 이전 리뷰비 카드 위치는 렌더링하지 않는다. 활성 행은 연결·기본 아래에 있다. -->
      <template id="rf_legacy_fee_markup">
      <div class="rf-card" data-legacy-sec="fee">
        <div class="rf-ch"><span class="rf-ct">💰 리뷰비 · 입금</span><span class="rf-cn">참여한 리뷰어에겐 참여 시점 금액이 영구 고정됩니다</span></div>
        <div class="rf-cb">
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">리뷰비</span>
          <input id="rf_review_fee" type="number" class="rform-input" placeholder="예) 2500" min="0" step="100" oninput="renderFeeSchedule()"></div>
        <div class="rf-hrow"><span class="rf-hl">입금명</span>
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
      </template>
      <template id="rf_legacy_product_markup">
      <section class="rf-product-settings" data-product-settings>
        <div class="rf-product-settings-head"><span>상품 설정</span></div>
        <div class="rf-cb">
      <!-- 리뷰타입 (★ 087) — 값 목록의 단일 출처는 server/src/utils/reviewType.js.
           data-val 은 **표준 key**라 서버 저장값과 그대로 왕복한다(라벨은 화면 표기 전용).
           ★ 참여형 전용 카드가 아닌 상시 카드에 둔다 — 레거시 공고도 리뷰타입을 지정해야 한다. -->
      <div class="rf-hrow"><span class="rf-hl">리뷰타입</span>
        <div>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="rf_review_type_btns">
            <button class="rchan-btn" data-group="review_type" data-val="" onclick="selectRfBtn('review_type',this)">자율리뷰</button>
            <button class="rchan-btn" data-group="review_type" data-val="photo" onclick="selectRfBtn('review_type',this)">📷 포토</button>
            <button class="rchan-btn" data-group="review_type" data-val="text" onclick="selectRfBtn('review_type',this)">📝 텍스트</button>
            <button class="rchan-btn" data-group="review_type" data-val="confirm" onclick="selectRfBtn('review_type',this)">✅ 구매확정</button>
            <button class="rchan-btn" data-group="review_type" data-val="star" onclick="selectRfBtn('review_type',this)">⭐ 별점</button>
            <button class="rchan-btn" data-group="review_type" data-val="mixed" onclick="selectRfBtn('review_type',this)">🧩 혼합</button>
          </div>
          <div id="rf_review_mix" style="display:none;margin-top:7px;padding:8px 9px;border:1px solid var(--border,#E2E8F0);border-radius:7px;background:var(--bg,#F8FAFC)">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:.72rem">
              <strong style="color:var(--t1,#1E293B)">리뷰 조합</strong>
              <span id="rf_review_mix_total" style="color:var(--t3,#64748B)">합계 0명 · 총인원 0명</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px">
              <label style="font-size:.68rem;color:var(--t3,#64748B)">포토<input class="rform-input" data-mix-type="photo" type="number" min="0" inputmode="numeric" value="0" oninput="syncRecruitReviewTypeMix()" style="width:100%;height:28px;margin-top:3px;text-align:right"></label>
              <label style="font-size:.68rem;color:var(--t3,#64748B)">텍스트<input class="rform-input" data-mix-type="text" type="number" min="0" inputmode="numeric" value="0" oninput="syncRecruitReviewTypeMix()" style="width:100%;height:28px;margin-top:3px;text-align:right"></label>
              <label style="font-size:.68rem;color:var(--t3,#64748B)">구매확정<input class="rform-input" data-mix-type="confirm" type="number" min="0" inputmode="numeric" value="0" oninput="syncRecruitReviewTypeMix()" style="width:100%;height:28px;margin-top:3px;text-align:right"></label>
              <label style="font-size:.68rem;color:var(--t3,#64748B)">별점<input class="rform-input" data-mix-type="star" type="number" min="0" inputmode="numeric" value="0" oninput="syncRecruitReviewTypeMix()" style="width:100%;height:28px;margin-top:3px;text-align:right"></label>
            </div>
          </div>
          <input id="rf_review_type" type="hidden">
        </div></div>
      <!-- 안내배지 -->
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">안내배지</span>
        <div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px" id="rf_badge_presets">
            <button class="rbadge-preset" onclick="addPresetBadge('3.3% 공제')">3.3% 공제</button>
            <button class="rbadge-preset" onclick="addPresetBadge('텍스트 제공')">텍스트 제공</button>
            <button class="rbadge-preset" onclick="addPresetBadge('옵션지정')">옵션지정</button>
            <button class="rbadge-preset" onclick="addPresetBadge('일반결제')">일반결제</button>
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
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">상품 메인 URL</span>
        <div>
          <div style="display:flex;gap:5px">
            <input id="rf_product_url" type="url" class="rform-input" placeholder="상품확인용 URL" style="flex:1;min-width:0">
            <button type="button" class="rchan-btn" onclick="fetchProductInfo()" style="white-space:nowrap"><i class="fas fa-cloud-download-alt"></i> 가져오기</button>
            <button type="button" class="rchan-btn" onclick="openRecruitProductUrl()" style="white-space:nowrap" title="상품 페이지를 새 탭에서 엽니다">↗</button>
          </div>
          <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">가져오기: 네이버·올리브영 (쿠팡 제한적)</div>
          <input id="rf_thumbnail" type="hidden">
          <input id="rf_product_name" type="hidden">
          <input id="rf_price" type="hidden">
        </div></div>
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">공고 썸네일 URL</span>
        <div>
          <div style="display:flex;gap:5px">
            <input id="rf_thumb_url" type="url" class="rform-input" style="flex:1;min-width:0;font-size:.72rem" placeholder="쿠팡 이미지 주소 붙여넣기">
            <button type="button" class="rchan-btn" onclick="fetchCampThumbFromUrl()" style="white-space:nowrap"><i class="fas fa-image"></i> 가져오기</button>
            <button type="button" class="rchan-btn" onclick="openRecruitProductUrl()" title="상품 URL 바로가기" aria-label="상품 URL 바로가기">↗</button>
          </div>
          <div style="font-size:.68rem;color:var(--t3,#94A3B8);margin-top:4px">공고 썸네일 적용방법: 상품페이지에서 썸네일 우클릭→이미지 주소 복사 후 붙혀넣으세요.</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input id="rf_thumb_file" type="file" accept="image/*" style="font-size:.7rem;flex:1;min-width:0" onchange="uploadCampThumb(this)">
            <img id="rf_thumb_preview" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="썸네일 미리보기" style="height:38px;border-radius:7px;border:1px solid var(--border,#E2E8F0);display:none">
          </div>
        </div></div>
        </div>
      </section>

      <!-- ═══ 📝 작업내용 (참여형 전용 — id=rf_work_section 을 카드 자체에 둬 기존 토글 계약 유지) ═══ -->
      <div class="rf-card" data-sec="work" id="rf_work_section" style="display:none">
        <div class="rf-ch"><span class="rf-ct">📝 작업내용</span><span class="rf-cn">참여한 리뷰어에게만 공개</span></div>
        <div class="rf-cb">
          <!-- ★ 세 칸 모두 같은 구조: [입력창][첨부 이미지 스트립] (rows=3 통일 — 칸마다 높이가 다르면
               오른쪽 썸네일 크기·[＋] 위치가 줄마다 달라진다). 스트립 동작은 index-recruit.js 의 _ig* 함수. -->
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">유입가이드</span>
            <div>
              <div class="ig-wrap">
                <textarea id="rf_wd_inflow" class="rform-input" rows="3" placeholder="키워드 검색 or 링크 진입 방법 안내"></textarea>
                <div class="ig-strip" id="rf_ig_inflow" tabindex="0" data-igf="inflow"></div>
                <input type="file" id="rf_igf_inflow" accept="image/*" multiple class="ig-file" onchange="igPickFiles('inflow',this)">
              </div>
              <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">있으면 리뷰어 화면에 [상품 페이지 열기]가 뜨지 않습니다(가이드유입)</div>
              <div class="ig-msg" id="rf_igm_inflow"></div>
              <div id="rf_clean_inflow"></div>
            </div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">리뷰가이드</span>
            <div>
              <div class="ig-wrap">
                <textarea id="rf_wd_review" class="rform-input" rows="3" placeholder="별점/포토 비율 등"></textarea>
                <div class="ig-strip" id="rf_ig_review" tabindex="0" data-igf="review"></div>
                <input type="file" id="rf_igf_review" accept="image/*" multiple class="ig-file" onchange="igPickFiles('review',this)">
              </div>
              <div class="ig-msg" id="rf_igm_review"></div>
              <div id="rf_clean_review"></div>
            </div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">특이사항</span>
            <div>
              <div class="ig-wrap">
                <textarea id="rf_wd_notes" class="rform-input" rows="3" placeholder="선택 — 참여한 리뷰어에게만 공개"></textarea>
                <div class="ig-strip" id="rf_ig_notes" tabindex="0" data-igf="notes"></div>
                <input type="file" id="rf_igf_notes" accept="image/*" multiple class="ig-file" onchange="igPickFiles('notes',this)">
              </div>
              <div class="ig-msg" id="rf_igm_notes"></div>
            </div></div>
        </div>
      </div>

      <!-- 모집 조건은 시안의 마지막 단계에 직접 렌더링한다. -->
      <section class="rf-card" data-sec="cond" id="rf_part_section" style="display:none">
        <div class="rf-ch"><span class="rf-ct">모집 조건</span></div>
        <div class="rf-cb">
          <div class="rf-hrow"><span class="rf-hl">종료일 <span id="rf_deadline_day"></span></span><input id="rf_deadline" type="date" class="rform-input" onchange="onRecruitDatesChange()"></div>
          <div id="rf_deadline_warn" class="rf-help" style="display:none"></div>
          <div class="rf-hrow"><span class="rf-hl">랜딩 URL</span><input id="rf_landing_url" type="text" class="rform-input" placeholder="링크유입 URL은 진행상품 URL에서 자동 제공됩니다"></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">모집이월 방식</span><div><input id="rf_carry_mode" type="hidden" value="auto"><div class="rf-inline-buttons"><button type="button" id="rf_carry_auto" class="rchan-btn active" onclick="rfCarrySet('auto')">자동 반영 (기본)</button><button type="button" id="rf_carry_hold" class="rchan-btn" onclick="rfCarrySet('hold')">보류 후 수동 반영</button></div><div id="rf_carry_hold_note" class="rf-help" style="display:none"></div></div></div>
          <div class="rf-hrow rf-hrow-top"><span class="rf-hl">다계정 허용</span><div><label class="rf-checkline"><input type="checkbox" id="rf_multi_account" onchange="onMultiAccountToggle(this.checked)"> 허용 <span>— 명의당 1건</span></label><div id="rf_multi_section" style="display:none"><div class="rf-inline-inputs"><label>하루 한도 <input id="rf_multi_daily" type="number" min="0" class="rform-input" value="1" oninput="renderPartCheck()"></label><label>제한시간 <input id="rf_sub_ttl" type="number" min="1" class="rform-input" value="10"></label></div></div></div></div>
          <details class="rf-advanced"><summary>고급 설정 (참여 제한시간·마감 버퍼)</summary><div class="rf-inline-inputs"><label>참여 제한시간 <input id="rf_hold_ttl" type="number" min="5" class="rform-input" value="15"></label><label>종료 전 신규참여 마감 <input id="rf_close_buffer" type="number" min="0" class="rform-input" value="10"></label></div></details>
        </div>
      </section>
      </template>

      <!-- 이전 게시 카드 마크업은 이전 배포와의 소스 비교용 비활성 템플릿이다.
           런타임 편집기는 위 최상단의 정적 행 템플릿만 렌더링한다. -->
      <template id="rf_legacy_publish_markup">
      <div class="rf-card rf-publish-card" data-sec="pub">
        <div class="rf-ch"><span class="rf-pinbadge">고정</span><span class="rf-ct">✅ 게시 · 자동 점검</span><span class="rf-cn">제목 · 유의사항 · 상태 — 저장 직전 확인</span></div>
        <div class="rf-cb">
      <div class="rf-hrow rf-title-row"><span class="rf-hl">공고 제목 <span class="rform-req">*</span></span>
        <div class="rf-title-control"><input id="rf_title" type="text" class="rform-input" placeholder="예) 쿠팡 립밤 리뷰 모집" maxlength="100"><div id="rf_status_buttons" class="rf-status-buttons"><button type="button" data-rf-status="draft" onclick="RecruitModal.setStatus('draft')">일시대기</button><button type="button" data-rf-status="active" onclick="RecruitModal.setStatus('active')">모집중</button><button type="button" data-rf-status="closed" onclick="RecruitModal.setStatus('closed')">마감</button></div></div></div>
      <div class="rf-hrow rf-hrow-top"><span class="rf-hl">유의사항</span>
        <div>
          <textarea id="rf_notes" class="rform-input" rows="2"
            placeholder="참여 전 모두에게 공개되는 짧은 안내만 — 예) 와우회원 전용 · 계정당 1회" style="resize:vertical"></textarea>
          <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:3px">공고 카드에 노출되는 안내문</div>
          <div id="rf_clean_notes"></div>
        </div></div>
      <div class="rf-grid2 rf-publish-legacy-fields">
        <div class="rf-hrow" style="display:none"><span class="rf-hl">상태</span>
          <select id="rf_status" class="rform-input" onchange="RecruitModal.syncStatusButtons()">
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
      <div data-part-only class="rf-publish-check-note">자동 점검 결과는 왼쪽 하단에서 확인합니다.</div>
      <!-- 참여형 여부(기본 ON) — v2에서 스위치 UI 를 없앴다. 값은 이 hidden 체크박스가 계속 들고 있어
           저장 페이로드·서버 분기·프리필(index-recruit.js)이 전부 무변경으로 동작한다. -->
      <input type="checkbox" id="rf_participation" checked onchange="onParticipationToggle(this.checked)" style="display:none">
        </div>
      </div>
      </template>

    </div>
      </div></template><!-- /legacy rf-main -->
      <div class="rf-main rf-compact-main">
        <section class="editor">
          <header class="editor-head"><div><h2 id="rf_editor_title">연결 · 기본</h2><p id="rf_editor_description">작업보드와 공고의 기준 정보 및 입금 기준을 먼저 확인합니다.</p></div><span class="autosaved">자동 저장됨</span></header>
          <div class="title-control-bar"><label class="title-control-label" for="rf_title"><span>공고 제목</span><input id="rf_title" type="text" placeholder="예) 쿠팡 립밤 리뷰 모집" maxlength="100"></label><div id="rf_status_buttons" class="square-toggle"><button type="button" data-rf-status="active" onclick="RecruitModal.setStatus('active')">모집중</button><button type="button" data-rf-status="draft" onclick="RecruitModal.setStatus('draft')">일시대기</button><button type="button" data-rf-status="closed" onclick="RecruitModal.setStatus('closed')">마감</button></div><select id="rf_status" hidden onchange="RecruitModal.syncStatusButtons()"><option value="draft">임시저장</option><option value="active">모집중</option><option value="closed">마감</option></select></div>
          <div id="editorScroller" class="compact-editor-scroller" tabindex="0" aria-label="모집공고 수정 항목">
            <section class="section" data-sec="link">
              <div class="section-heading"><div><h3>기본 설정</h3><span class="section-hint">공고 운영과 입금 기준을 설정합니다.</span></div><span class="section-count">11개 항목</span></div>
              <div class="row-form">
                <div class="sheetless-compat-fields" hidden><select id="rf_linked_campaign" onchange="onLinkedCampaignChange(this)"><option value="">① 캠페인(시트) 선택</option></select><select id="rf_linked_tab" onchange="onLinkedTabChange(this)" disabled><option value="">② 탭 선택 (시트 먼저)</option></select><div id="rf_linked_campaign_reference"></div><div id="rf_linked_tab_reference"></div></div>
                <div id="rf_linked_tab_info" hidden><span id="rf_linked_tab_text"></span></div><div id="rf_work_order_link_info" hidden></div><div id="rf_linked_tab_note" hidden></div>
                <div class="form-row"><span class="form-label">유입 방식 <small>작업오더 기준</small></span><div class="form-control"><div id="rf_inflow_type_ui" class="square-toggle"><button type="button" class="active" data-inflow="link" onclick="rfSetInflowType('link',this)">링크유입</button><button type="button" data-inflow="guide" onclick="rfSetInflowType('guide',this)">가이드유입</button></div><input id="rf_inflow_type_value" type="hidden" value="link"><span class="tag public">작업오더 연동 · 상품 페이지 열기</span></div></div>
                <div class="form-row"><span class="form-label">담당자 <em class="required">*</em></span><div class="form-control"><div id="rf_manager_btns" class="choice-set"><button class="choice rchan-btn" data-group="manager" data-val="만두" onclick="selectRfBtn('manager',this)">만두</button><button class="choice rchan-btn" data-group="manager" data-val="망고" onclick="selectRfBtn('manager',this)">망고</button></div><input id="rf_manager" type="hidden"></div></div>
                <div class="form-row"><span class="form-label">구매채널 <em class="required">*</em></span><div class="form-control"><div id="rf_channel_btns" class="square-toggle"><button class="rchan-btn" data-group="channel" data-val="쿠팡" onclick="selectRfBtn('channel',this)">쿠팡</button><button class="rchan-btn" data-group="channel" data-val="네이버" onclick="selectRfBtn('channel',this)">네이버</button><button class="rchan-btn" data-group="channel" data-val="올리브영" onclick="selectRfBtn('channel',this)">올리브영</button><button class="rchan-btn" data-group="channel" data-val="카카오메이커스" onclick="selectRfBtn('channel',this)">카카오메이커스</button><button class="rchan-btn" data-group="channel" data-val="직접입력" onclick="selectRfBtn('channel',this)">직접입력</button></div><input id="rf_channel_custom" placeholder="채널명 직접 입력" hidden><input id="rf_channel" type="hidden"></div></div>
                <div class="form-row"><span class="form-label">배송유형</span><div class="form-control"><select id="rf_delivery_type" hidden><option value="">선택 안 함</option><option value="실배송">실배송</option><option value="빈박스">빈박스</option><option value="택배발송대행">택배발송대행</option></select><div id="rf_delivery_toggle" class="square-toggle"><button type="button" data-rf-delivery="실배송">실배송</button><button type="button" data-rf-delivery="빈박스">빈박스</button><button type="button" data-rf-delivery="택배발송대행">택배발송대행</button></div></div></div>
                <div class="form-row"><span class="form-label">구매 시간대</span><div class="form-control"><input id="rf_time_range" type="hidden" value=""><input id="rf_window_start" type="hidden" value=""><input id="rf_window_end" type="hidden" value=""><div class="rf-time-control"><button id="rf_free_time_toggle" type="button" class="rf-time-free" aria-pressed="false" onclick="rfSetFreeTime(!this.classList.contains('on'))"><span class="rf-time-switch" aria-hidden="true"><span class="rf-time-knob"></span></span><span id="rf_free_time_state">시간 지정</span></button><div id="rf_time_range_control" class="rf-time-range"><button id="rf_window_start_button" type="button" class="rf-time-field" data-rf-time-trigger aria-haspopup="dialog" aria-expanded="false" onclick="rfOpenTimePicker('rf_window_start')">13:00</button><span class="rf-time-divider" aria-hidden="true">~</span><button id="rf_window_end_button" type="button" class="rf-time-field" data-rf-time-trigger aria-haspopup="dialog" aria-expanded="false" onclick="rfOpenTimePicker('rf_window_end')">18:00</button><div id="rf_time_picker" class="rf-time-picker" role="dialog" aria-label="구매 시간 선택" hidden><div class="rf-time-picker-head"><strong id="rf_time_picker_title">구매 시작 시간</strong><button type="button" onclick="rfCloseTimePicker()" aria-label="시간 선택 닫기">×</button></div><div class="rf-time-picker-body"><div><span>시</span><div id="rf_time_picker_hours" class="rf-time-hour-grid"></div></div><div><span>분</span><div id="rf_time_picker_minutes" class="rf-time-minute-grid"></div></div></div></div></div></div></div></div>
                <div class="form-row"><span class="form-label">현금영수증</span><div class="form-control"><input type="checkbox" id="rf_cash_receipt_required" hidden><button type="button" id="rf_cashrcpt_toggle" class="switch-button" aria-pressed="false" onclick="rfToggleCashReceipt()"><span aria-hidden="true"></span></button><strong id="rf_cash_receipt_state">발행 안 함</strong><span class="tag" id="rf_cash_receipt_note">참여자에게 미노출</span></div></div>
                <div class="form-row"><label class="form-label" for="rf_review_fee">리뷰비</label><div class="form-control"><input id="rf_review_fee" type="number" min="0" step="100" oninput="renderFeeSchedule()"></div></div>
                <div class="form-row"><label class="form-label" for="rf_transfer_memo">입금명</label><div class="form-control"><input id="rf_transfer_memo" maxlength="8"></div></div>
                <div class="form-row"><span class="form-label">이체은행</span><div class="form-control"><div id="rf_transfer_bank_btns" class="choice-set"><button class="choice rchan-btn" data-group="transfer_bank" data-val="" onclick="selectRfBtn('transfer_bank',this)">자동</button><button class="choice rchan-btn" data-group="transfer_bank" data-val="hana" onclick="selectRfBtn('transfer_bank',this)">하나은행</button><button class="choice rchan-btn" data-group="transfer_bank" data-val="kbank" onclick="selectRfBtn('transfer_bank',this)">케이뱅크</button></div><input id="rf_transfer_bank" type="hidden"></div></div>
                <div class="form-row"><span class="form-label">기간별 리뷰비</span><div class="form-control"><input type="checkbox" id="rf_fee_sched_on" hidden><button type="button" id="rf_fee_sched_toggle" class="switch-button" aria-pressed="false" onclick="rfToggleFeeSchedule()"><span aria-hidden="true"></span></button><strong id="feeScheduleState">사용 안 함</strong></div></div>
                <div id="rf_fee_sched_section" class="fee-schedule" style="display:none"><div class="fee-schedule-inner"><div class="fee-schedule-box"><div class="fee-head"><span>적용 시작일</span><span>리뷰비</span><span>메모</span><span></span></div><div id="rf_fee_rows"></div><button type="button" class="fee-add rchan-btn" onclick="addFeeRow()">+ 리뷰비 구간 추가</button><div id="rf_fee_summary"></div><div id="rf_fee_check"></div></div></div></div>
                <div class="form-row"><label class="form-label" for="rf_chat_url">팀채팅방 <em class="required">*</em></label><div class="form-control"><input id="rf_chat_url" type="url"></div></div>
                <div class="form-row clickable-date-row" onclick="rfOpenStartDatePicker(event)"><span class="form-label">모집 시작일 <em class="required">*</em></span><div class="form-control"><div class="date-control"><input id="rf_start_date" type="date" onchange="onRecruitDatesChange()"><span id="rf_start_day">날짜 변경</span></div></div></div>
                <div class="form-row"><span class="form-label">주말 포함 여부</span><div class="form-control"><input type="checkbox" id="rf_skip_weekends" hidden><div id="rf_skip_weekends_toggle" class="square-toggle"><button type="button" data-weekend="include" onclick="rfSetWeekendPolicy(false,this)">주말 포함</button><button type="button" data-weekend="exclude" onclick="rfSetWeekendPolicy(true,this)">주말 제외</button></div><span class="tag public" id="weekendNotice">주말 카드 노출 · 신청 차단</span></div></div>
                <div class="form-row"><span class="form-label">다계정 허용</span><div class="form-control"><input type="checkbox" id="rf_multi_account" hidden><div id="rf_multi_account_toggle" class="square-toggle"><button type="button" data-multi="off" onclick="rfSetMultiAccount(false,this)">미허용</button><button type="button" data-multi="on" onclick="rfSetMultiAccount(true,this)">허용</button></div><span class="tag" id="accountNote">기본 제한 적용</span><div id="rf_multi_section" hidden><input id="rf_multi_daily" type="number" min="0" value="1"><input id="rf_sub_ttl" type="number" min="1" value="10"></div></div></div>
              </div>
            </section>
            <section class="section" data-sec="prod" data-part-only>
              <div class="section-heading"><div><h3>진행상품</h3><span class="section-hint">상품, 옵션, 인원을 한 번에 설정하고 자동 합계를 확인</span></div><button type="button" class="product-add rchan-btn" id="rf_opt_addbtn" onclick="addOptRow()">+ 상품 추가</button></div>
              <div class="product-editor"><div class="form-row product-work-type"><span class="form-label">작업 종류</span><div class="form-control"><div id="rf_prod_mode_sw" class="square-toggle"><button type="button" class="rf-pm-btn on" data-mode="none" onclick="setProdMode('none')">옵션 없는 작업</button><button type="button" class="rf-pm-btn" data-mode="opt" onclick="setProdMode('opt')">옵션 있는 작업</button></div><input id="rf_prod_mode" type="hidden" value="none"></div></div><div id="rf_product_main_url" class="form-row product-main-url"><label class="form-label" for="rf_product_url">상품메인 URL</label><div class="form-control"><input id="rf_product_url" type="url" inputmode="url" placeholder="https:// 상품 페이지 URL을 직접 입력하세요" oninput="syncRecruitProductMainUrl()"><button type="button" class="product-link-button" onclick="openRecruitProductUrl()" title="상품 페이지 열기" aria-label="상품 페이지 열기">↗</button></div></div><div id="rf_opt_wrap"><div class="product-head rf-prod-head" data-pm="none"><span>상품명</span><span>결제금액</span><span>총인원</span><span>일건수</span><span></span></div><div class="product-head rf-prod-head" data-pm="opt"><span>옵션 URL</span><span>옵션명</span><span>결제금액</span><span>옵션인원</span><span>일건수</span><span></span></div><div id="rf_opt_rows"></div><div id="rf_opt_summary" class="product-summary"></div><textarea id="rf_wd_product" hidden></textarea><input id="rf_daily_limit" type="hidden"><input id="rf_recruit_total" type="hidden"></div></div>
              <div class="row-form"><div class="form-row rf-review-type-row"><span class="form-label">리뷰 타입</span><div class="form-control"><div class="review-type-buttons"><div id="rf_review_type_btns" class="square-toggle"><button class="rchan-btn" data-group="review_type" data-val="" onclick="selectRfBtn('review_type',this)">자율리뷰</button><button class="rchan-btn" data-group="review_type" data-val="photo" onclick="selectRfBtn('review_type',this)">포토</button><button class="rchan-btn" data-group="review_type" data-val="text" onclick="selectRfBtn('review_type',this)">텍스트</button><button class="rchan-btn" data-group="review_type" data-val="confirm" onclick="selectRfBtn('review_type',this)">구매확정</button><button class="rchan-btn" data-group="review_type" data-val="star" onclick="selectRfBtn('review_type',this)">별점</button><button class="rchan-btn" data-group="review_type" data-val="mixed" onclick="selectRfBtn('review_type',this)">혼합</button></div><input id="rf_review_type" type="hidden"></div><div id="rf_mixed_review_composer" class="mixed-review-composer" hidden><div id="rf_review_mix"><div id="rf_review_mix_rows"></div><span id="rf_review_mix_total" hidden></span></div></div></div></div></div>
                <div class="form-row tall"><span class="form-label">안내배지</span><div class="form-control"><div class="badge-field"><div id="rf_badge_presets" class="badge-presets"><button type="button" onclick="addPresetBadge('3.3% 공제')">+ 3.3% 공제</button><button type="button" onclick="addPresetBadge('텍스트 제공')">+ 텍스트 제공</button><button type="button" onclick="addPresetBadge('옵션지정')">+ 옵션지정</button><button type="button" onclick="addPresetBadge('일반결제')">+ 일반결제</button></div><div id="rf_badges_wrap" class="badge-wrap" onclick="document.getElementById('rf_badge_input').focus()"><input id="rf_badge_input" placeholder="배지 직접 입력 후 Enter" onkeydown="handleBadgeInput(event)"></div></div></div></div>
                <div class="form-row"><span class="form-label">공고 썸네일 URL</span><div class="form-control thumb-url-control"><input id="rf_thumb_url" type="url" placeholder="쿠팡 이미지 주소 붙여넣기"><button type="button" class="product-link-button" onclick="openRecruitProductUrl()">↗</button><input id="rf_thumb_file" type="file" accept="image/*" onchange="uploadCampThumb(this)"><span id="rf_thumb_preview_wrap" class="rf-thumb-preview-wrap" hidden><img id="rf_thumb_preview" alt="썸네일 미리보기"><span id="rf_thumb_preview_state">미리보기</span></span></div></div>
                <div class="form-row thumb-guide-row"><span class="form-label">공고 썸네일 적용방법</span><div class="form-control">상품페이지에서 썸네일 우클릭→이미지 주소 복사 후 붙혀넣으세요.</div></div>
                <div class="form-row tall"><span class="form-label">유입 가이드</span><div class="form-control"><div class="work-compose"><textarea id="rf_wd_inflow" class="rform-input"></textarea><div id="rf_ig_inflow" class="work-image-strip ig-strip" data-igf="inflow"></div><input id="rf_igf_inflow" class="ig-file" type="file" accept="image/*" multiple onchange="igPickFiles('inflow',this)"></div><div id="rf_igm_inflow"></div><div id="rf_clean_inflow"></div></div></div>
                <div class="form-row tall"><span class="form-label">리뷰 가이드</span><div class="form-control"><div class="work-compose"><textarea id="rf_wd_review" class="rform-input"></textarea><div id="rf_ig_review" class="work-image-strip ig-strip" data-igf="review"></div><input id="rf_igf_review" class="ig-file" type="file" accept="image/*" multiple onchange="igPickFiles('review',this)"></div><div id="rf_igm_review"></div><div id="rf_clean_review"></div></div></div>
                <div class="form-row tall"><span class="form-label">특이사항</span><div class="form-control"><div class="work-compose"><textarea id="rf_wd_notes" class="rform-input"></textarea><div id="rf_ig_notes" class="work-image-strip ig-strip" data-igf="notes"></div><input id="rf_igf_notes" class="ig-file" type="file" accept="image/*" multiple onchange="igPickFiles('notes',this)"></div><div id="rf_igm_notes"></div></div></div>
              </div><input id="rf_landing_url" type="hidden"><input id="rf_thumbnail" type="hidden"><input id="rf_product_name" type="hidden"><input id="rf_price" type="hidden"></section>
            <section class="section" data-sec="cond" id="rf_part_section" data-part-only><div class="row-form"><div class="form-row"><span class="form-label">모집이월 방식</span><div class="form-control"><input id="rf_carry_mode" type="hidden" value="auto"><div class="square-toggle"><button type="button" id="rf_carry_auto" onclick="rfCarrySet('auto')">자동 반영</button><button type="button" id="rf_carry_hold" onclick="rfCarrySet('hold')">보류 후 수동 반영</button></div><div id="rf_carry_hold_note" hidden></div></div></div></div><details class="advanced"><summary>마감 · 보류 · 인원 제한 세부 설정</summary><div class="row-form"><div class="form-row"><span class="form-label">모집 마감</span><div class="form-control"><input id="rf_deadline" type="date" onchange="onRecruitDatesChange()"><span id="rf_deadline_day"></span></div></div><div class="form-row"><span class="form-label">최대 참여 제한</span><div class="form-control"><input id="rf_max_slots" type="number"></div></div><div class="form-row"><span class="form-label">마감 버퍼</span><div class="form-control"><input id="rf_close_buffer" type="number"><input id="rf_hold_ttl" type="number" hidden></div></div><div id="rf_deadline_warn" hidden></div></div></details></section>
            <input type="checkbox" id="rf_participation" checked onchange="onParticipationToggle(this.checked)" hidden>
          </div>
          <footer class="footer modal-footer"><span class="footer-copy">필수 항목을 확인하면 게시할 수 있습니다.</span><div><button type="button" class="btn" onclick="closeRecruitModal()">취소</button><button type="button" id="recruitSaveBtnInline" class="rf-savebtn" onclick="saveRecruitPost()">변경 저장</button></div></footer>
        </section>
      </div><!-- /rf-compact-main -->

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
      <button type="button" id="recruitSaveBtn" class="rf-savebtn" onclick="saveRecruitPost()">
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
  var SHELL_CSS = `body.rf-recruit-modal-open{overflow:hidden}
#recruitModal.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:5000;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fadeIn .2s ease}
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
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
/* ── [저장] 버튼 인터랙션 ────────────────────────────────────────
   ★ 인라인 style 을 클래스로 옮겼다 — 인라인은 :hover/:active 의 background 를
     이길 수 없어(특이성 아님, 인라인 우선) "눌렸는지 모르겠다"가 고쳐지지 않는다. */
#recruitModal .rf-savebtn{padding:8px 18px;background:var(--p,#3182F6);color:#fff;border:none;border-radius:8px;
  font-size:.82rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px;font-family:inherit;
  box-shadow:0 1px 2px rgba(49,130,246,.35);transition:background .13s,box-shadow .13s,transform .13s}
#recruitModal .rf-savebtn:hover:not(:disabled){background:#1B6FE0;box-shadow:0 3px 10px rgba(49,130,246,.34);transform:translateY(-1px)}
#recruitModal .rf-savebtn:active:not(:disabled){background:#1560C8;box-shadow:0 1px 2px rgba(49,130,246,.30);transform:translateY(0)}
#recruitModal .rf-savebtn:focus-visible{outline:3px solid rgba(49,130,246,.35);outline-offset:2px}
#recruitModal .rf-savebtn:disabled{cursor:default;transform:none;box-shadow:none}
#recruitModal .rf-savebtn.busy{background:#7FB0F6}
#recruitModal .rf-savebtn.done{background:#16A34A}
#recruitModal .rf-spin{width:12px;height:12px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;
  display:inline-block;animation:rfSpin .7s linear infinite}
@keyframes rfSpin{to{transform:rotate(360deg)}}
/* ── 저장 차단·실패 안내 = 모달 **안쪽** ────────────────────────
   ★ 토스트로 내보내면 안 된다 — 리뷰웹시스템[3버전]의 토스트는 z-index 60 이고
     이 모달은 5000 + backdrop-filter 라 **덮개 아래에 깔려 보이지 않는다**(실측).
     그래서 모달이 떠 있는 동안의 안내는 전부 여기서 그린다. */
#recruitModal .modal-footer{position:relative}
#recruitModal .rf-blockbar{position:absolute;left:18px;right:18px;bottom:calc(100% + 6px);background:#FDF0F0;
  border:1.5px solid #F4C3C3;border-radius:9px;padding:8px 11px;font-size:.74rem;
  font-weight:700;color:#B42318;display:flex;align-items:center;gap:7px;box-shadow:0 4px 14px rgba(180,35,24,.12);
  z-index:2;animation:fadeIn .16s ease}
#recruitModal .rf-blockbar .rf-bb-go{margin-left:auto;flex:none;font-size:.7rem;font-weight:800;color:#B42318;background:#fff;
  border:1px solid #F4C3C3;border-radius:6px;padding:3px 8px;cursor:pointer;font-family:inherit}
#recruitModal .modal-footer.rf-shake{animation:rfShake .38s ease}
@keyframes rfShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(5px)}
  60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
#recruitModal .rf-chk-blink{animation:rfBlink 1.1s ease 2}
@keyframes rfBlink{0%,100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}45%{box-shadow:0 0 0 4px rgba(229,72,77,.28)}}
@media (prefers-reduced-motion: reduce){
  #recruitModal .rf-savebtn:hover:not(:disabled){transform:none}
  #recruitModal .modal-footer.rf-shake{animation:none}
  #recruitModal .rf-chk-blink{animation:none}
}`;

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
.rf-legacy{border-color:#F4C978;background:#FFFDF6}
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
.rf-time-control{display:flex;align-items:center;gap:6px;min-width:0}
.rf-time-free{display:inline-flex;align-items:center;gap:5px;flex:0 0 88px;width:88px;height:30px;padding:0 7px;border:1px solid var(--border,#E2E8F0);border-radius:7px;background:var(--card,#fff);color:var(--t2,#475569);font:inherit;font-size:.68rem;font-weight:800;white-space:nowrap;cursor:pointer;transition:border-color .16s ease-out,background-color .16s ease-out,color .16s ease-out}
.rf-time-free:hover{border-color:var(--p,#3182F6)}
.rf-time-free.on{border-color:#B9D1FA;background:#EEF4FE;color:var(--p,#3182F6)}
.rf-time-switch{position:relative;width:24px;height:14px;border-radius:999px;background:#CBD5E1;transition:background-color .16s ease-out;flex:none}
.rf-time-knob{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .18);transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.rf-time-free.on .rf-time-switch{background:var(--p,#3182F6)}
.rf-time-free.on .rf-time-knob{transform:translateX(10px)}
.rf-time-range{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr);flex:1;min-width:180px}
.rf-time-field{height:30px;min-width:0;padding:0 8px;border:1px solid var(--border,#E2E8F0);background:var(--card,#fff);color:var(--t1,#0F172A);font:inherit;font-size:.76rem;text-align:left;cursor:pointer;transition:border-color .16s ease-out,background-color .16s ease-out}
.rf-time-field:first-child{border-radius:7px 0 0 7px}.rf-time-field:last-of-type{border-left:0;border-radius:0 7px 7px 0}.rf-time-field:hover{border-color:var(--p,#3182F6)}.rf-time-field:disabled{cursor:not-allowed;background:#F3F6FA;color:#94A3B8}
.rf-time-divider{display:grid;place-items:center;border-top:1px solid var(--border,#E2E8F0);border-bottom:1px solid var(--border,#E2E8F0);background:var(--card,#fff);color:var(--t3,#94A3B8);font-size:.72rem}.rf-time-range.is-disabled{opacity:.64}
.rf-time-picker{position:absolute;z-index:30;top:calc(100% + 6px);left:0;width:258px;padding:8px;border:1px solid var(--border,#E2E8F0);border-radius:9px;background:var(--card,#fff);box-shadow:0 14px 28px rgb(0 0 0 / .12)}
.rf-time-picker-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;color:var(--t2,#475569);font-size:.68rem}.rf-time-picker-head button{display:grid;place-items:center;width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--t3,#94A3B8);font:inherit;cursor:pointer}.rf-time-picker-head button:hover{background:#F1F5F9;color:var(--t2,#475569)}
.rf-time-picker-body{display:grid;grid-template-columns:1fr 74px;gap:8px}.rf-time-picker-body>div>span{display:block;margin-bottom:4px;color:var(--t3,#94A3B8);font-size:.6rem;font-weight:800}.rf-time-hour-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:3px}.rf-time-minute-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}.rf-time-hour-grid button,.rf-time-minute-grid button{height:24px;padding:0;border:0;border-radius:4px;background:#F5F7FA;color:var(--t2,#475569);font:inherit;font-size:.62rem;font-weight:800;cursor:pointer}.rf-time-hour-grid button:hover,.rf-time-minute-grid button:hover{background:#E7F0FF;color:var(--p,#3182F6)}.rf-time-hour-grid button.on,.rf-time-minute-grid button.on{background:var(--p,#3182F6);color:#fff}
@media (prefers-reduced-motion:reduce){.rf-time-free,.rf-time-switch,.rf-time-knob,.rf-time-field{transition:none}}
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
#recruitModal .rf-pm-none .rf-opt-url{display:none}
#recruitModal .rf-pm-none .rf-opt-name{display:none}
#recruitModal .rf-pm-opt .rf-prod-head[data-pm="opt"],#recruitModal .rf-pm-opt .rf-opt-row{grid-template-columns:18px minmax(0,1.18fr) minmax(0,1fr) .85fr .62fr .62fr 26px}
#recruitModal .rf-pm-opt .rf-opt-prod{display:none}
#recruitModal .rf-pm-opt .rf-prod-head[data-pm="opt"]::before{content:''}
#recruitModal .rf-pm-opt .rf-prod-head[data-pm="opt"] span:first-child::before{content:'옵션 URL'}
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
/* 🔗 연결 탭 안내 + 유사도 추천 — 탭이 비어 있을 때만 뜬다(선택되면 사라진다) */
.rf-ltnote{margin:-2px 0 6px 90px;border:1px solid #F4C978;border-radius:9px;
  background:#FFFDF6;padding:8px 10px;font-size:.72rem;color:var(--t2,#475569);line-height:1.55}
.rf-ltnote.plain{border-color:var(--p,#3182F6);background:#F6F9FF}
.rf-ltnote b{color:var(--t1,#0F172A)}
.rf-ltnote .rf-ltwant{font-weight:800;color:#92400E;word-break:break-all}
.rf-ltnote .rf-ltrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
.rf-ltnote .rf-ltcap{font-weight:800;color:var(--t2,#475569)}
.rf-ltsug{font-size:.71rem;font-weight:700;border:1px solid var(--border,#E2E8F0);background:#fff;color:var(--t1,#0F172A);
  border-radius:999px;padding:4px 10px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;
  max-width:100%;transition:border-color .12s,background .12s}
.rf-ltsug:hover{border-color:var(--p,#3182F6);background:#F1F6FF}
.rf-ltsug .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}
.rf-ltsug .pc{font-size:.66rem;font-weight:800;color:var(--p,#3182F6);background:#EFF4FF;border-radius:999px;padding:1px 6px;flex:none}
.rf-ltsug .sh{font-size:.65rem;color:var(--t3,#94A3B8);flex:none}
.rf-ltnote .rf-ltwo{font-size:.68rem;font-weight:800;color:#92400E;background:#FEF3C7;border:1px solid #F59E0B;
  border-radius:7px;padding:3px 9px;cursor:pointer;font-family:inherit}
/* 🧹 4칸 정리 도우미(개선 ③·④) — 감지 경고 + 전/후 미리보기(적용은 사람이) */
.rf-clean-warn{font-size:.7rem;font-weight:700;color:#B45309;display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:5px}
.rf-clean-warn .rchan-btn{font-size:.68rem;padding:3px 10px;background:#FEF3C7;border-color:#F59E0B;color:#92400E}
.rf-clean-pv{border:1.5px dashed #F0B45E;border-radius:9px;background:#FFFDF6;padding:8px 10px;margin-top:6px;font-size:.7rem;color:var(--t2,#475569)}
.rf-clean-pv .rf-cpv-t{font-weight:800;color:#92400E;margin-bottom:4px}
.rf-clean-pv pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:4px 0;line-height:1.65}
.rf-clean-pv .cut{background:#FEE2E2;text-decoration:line-through;border-radius:3px;padding:0 2px}
.rf-clean-pv .keep{background:#DCFCE7;border-radius:3px;padding:0 2px}
.rf-clean-pv .rf-cpv-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}
/* 🖼 작업내용 첨부 이미지 — 입력창 오른쪽, 같은 높이 썸네일(시안 A · docs/design-workdetail-images.html)
   ★ 세 칸(유입가이드·리뷰가이드·특이사항)이 같은 마크업·같은 위젯을 쓴다(사본 금지). */
/* ★ box-sizing 을 호스트 리셋에 기대지 않는다 — content-box 인 화면에서는 스트립이 padding·border
   만큼 더 높아져 입력창과 높이가 어긋난다(테마 없는 호스트에서 실측). */
#recruitModal .ig-wrap,#recruitModal .ig-wrap *{box-sizing:border-box}
#recruitModal .ig-wrap{display:flex;gap:8px;align-items:stretch}
#recruitModal .ig-wrap>textarea.rform-input{flex:1;min-width:0;height:82px;min-height:82px;resize:vertical}
#recruitModal .ig-strip{flex:none;width:326px;display:flex;gap:5px;align-items:stretch;height:82px;padding:4px;
  border:1px dashed var(--border,#E2E8F0);border-radius:9px;background:var(--bg2,#F8FAFC);overflow:hidden;
  transition:border-color .15s,background .15s}
#recruitModal .ig-strip.drag{border-style:solid;border-color:var(--p,#3182F6);background:#EEF3FD}
#recruitModal .ig-strip.err{border-color:#FCA5A5;background:#FEF2F2}
#recruitModal .ig-file{display:none}
#recruitModal .ig-thumb{position:relative;flex:none;width:74px;height:100%;border-radius:7px;overflow:hidden;padding:0;
  border:1px solid var(--border,#E2E8F0);background:#EEF1F6;cursor:zoom-in}
#recruitModal .ig-thumb img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
#recruitModal .ig-thumb .ig-x{position:absolute;top:3px;right:3px;width:17px;height:17px;border:none;border-radius:50%;
  background:rgba(16,24,40,.62);color:#fff;font-size:.6rem;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
#recruitModal .ig-thumb .ig-x:hover{background:rgba(220,38,38,.92)}
#recruitModal .ig-thumb .ig-n{position:absolute;left:3px;bottom:3px;font-size:.55rem;font-weight:800;color:#fff;
  background:rgba(16,24,40,.55);border-radius:4px;padding:1px 4px;line-height:1.35}
#recruitModal .ig-thumb .ig-g{position:absolute;left:0;top:0;bottom:0;width:13px;cursor:grab;display:grid;place-items:center;
  background:linear-gradient(90deg,rgba(16,24,40,.5),rgba(16,24,40,0));color:#fff;font-size:.55rem;line-height:1}
#recruitModal .ig-thumb.dragging{opacity:.4}
#recruitModal .ig-thumb.dropL{box-shadow:inset 3px 0 0 var(--p,#3182F6)}
#recruitModal .ig-thumb.dropR{box-shadow:inset -3px 0 0 var(--p,#3182F6)}
#recruitModal .ig-thumb.up img{opacity:.35;filter:grayscale(.4)}
#recruitModal .ig-thumb.up::after{content:"올리는 중";position:absolute;inset:0;display:grid;place-items:center;
  font-size:.55rem;font-weight:800;color:var(--p,#3182F6)}
#recruitModal .ig-thumb.bad{border-color:#FCA5A5}
#recruitModal .ig-thumb.bad img{opacity:.3}
#recruitModal .ig-thumb.bad::after{content:"실패";position:absolute;inset:0;display:grid;place-items:center;
  font-size:.6rem;font-weight:800;color:#DC2626}
#recruitModal .ig-add{flex:none;width:74px;height:100%;padding:0;border:1px dashed var(--border,#E2E8F0);border-radius:7px;
  background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;
  font-size:.6rem;font-weight:700;color:var(--t3,#94A3B8);font-family:inherit}
#recruitModal .ig-add:hover{border-color:var(--p,#3182F6);color:var(--p,#3182F6);background:#F5F9FF}
#recruitModal .ig-add .plus{font-size:.95rem;line-height:1;font-weight:400}
#recruitModal .ig-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  cursor:pointer;border-radius:7px;text-align:center;padding:0 8px;border:none;background:transparent;font-family:inherit}
#recruitModal .ig-empty:hover{background:#F5F9FF}
#recruitModal .ig-empty .t1{font-size:.68rem;font-weight:800;color:var(--t3,#94A3B8)}
#recruitModal .ig-empty .t2{font-size:.6rem;color:var(--t4,#94A3B8)}
#recruitModal .ig-empty:hover .t1{color:var(--p,#3182F6)}
#recruitModal .ig-msg{font-size:.64rem;font-weight:700;margin-top:3px;color:var(--t3,#94A3B8)}
#recruitModal .ig-msg.warn{color:#B45309}
#recruitModal .ig-msg.bad{color:#DC2626}
#recruitModal .ig-msg.ok{color:#15803D}
/* 좁은 화면: 스트립이 입력창 아래로(렌더러는 한 벌 — CSS만 바뀐다) */
@media (max-width:1100px){
  #recruitModal .ig-wrap{flex-direction:column}
  #recruitModal .ig-strip{width:100%}
}
/* 🔍 확대 팝업 — body 직속(모달 스크롤 컨테이너 밖).
   ★★ z-index 는 **이 모달(#recruitModal.modal-overlay = 5000)보다 위**여야 한다.
      종전 3000 은 "모달은 2000"이라는 잘못된 전제로 정한 값이라 확대 화면이 **모달 뒤에서
      열려** 수정 중에는 사진을 크게 볼 수 없었다(실측 신고). 저장 안내(#campSaveFb 6000)
      보다는 아래 — 그 카드는 모달이 닫힌 뒤에 뜬다. */
#igLightbox{position:fixed;inset:0;z-index:5500;background:rgba(8,12,20,.84);display:none;
  align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:34px}
#igLightbox.on{display:flex}
#igLightbox:focus{outline:none}
/* ★ 닫기(✕)는 **이미지 모서리**에 붙인다(화면 모서리 아님) — 그러려면 이미지를 감싼
   래퍼가 이미지 크기 그대로여야 한다: inline-block + line-height:0(이미지 아래 여백 제거). */
#igLightbox .iglb-wrap{position:relative;display:inline-block;max-width:min(980px,86vw);line-height:0}
#igLightbox img{display:block;max-width:100%;max-height:70vh;border-radius:10px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.4)}
#igLightbox .iglb-bar{display:flex;align-items:center;gap:13px;color:#E8EDF6;font-size:.78rem;font-weight:700}
#igLightbox .iglb-btn{width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.28);
  background:rgba(255,255,255,.1);color:#fff;font-size:1.05rem;cursor:pointer;display:grid;place-items:center;padding:0;font-family:inherit}
#igLightbox .iglb-btn:disabled{opacity:.26;cursor:default}
#igLightbox .iglb-btn:not(:disabled):hover{background:rgba(255,255,255,.24)}
/* 이미지 우측상단 — 모서리에 반쯤 걸치게(사진을 가리지 않으면서 어디에 붙은 버튼인지 분명) */
#igLightbox .iglb-close{position:absolute;top:-13px;right:-13px;width:34px;height:34px;border-radius:50%;
  border:1px solid rgba(255,255,255,.34);background:#1B2536;color:#fff;font-size:1rem;line-height:1;cursor:pointer;
  font-family:inherit;box-shadow:0 4px 14px rgba(0,0,0,.45);z-index:1;display:flex;align-items:center;justify-content:center}
#igLightbox .iglb-close:hover{background:#2A3750}
#igLightbox .iglb-close:focus-visible{outline:3px solid rgba(147,180,245,.6);outline-offset:2px}
#igLightbox .iglb-fld{font-size:.68rem;font-weight:800;color:#93B4F5;letter-spacing:.03em}
#igLightbox .iglb-tip{font-size:.62rem;color:#7E8BA0}
/* ── 최종 런타임 편집기: 고밀도 행형 구조 ── */
#recruitModal .rf-box{translate:19px 0;height:calc(100vh - 78px)!important;min-height:630px;max-height:940px!important;border-radius:16px;box-shadow:0 18px 48px rgba(15,23,42,.18),0 3px 12px rgba(15,23,42,.08)}
#recruitModal .modal-header{padding:13px 16px;background:#F8FAFD}
#recruitModal .modal-header h3{font-size:.92rem;letter-spacing:-.025em}
#recruitModal .rf-rail{width:197px;padding:14px 10px;background:#FBFCFE;overflow:hidden}
#recruitModal .rf-rail-t{padding:2px 8px 12px;color:#172033;font-size:.82rem;letter-spacing:-.025em}
#recruitModal .rf-rail-t span{display:block;margin-top:4px;color:#7F8A9B;font-size:.62rem;font-weight:600;letter-spacing:0}
#recruitModal .rf-step-list{display:grid;gap:2px}
#recruitModal .rf-step{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:7px;min-height:31px;width:100%;padding:5px 7px;border:1px solid transparent;border-radius:7px;background:transparent;color:#526078;font:inherit;font-size:.7rem;font-weight:800;text-align:left;cursor:pointer;transition:background-color .16s ease-out,border-color .16s ease-out,color .16s ease-out}
#recruitModal .rf-step:hover{background:#F1F5FA;color:#263449}
#recruitModal .rf-step.on{border-color:#C9D9F5;background:#EDF4FF;color:#2563C8}
#recruitModal .rf-step-no{display:grid;place-items:center;width:18px;height:18px;border:1px solid currentColor;border-radius:50%;font-size:.6rem;font-style:normal}
#recruitModal .rf-step .rf-rmk{margin-left:auto}
#recruitModal .rf-side-audit{margin-top:auto;padding:10px 8px 0;border-top:1px solid #DCE3EC;color:#526078;font-size:.64rem;line-height:1.45}
#recruitModal .rf-side-audit-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:.7rem;font-weight:850;color:#243148}
#recruitModal .rf-side-audit-head strong{color:#2563C8;font-size:.9rem}
#recruitModal .rf-side-audit-head strong.warn{color:#B66A15}
#recruitModal .rf-side-audit #rf_part_check{display:grid;gap:4px}
#recruitModal .rf-side-audit #rf_part_check>*{font-size:.61rem;line-height:1.3}
#recruitModal .rf-side{width:309px;background:#FBFCFE}
#recruitModal .modal-body{gap:0!important;padding:0 16px 18px!important}
#recruitModal .rf-card{border:0;border-bottom:1px solid #DCE3EC;border-radius:0;overflow:visible;background:transparent}
#recruitModal .rf-card:last-child{border-bottom:0}
#recruitModal .rf-ch{padding:15px 0 7px;border:0;background:transparent}
#recruitModal .rf-ct{font-size:.84rem;letter-spacing:-.025em}
#recruitModal .rf-cn{display:none}
#recruitModal .rf-pinbadge{display:none}
#recruitModal .rf-cb{padding:0 0 14px;gap:0}
#recruitModal .rf-grid2{display:block;margin:0}
#recruitModal .rf-hrow{grid-template-columns:minmax(112px,25%) minmax(0,75%);gap:0;min-height:37px;margin:0;border:1px solid #DCE3EC;border-bottom:0;background:#FFFFFF}
#recruitModal .rf-hrow:first-child{border-radius:8px 8px 0 0}
#recruitModal .rf-hrow:last-child{border-bottom:1px solid #DCE3EC;border-radius:0 0 8px 8px}
#recruitModal .rf-hrow.rf-hrow-top{align-items:stretch;min-height:37px}
#recruitModal .rf-hrow.rf-hrow-top .rf-hl{padding-top:7px}
#recruitModal .rf-hrow .rf-hl{display:flex;align-items:center;padding:6px 10px;background:#FBFCFE;color:#46546B;font-size:.68rem;font-weight:800;text-align:left;line-height:1.3}
#recruitModal .rf-hrow>:not(.rf-hl){min-width:0;padding:4px 7px}
#recruitModal .rf-hrow>.rform-input{height:30px;margin:auto 7px;padding:4px 7px}
#recruitModal .rf-main .rform-input{min-height:26px;height:26px;padding:4px 7px;border-color:#D5DEE9;border-radius:5px;font-size:.72rem;line-height:1.25}
#recruitModal .rf-main textarea.rform-input{min-height:56px;padding:7px}
#recruitModal .rchan-btn,#recruitModal .rf-pm-btn,#recruitModal .rf-status-buttons button{min-height:26px;padding:4px 8px;border:1px solid #D5DEE9;border-radius:5px;background:#FFFFFF;color:#5D6B80;font:inherit;font-size:.67rem;font-weight:800;line-height:1;cursor:pointer;transition:background-color .16s cubic-bezier(.16,1,.3,1),border-color .16s cubic-bezier(.16,1,.3,1),color .16s cubic-bezier(.16,1,.3,1),transform .16s cubic-bezier(.16,1,.3,1)}
#recruitModal .rchan-btn:hover,#recruitModal .rf-pm-btn:hover,#recruitModal .rf-status-buttons button:hover{border-color:#AAC5F5;transform:translateY(-1px)}
#recruitModal .rchan-btn.active,#recruitModal .rf-pm-btn.on,#recruitModal .rf-status-buttons button.on{border-color:#B9D2FB;background:#EDF4FF;color:#2563C8;box-shadow:none}
#recruitModal .rf-time-free{height:26px;flex-basis:92px;width:92px;font-size:.65rem}
#recruitModal .rf-time-range{min-width:0;height:26px}
#recruitModal .rf-time-field{height:26px;font-size:.7rem}
#recruitModal .rf-prod-head{margin:0;border:1px solid #DCE3EC;border-bottom:0;border-radius:8px 8px 0 0;padding:5px 8px;background:#FBFCFE}
#recruitModal .rf-opt-row{margin:0;padding:4px 7px;border:1px solid #DCE3EC;border-bottom:0;background:#FFFFFF}
#recruitModal #rf_opt_rows .rf-opt-row:last-child{border-bottom:1px solid #DCE3EC;border-radius:0 0 8px 8px}
#recruitModal .rf-opt-row .rform-input{height:27px;min-height:27px;padding:4px 6px;font-size:.68rem}
#recruitModal .rf-pmsw{margin:0 0 6px}
#recruitModal .rf-pm-note{margin-left:7px;font-size:.62rem}
#recruitModal .rf-gp{margin:0;border:1px solid #DCE3EC;border-radius:8px;background:#FCFDFF;box-shadow:none}
#recruitModal .rf-gp-head{padding:5px 7px;margin:0;border-bottom:1px solid #DCE3EC}
#recruitModal .rf-card[data-sec="prod"]{border-bottom:0}
#recruitModal .rf-product-settings{margin-top:0;border-top:0;border-bottom:1px solid #DCE3EC}
#recruitModal .rf-product-settings-head{display:none}
#recruitModal .rf-product-settings .rf-cb{padding:0}
#recruitModal .rf-product-settings .rf-hrow{border-radius:0}
#recruitModal .rf-product-settings .rf-hrow:first-of-type{border-radius:8px 8px 0 0}
#recruitModal .rf-product-settings .rf-hrow:last-child{border-radius:0 0 8px 8px}
#recruitModal .rf-fee-box{margin:0;border:1px solid #DCE3EC;border-radius:0;background:#FFFFFF}
#recruitModal .rf-card[data-sec="fee"] .rf-ch{display:none}
#recruitModal .rf-card[data-sec="fee"] .rf-cb{padding:0 0 14px}
#recruitModal .rf-fee-sw{min-height:31px;font-size:.68rem}
#recruitModal .rf-publish-card{border-bottom:1px solid #DCE3EC}
#recruitModal .rf-publish-card .rf-ch{display:none}
#recruitModal .rf-publish-card .rf-cb{padding:12px 0 14px}
#recruitModal .rf-title-row{border:0;background:transparent;min-height:31px}
#recruitModal .rf-title-row .rf-hl{background:transparent;padding-left:0}
#recruitModal .rf-title-control{display:flex;align-items:center;gap:6px;padding:0!important}
#recruitModal .rf-title-control .rform-input{flex:1;min-width:0;height:28px}
#recruitModal .rf-status-buttons{display:flex;gap:4px;flex:none}
#recruitModal .rf-status-buttons button{white-space:nowrap}
#recruitModal .rf-publish-check-note{display:none}
#recruitModal .ig-wrap{gap:6px}
#recruitModal .ig-wrap>textarea.rform-input,#recruitModal .ig-strip{height:72px;min-height:72px}
#recruitModal .ig-strip{width:244px;border-color:#C9D6E8;border-style:dashed;border-radius:6px}
#recruitModal .ig-add,.rf-ig-empty{border-radius:5px}
#recruitModal .rf-side #rf_preview_section{margin:0 10px!important}
#recruitModal .rf-side #rf_preview_listcard{max-width:284px!important;margin:0 0 16px!important}
#recruitModal .rf-side #rf_preview_card{font-size:.7rem}
#recruitModal .rf-linked-reference{display:flex;align-items:center;min-height:30px;width:100%;padding:0 8px;border:1px solid #D5DEE9;border-radius:5px;background:#F7F9FC;color:#536178;font-size:.72rem;font-weight:750}
#recruitModal .rf-linked-reference:before{content:'연결됨';margin-right:6px;color:#2563C8;font-size:.64rem;font-weight:850}
#recruitModal .rf-help{margin-top:3px;color:#7F8A9B;font-size:.65rem;font-weight:600;line-height:1.4}
#recruitModal .rf-inline-buttons{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
#recruitModal .rf-checkline{display:flex;align-items:center;gap:7px;min-height:29px;color:#536178;font-size:.7rem;font-weight:800;cursor:pointer}
#recruitModal .rf-checkline span{color:#94A3B8;font-size:.64rem;font-weight:600}
#recruitModal .rf-inline-inputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px}
#recruitModal .rf-inline-inputs label{display:grid;gap:3px;color:#64748B;font-size:.64rem;font-weight:700}
#recruitModal .rf-advanced{padding:7px 9px;border:1px solid #DCE3EC;border-top:0;background:#FBFCFE;color:#64748B;font-size:.68rem;font-weight:750}
#recruitModal .rf-hidden-row{margin-top:6px;padding:7px 9px;border:1px dashed #C9D6E8;border-radius:6px;color:#64748B;font-size:.65rem;line-height:1.4}
#recruitModal .rf-hidden-row label{font-size:.7rem;font-weight:800;cursor:pointer}
#recruitModal .rf-hidden-row label span{color:#94A3B8;font-size:.63rem}
#recruitModal>.modal-box>.modal-footer{display:flex}
/* 승인 시안의 중앙 편집기 수치를 그대로 사용한다. */
#recruitModal .rf-compact-main{display:flex;min-width:0;min-height:0;flex:1;overflow:hidden}
#recruitModal .rf-compact-main .editor{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}
#recruitModal .rf-compact-main .editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px 14px;border-bottom:1px solid #DCE3EC}
#recruitModal .rf-compact-main .editor-head h2{margin:0;font-size:19px;letter-spacing:-.04em}
#recruitModal .rf-compact-main .editor-head p{margin:3px 0 0;color:#7F8A9B;font-size:11px}
#recruitModal .autosaved{padding:4px 6px;border-radius:5px;background:#EDF8F5;color:#15803D;font-size:10px;font-weight:850;white-space:nowrap}
#recruitModal .title-control-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:7px 22px;border-bottom:1px solid #DCE3EC;background:#FBFCFE}
#recruitModal .title-control-label{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;min-width:0;color:#45536A;font-size:11px;font-weight:850}
#recruitModal .title-control-label input{min-width:0;width:100%;height:26px;padding:0 9px;border:1px solid #D5DDE8;border-radius:6px;background:#fff;color:#172033;font-size:12px;font-weight:750}
#recruitModal .rf-compact-main #editorScroller{flex:1;min-height:0;overflow-y:auto;padding:0 22px 20px;background:#fff}
#recruitModal .rf-compact-main .section{padding:17px 0 20px;border-bottom:1px solid #DCE3EC;background:transparent}
#recruitModal .rf-compact-main .section:last-of-type{border-bottom:0}
#recruitModal .rf-compact-main .section-heading{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}
#recruitModal .rf-compact-main .section-heading h3{margin:0;color:#172033;font-size:14px;letter-spacing:-.025em}
#recruitModal .section-hint{color:#7F8A9B;font-size:10px}.section-count{color:#2563C8;font-size:10px;font-weight:850}
#recruitModal .rf-compact-main .row-form{border:1px solid #DCE3EC;border-radius:8px;overflow:hidden;background:#fff}
#recruitModal .rf-compact-main .form-row{display:grid;grid-template-columns:minmax(112px,25%) minmax(0,75%);min-height:37px;border:0;border-top:1px solid #DCE3EC;border-radius:0;background:#fff}
#recruitModal .rf-compact-main .form-row:first-child{border-top:0}
#recruitModal .rf-compact-main .form-label{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#FBFCFE;color:#45536A;font-size:11px;font-weight:850}
#recruitModal .rf-compact-main .form-label small{color:#94A3B8;font-weight:650}.required{color:#E15241;font-style:normal}
#recruitModal .rf-compact-main .form-control{display:flex;align-items:center;min-width:0;padding:4px 8px;gap:6px}
#recruitModal .rf-compact-main .form-control>input:not([type=checkbox]),#recruitModal .rf-compact-main .form-control>textarea{min-width:0;width:100%;height:26px;padding:0 8px;border:1px solid #D5DDE8;border-radius:6px;background:#fff;color:#172033;font-size:11px}
#recruitModal .rf-compact-main .form-control>textarea{height:58px;padding:7px 8px;line-height:1.4;resize:vertical}
#recruitModal .rf-compact-main .form-row.tall{min-height:70px}.rf-compact-main .form-row.tall .form-label{align-items:flex-start;padding-top:12px}.rf-compact-main .form-row.tall .form-control{align-items:stretch}
#recruitModal .rf-compact-main .choice-set,#recruitModal .rf-compact-main .square-toggle{display:flex;flex-wrap:wrap;gap:4px}
#recruitModal .rf-compact-main .choice,#recruitModal .rf-compact-main .square-toggle button{min-height:26px;padding:4px 8px;border:1px solid #D6DEE9;border-radius:5px;background:#fff;color:#617087;font-size:10px;font-weight:850;line-height:1;transition:transform .18s cubic-bezier(.16,1,.3,1),border-color .18s cubic-bezier(.16,1,.3,1),background-color .18s cubic-bezier(.16,1,.3,1),box-shadow .18s cubic-bezier(.16,1,.3,1)}
#recruitModal .rf-compact-main .choice.active,#recruitModal .rf-compact-main .choice.selected,#recruitModal .rf-compact-main .square-toggle button.on,#recruitModal .rf-compact-main .square-toggle button.active{border-color:#2769DF;background:#2769DF;color:#fff;box-shadow:none}
#recruitModal .rf-compact-main .linked-reference{display:flex;align-items:center;min-height:26px;width:100%;padding:0 8px;border:1px solid #D5DDE8;border-radius:6px;background:#F7F9FC;color:#536178;font-size:10px;font-weight:750}.rf-compact-main .linked-reference:before{margin-right:6px;color:#2563EB;content:'연결됨'}
#recruitModal .rf-compact-main .tag{padding:3px 5px;border-radius:4px;background:#EFF3F8;color:#59677D;font-size:9px;font-weight:850;white-space:nowrap}.rf-compact-main .tag.public{background:#EDF4FF;color:#2563C8}
#recruitModal .rf-compact-main .switch-button{position:relative;flex:0 0 32px;width:32px;height:19px;padding:0;border:0;border-radius:99px;background:#CBD5E1;cursor:pointer;transition:background-color .18s cubic-bezier(.16,1,.3,1)}#recruitModal .rf-compact-main .switch-button>span{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.22);transition:transform .18s cubic-bezier(.16,1,.3,1)}#recruitModal .rf-compact-main .switch-button.on{background:#2769DF}#recruitModal .rf-compact-main .switch-button.on>span{transform:translateX(13px)}#recruitModal .rf-compact-main .form-control>strong{color:#617087;font-size:10px;font-weight:850}
#recruitModal .rf-compact-main .time-range{display:grid;grid-template-columns:1fr auto 1fr;width:100%;gap:0;position:relative}.rf-compact-main .time-field{min-width:0;width:100%;height:26px;padding:0 8px;border:1px solid #D5DDE8;background:#fff;color:#172033;font-size:11px;text-align:left}.rf-compact-main .time-field:first-child{border-radius:6px 0 0 6px}.rf-compact-main .time-field:last-of-type{border-left:0;border-radius:0 6px 6px 0}.rf-compact-main .time-range-separator{display:grid;place-items:center;min-width:18px;border-top:1px solid #D5DDE8;border-bottom:1px solid #D5DDE8;background:#fff;color:#94A3B8;font-size:11px}
#recruitModal .rf-compact-main .product-editor{margin-top:8px;border:1px solid #DCE3EC;border-radius:8px;overflow:hidden;background:#FBFCFE}.rf-compact-main .product-head{display:grid;grid-template-columns:minmax(0,2.25fr) minmax(92px,.88fr) minmax(44px,.45fr) minmax(40px,.4fr) 58px;gap:5px;align-items:center;padding:7px 9px;border-bottom:1px solid #DCE3EC;color:#94A3B8;font-size:9px;font-weight:850}.rf-compact-main .product-head span:nth-child(n+2){text-align:right}
#recruitModal .rf-compact-main .rf-opt-row{margin:0;padding:5px 8px;border:0;border-bottom:1px solid #E9EEF5;background:#fff}.rf-compact-main .rf-opt-row .rform-input{height:26px;min-height:26px;font-size:10px}.rf-compact-main .rf-pmsw{margin:0}.rf-compact-main .rf-prod-head[data-pm=opt]{grid-template-columns:minmax(0,1.05fr) minmax(0,1.25fr) minmax(70px,.76fr) minmax(44px,.43fr) minmax(40px,.38fr) 58px}
#recruitModal .rf-compact-main .badge-field{display:grid;gap:6px;width:100%}.rf-compact-main .badge-presets{display:flex;flex-wrap:wrap;gap:4px}.rf-compact-main .badge-presets button{min-height:24px;padding:3px 7px;border:1px solid #D8E0EB;border-radius:5px;background:#F8FAFC;color:#53637A;font-size:9px;font-weight:800;cursor:pointer;transition:background-color .16s cubic-bezier(.16,1,.3,1),border-color .16s cubic-bezier(.16,1,.3,1),color .16s cubic-bezier(.16,1,.3,1)}.rf-compact-main .badge-presets button:hover{border-color:#9EC0F8;background:#EDF4FF;color:#2563C8}.rf-compact-main .badge-presets button:focus-visible{outline:2px solid #93C5FD;outline-offset:1px}.rf-compact-main .badge-wrap{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-height:32px;width:100%;padding:4px 6px;border:1px solid #C9D6E8;border-radius:6px;background:#fff;transition:border-color .16s cubic-bezier(.16,1,.3,1),box-shadow .16s cubic-bezier(.16,1,.3,1)}.rf-compact-main .badge-wrap:focus-within{border-color:#7BAAF5;box-shadow:0 0 0 2px rgba(59,130,246,.12)}.rf-compact-main .badge-wrap input{flex:1;min-width:90px;height:20px;border:0!important;padding:0 3px!important;background:transparent!important}
#recruitModal .rf-compact-main .product-link-button{display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;border:1px solid #D5DDE8;border-radius:6px;background:#fff;color:#2563EB}.rf-compact-main .thumb-url-control input[type=file]{display:none}.rf-compact-main .thumb-guide-row .form-control{color:#7F8A9B;font-size:11px}
#recruitModal .rf-compact-main .rf-thumb-preview-wrap{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:2px 4px;border:1px solid #D5DDE8;border-radius:6px;background:#F8FAFC;color:#64748B;font-size:9px;font-weight:800;white-space:nowrap}.rf-compact-main .rf-thumb-preview-wrap img{width:30px;height:30px;object-fit:cover;border-radius:4px;background:#fff}.rf-compact-main .rf-thumb-preview-wrap.is-error{border-color:#FCA5A5;background:#FEF2F2;color:#B91C1C}
#recruitModal .rf-compact-main .rf-review-type-row .form-control{display:block}.rf-compact-main .review-type-buttons{width:100%}#recruitModal .rf-compact-main .mixed-review-composer{margin-top:7px;padding:7px;border:1px solid #DCE3EC;border-radius:6px;background:#F8FAFC}#recruitModal .rf-compact-main .mixed-review-card+.mixed-review-card{margin-top:7px;padding-top:7px;border-top:1px solid #E3E9F2}#recruitModal .rf-compact-main .mixed-review-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;color:#617087;font-size:10px}#recruitModal .rf-compact-main .mixed-review-heading strong{color:#172033}.rf-compact-main .mixed-review-total{color:#64748B;font-weight:800}.rf-compact-main .mixed-review-total.is-invalid{color:#DC2626}#recruitModal .rf-compact-main .mixed-review-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}#recruitModal .rf-compact-main .mixed-review-grid label{display:grid;grid-template-columns:48px minmax(0,1fr);align-items:center;gap:4px;color:#617087;font-size:9px;font-weight:800}.rf-compact-main .mixed-review-type-label{white-space:nowrap;text-align:left}.rf-compact-main .mixed-review-grid input{width:100%;height:24px;min-width:0;padding:0 5px;border:1px solid #D5DDE8;border-radius:5px;text-align:right;color:#172033;font-size:10px}
#recruitModal .rf-compact-main .product-main-url{border-top:1px solid #DCE3EC;background:#FBFCFE}.rf-compact-main .product-main-url .form-label{background:#F5F7FA}.rf-compact-main .product-main-url .form-control{gap:6px}.rf-compact-main .product-main-url input{min-width:0;flex:1}.rf-compact-main .rbadge-chip.automatic{border-color:#B9D2FB!important;background:#EDF4FF!important;color:#2563C8!important}
#recruitModal .rf-compact-main .work-compose{display:grid;grid-template-columns:minmax(220px,1fr) 128px;gap:6px;align-items:stretch;width:100%}.rf-compact-main .work-compose textarea{width:100%;min-width:220px;height:58px!important}.rf-compact-main .work-image-strip{justify-self:end;width:128px!important;height:58px;min-width:0;min-height:58px;border:1px dashed #C9D6E8;border-radius:6px;background:#FBFCFE}.rf-compact-main .advanced{margin-top:8px;border:1px solid #DCE3EC;border-radius:8px;background:#FBFCFE}.rf-compact-main .advanced summary{padding:9px 11px;color:#58667D;font-size:10px;font-weight:850;cursor:pointer}
#recruitModal .rf-compact-main .ig-strip{height:58px!important;min-height:58px!important;padding:4px}
#recruitModal .rf-compact-main .footer{display:none}.rf-compact-main .footer-copy{min-width:0;flex:1;color:#7F8A9B;font-size:10px}.rf-compact-main .footer>div{display:flex;flex:0 0 auto;flex-wrap:nowrap;gap:6px;white-space:nowrap}.rf-compact-main .btn{min-height:29px;padding:6px 10px;border:1px solid #D5DDE8;border-radius:6px;background:#fff;color:#526078;font-size:10px;font-weight:850}.rf-compact-main .footer .rf-savebtn{min-height:29px;padding:6px 10px;border-color:#2563EB;background:#2563EB;color:#fff;font-size:10px}
#recruitModal #rf_linked_campaign,#recruitModal #rf_linked_tab,#recruitModal #rf_delivery_type{display:none}
#recruitModal .rf-delivery-toggle{display:flex;flex-wrap:wrap;gap:4px}
#recruitModal .rf-delivery-toggle button{min-height:26px;padding:4px 8px;border:1px solid #D5DEE9;border-radius:5px;background:#fff;color:#5D6B80;font:inherit;font-size:.67rem;font-weight:800;line-height:1;cursor:pointer;transition:background-color .16s cubic-bezier(.16,1,.3,1),border-color .16s cubic-bezier(.16,1,.3,1),color .16s cubic-bezier(.16,1,.3,1),transform .16s cubic-bezier(.16,1,.3,1)}
#recruitModal .rf-delivery-toggle button:hover{border-color:#AAC5F5;transform:translateY(-1px)}
#recruitModal .rf-delivery-toggle button.on{border-color:#B9D2FB;background:#EDF4FF;color:#2563C8}
#recruitModal .rf-parity-time-row .rf-time-control{display:flex;align-items:center;gap:6px;width:100%}
#recruitModal .rf-parity-time-row .rf-time-range{flex:1;width:auto}
#recruitModal .rf-parity-time-row .rform-label{display:none}
#recruitModal .rf-parity-date-control{display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px}
#recruitModal .rf-parity-date-control input{min-width:0;flex:1;border:0!important;background:transparent!important;cursor:pointer}
#recruitModal .rf-parity-date-control span{flex:none;color:#2563C8;font-size:.65rem;font-weight:850}
@media (max-width:1060px){#recruitModal .rf-side{display:none}#recruitModal .rf-rail{width:160px}}
@media (min-width:781px) and (max-width:900px){#recruitModal .rf-rail{display:flex}}
@media (max-width:780px){#recruitModal .rf-rail{display:none}#recruitModal .modal-body{padding:0 12px 16px!important}#recruitModal .rf-hrow{grid-template-columns:1fr;border-radius:0!important}#recruitModal .rf-hrow .rf-hl{border-bottom:1px solid #E7ECF3;padding:6px 7px}#recruitModal .rf-title-control{flex-wrap:wrap}#recruitModal .rf-status-buttons{width:100%}#recruitModal .rf-status-buttons button{flex:1}#recruitModal .ig-strip{width:100%}}
@media (prefers-reduced-motion:reduce){#recruitModal .rf-step,#recruitModal .rchan-btn,#recruitModal .rf-pm-btn,#recruitModal .rf-status-buttons button{transition:none}}
`;
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
  function _mBody() { return document.getElementById('editorScroller'); }
  function _mCard(k) { var b = _mBody(); return b ? b.querySelector('[data-sec="' + k + '"]') : null; }

  /** 최종안 레일은 정해진 발행 순서를 안내한다. 입력 중 목차를 드래그해 바꾸지 않는다. */
  function applyLayout() { renderRail(); }

  function renderRail() {
    var rail = document.getElementById('rfRailList'), b = _mBody();
    if (!rail || !b) return;
    Array.prototype.forEach.call(rail.querySelectorAll('[data-rf-step]'), function (item) {
      var card = _mCard(item.getAttribute('data-rf-step'));
      item.hidden = !card || card.style.display === 'none';
    });
    bindRail(rail);
    updateRailMarks();
  }

  function scrollRailToCard(card) {
    var body = _mBody();
    if (!body || !card) return;
    var top = card.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 10;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function bindRail(rail) {
    if (rail._rfFinalNav) return;
    rail._rfFinalNav = 1;
    Array.prototype.forEach.call(rail.querySelectorAll('[data-rf-step]'), function (it) {
      var key = it.getAttribute('data-rf-step');
      it.addEventListener('click', function () {
        var c = _mCard(key);
        if (c) { scrollRailToCard(c); setActiveRail(key); }
      });
    });
  }

  /* ── 레일 상태 표시(● 필수 미입력 · ⚠ 경고 · ✓ 입력됨) — 가벼운 판정만(진실은 저장 시 서버 게이트) ── */
  function _val(id) {
    var el = document.getElementById(id);
    return el && el.value ? String(el.value).trim() : '';
  }
  function _railMark(key) {
    switch (key) {
      case 'link':
        return (_val('rf_manager') && _val('rf_channel') && _val('rf_chat_url')) ? 'ok' : 'req';
      case 'prod': { var r = document.getElementById('rf_opt_rows'); return (r && r.children.length) ? 'ok' : ''; }
      case 'cond': return (_val('rf_start_date') || _val('rf_window_start')) ? 'ok' : '';
      case 'fee':  return _val('rf_review_fee') ? 'ok' : '';
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
    var check = document.getElementById('rf_part_check');
    var score = document.getElementById('rf_side_audit_score');
    if (score) {
      var body = (check && check.textContent) || '';
      var warnings = (body.match(/[⚠⛔]/g) || []).length;
      score.textContent = warnings ? ('!' + warnings) : '✓';
      score.className = warnings ? 'warn' : 'ok';
    }
  }
  function setActiveRail(key) {
    var rail = document.getElementById('rfRailList');
    if (!rail) return;
    Array.prototype.forEach.call(rail.querySelectorAll('[data-rf-step]'), function (it) {
      it.classList.toggle('on', it.getAttribute('data-rf-step') === key);
    });
  }

  /* 입력 변화 → 상태 표시 갱신(디바운스) + 본문 스크롤 → 현재 섹션 하이라이트(스크롤 스파이) */
  function bindLive() {
    var m = document.getElementById('recruitModal');
    if (!m || m._rfLive) return;
    m._rfLive = 1;

    // Workdesk mounts this shared modal dynamically.  Delegate the save action
    // from the mounted shell so it remains reliable even when inline handlers
    // are isolated by the host page's script scope.
    m.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('#recruitSaveBtn, #recruitSaveBtnInline')
        : null;
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (typeof window.saveRecruitPost === 'function') window.saveRecruitPost();
      else if (typeof window.recruitSaveBlock === 'function') {
        window.recruitSaveBlock('저장 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
      }
    }, true);
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
          Array.prototype.forEach.call(b.querySelectorAll('[data-sec]'), function (c) {
            if (c.style.display === 'none') return;
            if (c.offsetTop <= top) act = c.getAttribute('data-sec');
          });
          // 게시 영역은 최상단에 고정하지만 왼쪽 단계에는 넣지 않는다.
          // 최상단 스크롤에서는 첫 단계(연결 · 기본)를 선택 상태로 유지한다.
          if (act === 'pub' || act === 'fee') act = 'link';
          if (act === 'work') act = 'prod';
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

  /* ═══════════════════════════════════════════════════════════════
     저장 결과 안내 — 화면 가운데 카드 + 페이드아웃 (시안 C 확정)
     ───────────────────────────────────────────────────────────────
     ★★ 렌더러는 **여기 한 벌**이다(사본 금지) — 모달 마크업·CSS 가 이 모듈에
        있고 admin.html · workdesk.html 이 같은 모듈을 쓴다. 사본을 두면
        한쪽 화면에서만 안내가 안 뜬다(레포에서 이미 밟은 함정).
     ★★ 마운트는 **body 직속** + z-index 는 모달(5000)보다 위. 뷰 스크롤
        컨테이너 안에 넣으면 오버레이가 화면 흐름에 섞인다.
     ★  성공 안내만 자동으로 사라진다. 차단·실패는 rf-blockbar 로 모달 안에
        남긴다 — 사라지면 원인을 다시 읽을 방법이 없다.
     ═══════════════════════════════════════════════════════════════ */
  /* ★ box-sizing 을 스스로 정한다 — 이 오버레이는 body 직속이라 호스트 리셋(admin.html 은
     `*{box-sizing:border-box}`, 없는 화면도 있다)에 따라 카드 폭이 340px ↔ 392px 로 갈린다(실측). */
  var FB_CSS = `#campSaveFb,#campSaveFb *{box-sizing:border-box}
#campSaveFb{position:fixed;inset:0;z-index:6000;display:flex;align-items:center;justify-content:center;
  pointer-events:none;padding:20px}
#campSaveFb .csfb-box{background:#fff;border-radius:16px;border:1px solid #E6EAF0;padding:20px 26px;max-width:340px;line-height:1.5;
  display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;
  box-shadow:0 12px 40px rgba(16,24,40,.20),0 2px 8px rgba(16,24,40,.10);
  font-family:"Apple SD Gothic Neo","Pretendard","Noto Sans KR",system-ui,sans-serif;color:#101828;
  animation:csfbIn .22s cubic-bezier(.2,.85,.3,1)}
/* word-break:keep-all — 없으면 '공고'가 '공 / 고'로 갈린다(실측) */
#campSaveFb .csfb-msg{font-size:.88rem;font-weight:800;letter-spacing:-.01em;line-height:1.45;word-break:keep-all}
#campSaveFb .csfb-sub{font-size:.72rem;font-weight:600;color:#667085}
#campSaveFb .csfb-list{margin-top:2px;display:flex;flex-direction:column;gap:3px;width:100%}
#campSaveFb .csfb-li{display:flex;align-items:center;gap:6px;font-size:.72rem;font-weight:700;color:#334155;
  background:#F5F8FC;border:1px solid #E6EAF0;border-radius:7px;padding:4px 9px;text-align:left}
#campSaveFb .csfb-li i{width:5px;height:5px;border-radius:50%;background:#3182F6;flex:none}
#campSaveFb .csfb-more{font-size:.7rem;font-weight:700;color:#98A2B3}
#campSaveFb.out{animation:csfbOut .44s ease forwards}
#campSaveFb .csfb-ring{width:46px;height:46px;flex:none}
#campSaveFb .csfb-ring circle{fill:none;stroke:#16A34A;stroke-width:4;stroke-linecap:round}
#campSaveFb .csfb-ring .bg{stroke:#D9F2E2}
#campSaveFb .csfb-ring .fg{stroke-dasharray:151;stroke-dashoffset:151;transform:rotate(-90deg);transform-origin:50% 50%;
  animation:csfbRing .5s cubic-bezier(.3,.9,.3,1) forwards}
#campSaveFb .csfb-ring path{fill:none;stroke:#16A34A;stroke-width:4.5;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:34;stroke-dashoffset:34;animation:csfbTick .32s .24s ease forwards}
@keyframes csfbIn{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
@keyframes csfbOut{to{opacity:0;transform:translateY(-6px) scale(.985)}}
@keyframes csfbRing{to{stroke-dashoffset:0}}
@keyframes csfbTick{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){
  #campSaveFb .csfb-box{animation:none}
  #campSaveFb .csfb-ring .fg,#campSaveFb .csfb-ring path{animation:none;stroke-dashoffset:0}
  #campSaveFb.out{animation:csfbFade .44s ease forwards}
  @keyframes csfbFade{to{opacity:0}}
}`;

  var FB_HOLD_MS = 2200;   // 항목 표시(시안 C) 기준 — 목록을 읽을 시간
  var FB_OUT_MS  = 440;
  var _fbTimers  = [];

  function fbEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  /* 공고 제목은 매우 길 수 있다(실측 60자+) — 카드가 화면을 덮지 않게 줄인다 */
  function fbClip(s, n) {
    s = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function injectFbCss() {
    if (document.getElementById('camp-save-fb-css')) return;
    var st = document.createElement('style');
    st.id = 'camp-save-fb-css';
    st.textContent = FB_CSS;
    document.head.appendChild(st);
  }

  /**
   * 저장 성공 안내(모달이 닫힌 뒤 화면 가운데).
   * @param {{title?:string, changes?:string[], mode?:'edit'|'create'}} opts
   *   changes = 바뀐 항목 이름들. **비어 있으면 목록을 그리지 않는다** —
   *   비교하지 못한 필드가 있을 수 있어 "바뀐 내용 없음"이라고 단정하지 않는다.
   */
  function campSaveFeedback(opts) {
    opts = opts || {};
    injectFbCss();
    if (!document.body) return;

    _fbTimers.forEach(clearTimeout); _fbTimers = [];
    var old = document.getElementById('campSaveFb');
    if (old) old.remove();

    var isCreate = opts.mode === 'create';
    var title = fbClip(opts.title, 22);
    var msg = title
      ? '「' + fbEsc(title) + '」 공고' + (isCreate ? '가 발행되었습니다' : ' 수정이 반영되었습니다')
      : (isCreate ? '공고가 발행되었습니다' : '공고 수정이 반영되었습니다');

    var changes = (Array.isArray(opts.changes) ? opts.changes : []).filter(Boolean);
    var body = '';
    if (changes.length) {
      body = '<div class="csfb-list">';
      changes.slice(0, 3).forEach(function (c) {
        body += '<div class="csfb-li"><i></i>' + fbEsc(c) + '</div>';
      });
      body += '</div>';
      if (changes.length > 3) body += '<div class="csfb-more">외 ' + (changes.length - 3) + '건</div>';
    } else {
      body = '<div class="csfb-sub">목록에 바로 반영했어요</div>';
    }

    var box = document.createElement('div');
    box.id = 'campSaveFb';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.innerHTML =
      '<div class="csfb-box">' +
        '<svg class="csfb-ring" viewBox="0 0 56 56" aria-hidden="true">' +
          '<circle class="bg" cx="28" cy="28" r="24"></circle>' +
          '<circle class="fg" cx="28" cy="28" r="24"></circle>' +
          '<path d="M17.5 28.8 L24.6 35.6 L38.5 21.2"></path>' +
        '</svg>' +
        '<div class="csfb-msg">' + msg + '</div>' +
        body +
      '</div>';
    document.body.appendChild(box);

    _fbTimers.push(setTimeout(function () {
      box.classList.add('out');
      _fbTimers.push(setTimeout(function () { if (box.parentNode) box.remove(); }, FB_OUT_MS));
    }, FB_HOLD_MS));
  }

  /* 모달 안 차단·실패 줄. onGo 가 있으면 [점검 항목 보기 ↑] 버튼이 붙는다. */
  function recruitSaveBlock(text, onGo) {
    var foot = document.querySelector('#recruitModal .modal-footer');
    if (!foot) return;
    recruitSaveBlockClear();
    var bar = document.createElement('div');
    bar.className = 'rf-blockbar';
    bar.setAttribute('role', 'alert');
    bar.innerHTML = '<span aria-hidden="true">⚠</span><span>' + fbEsc(text) + '</span>' +
      (typeof onGo === 'function' ? '<button type="button" class="rf-bb-go">점검 항목 보기 ↑</button>' : '');
    foot.appendChild(bar);
    if (typeof onGo === 'function') {
      var go = bar.querySelector('.rf-bb-go');
      if (go) go.addEventListener('click', onGo);
    }
    // 흔들림 1회 — "눌렀는데 아무 일도 없다"를 없애는 즉각 신호
    foot.classList.remove('rf-shake');
    void foot.offsetWidth;
    foot.classList.add('rf-shake');
    setTimeout(function () { foot.classList.remove('rf-shake'); }, 420);
  }
  function recruitSaveBlockClear() {
    var old = document.querySelector('#recruitModal .rf-blockbar');
    if (old) old.remove();
  }

  window.campSaveFeedback      = campSaveFeedback;
  window.recruitSaveBlock      = recruitSaveBlock;
  window.recruitSaveBlockClear = recruitSaveBlockClear;

  function refreshLinkedReferences() {
    ['rf_linked_campaign', 'rf_linked_tab'].forEach(function (id) {
      var select = document.getElementById(id);
      var reference = document.getElementById(id + '_reference');
      if (!select || !reference) return;
      var option = select.options[select.selectedIndex];
      reference.textContent = option && option.value ? option.textContent : '작업오더에서 연결되면 자동 표시됩니다.';
    });
  }

  function bindStaticCompactControls() {
    var delivery = document.getElementById('rf_delivery_type');
    var group = document.getElementById('rf_delivery_toggle');
    if (delivery && group && !group.dataset.bound) {
      group.dataset.bound = '1';
      group.addEventListener('click', function (event) {
        var button = event.target.closest('[data-rf-delivery]');
        if (!button) return;
        delivery.value = button.getAttribute('data-rf-delivery');
        delivery.dispatchEvent(new Event('change', { bubbles: true }));
      });
      delivery.addEventListener('change', syncDeliveryButtons);
    }
    syncDeliveryButtons();
    refreshLinkedReferences();
  }

  function syncDeliveryButtons() {
    var delivery = document.getElementById('rf_delivery_type');
    var group = document.getElementById('rf_delivery_toggle');
    if (!delivery || !group) return;
    Array.prototype.forEach.call(group.querySelectorAll('[data-rf-delivery]'), function (button) {
      button.classList.toggle('on', button.getAttribute('data-rf-delivery') === delivery.value);
    });
  }

  function rfOpenStartDatePicker(event) {
    if (event && event.target && event.target.closest('input,button,label')) return;
    var startDate = document.getElementById('rf_start_date');
    if (!startDate) return;
    try { if (typeof startDate.showPicker === 'function') startDate.showPicker(); } catch (_) {}
    startDate.focus();
  }

  function syncStatusButtons() {
    var select = document.getElementById('rf_status');
    if (!select) return;
    Array.prototype.forEach.call(document.querySelectorAll('#rf_status_buttons [data-rf-status]'), function (button) {
      button.classList.toggle('on', button.getAttribute('data-rf-status') === select.value);
    });
  }

  function setStatus(value) {
    var select = document.getElementById('rf_status');
    if (!select) return;
    select.value = value;
    syncStatusButtons();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function normalizeShellLayout() {
    var modal = document.getElementById('recruitModal');
    var box = modal && modal.querySelector('.modal-box.rf-box');
    var split = box && box.querySelector('.rf-split');
    var main = split && split.querySelector('.rf-main.rf-compact-main');
    var editor = main && main.querySelector('.editor');
    if (!modal || !box || !split || !editor) return;

    var side = modal.querySelector('.rf-side');
    if (side && side.parentElement !== split) split.appendChild(side);

    var compactFooter = split.querySelector('footer.modal-footer');
    if (compactFooter && compactFooter.parentElement !== editor) editor.appendChild(compactFooter);

    var legacyFooter = null;
    Array.prototype.forEach.call(modal.children, function (child) {
      if (!legacyFooter && child.classList && child.classList.contains('modal-footer')) legacyFooter = child;
    });
    if (legacyFooter && legacyFooter.parentElement !== box) box.appendChild(legacyFooter);
  }

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
    normalizeShellLayout();
    injectIconFallback();
    bindStaticCompactControls();
    applyLayout();
    syncStatusButtons();
    bindLive();
    return true;
  }

  window.RecruitModal = {
    mount: mount,
    html: HTML,
    refreshRail: renderRail,
    marks: updateRailMarks,
    applyLayout: applyLayout,
    refreshStaticControls: bindStaticCompactControls,
    refreshLinkedReferences: refreshLinkedReferences,
    syncStatusButtons: syncStatusButtons,
    setStatus: setStatus,
  };
  // 스크립트가 마운트 지점 뒤에 로드되면 즉시, 아니면 DOM 준비 후
  if (!mount()) document.addEventListener('DOMContentLoaded', function () { mount(); });
})();
