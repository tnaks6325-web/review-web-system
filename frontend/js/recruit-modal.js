/* ══════════════════════════════════════════════════════════════
   모집공고 발행·수정 모달 (공유 마크업)

   원래 admin.html 에 인라인으로 있던 #recruitModal(65개 rf_* 필드)을 **모듈로 뺐다**.
   통합 작업대에서도 같은 모달로 발행·수정하려면 마크업이 한 벌이어야 한다 —
   사본을 만들면 필드가 하나만 늘어도 두 화면이 어긋나고, 저장 로직(index-recruit.js)이
   한쪽에서만 동작한다(레포가 반복해서 경고하는 그 드리프트).

   ★ 필드 ID는 한 글자도 바꾸지 않았다 — index-recruit.js 의 프리필·저장 로직과
     회귀가드(recruitModalLayout.test.js)가 ID로 묶여 있다.
   ★ 마운트는 멱등 — 이미 있으면 아무 것도 하지 않는다(두 번 부르는 화면 대비).

   사용: <div id="recruitModalMount"></div> 를 두고 이 스크립트를 로드하면 자동 마운트.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var HTML = `<div id="recruitModal" class="modal-overlay hidden" style="display:none">
  <div class="modal-box rf-box" style="max-width:1120px;width:97%;max-height:94vh;display:flex;flex-direction:column;overflow:hidden">
    <div class="modal-header">
      <h3 id="recruitModalTitle"><i class="fas fa-bullhorn"></i> 모집공고 등록</h3>
      <button class="btn-icon-sm" onclick="closeRecruitModal()"><i class="fas fa-times"></i></button>
    </div>
    <!-- 좌: 입력(탭) / 우: 미리보기(고정). 미리보기를 아래로 쌓으면 입력란이 화면 밖으로 밀려
         "고치면서 확인"이 안 된다 — 그래서 옆으로 뺐다. 좁은 화면은 CSS가 세로로 되돌린다. -->
    <div class="rf-split">
      <div class="rf-main">
    <div class="modal-body" style="padding:16px 18px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;flex:1;min-height:0">
        <section class="rf-sec" data-pane="basic"><h4 class="rf-sech">📝 기본정보</h4>

      <!-- 시트명 / 탭명 — 연결이 없으면 공고가 동작하지 않으므로 맨 위 -->
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
      <div id="rf_linked_tab_info" style="display:none;font-size:.72rem;color:var(--ok,#12b886);font-weight:600;margin:-4px 0 4px 76px">
        <i class="fas fa-link"></i> <span id="rf_linked_tab_text"></span>
      </div>

      <!-- 담당자 / 구매채널 -->
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
              <button class="rchan-btn" data-group="channel" data-val="직접입력" onclick="selectRfBtn('channel',this)">✏️ 직접</button>
            </div>
            <input id="rf_channel_custom" type="text" class="rform-input" placeholder="채널명 직접 입력" style="margin-top:6px;display:none" maxlength="30">
            <input id="rf_channel" type="hidden">
          </div></div>
      </div>

      <!-- 배송유형 / 리뷰비 -->
      <div class="rf-grid2">
        <div class="rf-hrow"><span class="rf-hl">배송유형</span>
          <select id="rf_delivery_type" class="rform-input">
            <option value="">선택 안 함</option>
            <option value="빈택배">빈택배</option>
            <option value="실배송">실배송</option>
            <option value="회수건">회수건</option>
          </select></div>
        <div class="rf-hrow"><span class="rf-hl">리뷰비 (원)</span>
          <input id="rf_review_fee" type="number" class="rform-input" placeholder="예) 2500" min="0" step="100"></div>
      </div>

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

      <!-- 상품 URL / 썸네일 — 값이 길어 세로 유지 -->
      <div class="rf-grid2">
        <div class="rform-group" style="margin:0">
          <label class="rform-label">상품 URL <span style="font-weight:400;color:var(--t3,#94A3B8);font-size:.66rem">— 가져오기: 네이버·올리브영 (쿠팡 제한적)</span></label>
          <div style="display:flex;gap:5px">
            <input id="rf_product_url" type="url" class="rform-input" placeholder="상품확인용 URL" style="flex:1;min-width:0">
            <button type="button" class="rchan-btn" onclick="fetchProductInfo()" style="white-space:nowrap"><i class="fas fa-cloud-download-alt"></i> 가져오기</button>
            <button type="button" class="rchan-btn" onclick="openRecruitProductUrl()" style="white-space:nowrap" title="상품 페이지를 새 탭에서 엽니다">↗</button>
          </div>
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
        </div>
        <div class="rform-group" style="margin:0">
          <label class="rform-label">상품 썸네일 URL <span style="font-weight:400;color:var(--t3,#94A3B8);font-size:.66rem">— 붙여넣기 또는 파일 업로드</span></label>
          <div style="display:flex;gap:5px">
            <input id="rf_thumb_url" type="url" class="rform-input" style="flex:1;min-width:0;font-size:.72rem" placeholder="쿠팡 이미지 주소 붙여넣기">
            <button type="button" class="rchan-btn" onclick="fetchCampThumbFromUrl()" style="white-space:nowrap"><i class="fas fa-image"></i> 가져오기</button>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input id="rf_thumb_file" type="file" accept="image/*" style="font-size:.7rem;flex:1;min-width:0" onchange="uploadCampThumb(this)">
            <img id="rf_thumb_preview" alt="썸네일 미리보기" style="height:38px;border-radius:7px;border:1px solid var(--border,#E2E8F0);display:none">
          </div>
        </div>
      </div>

      <!-- 팀채팅방 URL -->
      <div class="rf-hrow rf-hrow-w"><span class="rf-hl">팀채팅방 <span class="rform-req">*</span></span>
        <input id="rf_chat_url" type="url" class="rform-input" placeholder="https://open.kakao.com/..."></div>

      <!-- ── 진행상품 · 작업내용 — 참여형 공고에서만(스위치는 모집정보에, onParticipationToggle이 함께 토글) ── -->
      <div id="rf_work_section" style="display:none">
        <div id="rf_opt_wrap" style="margin-top:4px;padding-top:8px;border-top:1px dashed var(--border,#E2E8F0)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
            <div style="font-size:.76rem;font-weight:800">📦 진행상품 · 옵션 · 결제금액 · 진행건수
              <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.68rem">— 작업오더에서 자동 적용 · 옵션마다 한 줄</span></div>
            <button type="button" class="rchan-btn" onclick="addOptRow()" style="font-size:.72rem;white-space:nowrap"><i class="fas fa-plus"></i> 옵션 추가</button>
          </div>
          <div class="rf-prod-head">
            <span>상품명</span><span>옵션명</span><span style="text-align:right">결제금액</span>
            <span style="text-align:right">총인원</span><span style="text-align:right">일건수</span><span></span>
          </div>
          <div id="rf_opt_rows"></div>
          <div id="rf_opt_summary" style="font-size:.68rem;color:var(--t3,#94A3B8);margin-top:4px"></div>
          <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:2px">옵션이 하나뿐이면 옵션명을 비워도 됩니다 · 총인원/일건수 0 = 제한 없음 · 상품명은 첫 줄에서 따라옵니다</div>
          <!-- 표에서 자동 생성되는 저장용 값(작업내용 원문·캠페인 정원) — 화면엔 표만 보인다 -->
          <textarea id="rf_wd_product" style="display:none"></textarea>
          <input id="rf_daily_limit" type="hidden" value="">
          <input id="rf_recruit_total" type="hidden" value="">
        </div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--border,#E2E8F0)">
          <label class="rform-label">유입가이드 <span style="font-weight:400;color:var(--t3,#94A3B8);font-size:.68rem">— 있으면 리뷰어 화면에 [상품 페이지 열기]가 뜨지 않습니다(가이드유입)</span></label>
          <textarea id="rf_wd_inflow" class="rform-input" rows="3" placeholder="키워드 검색 or 링크 진입 방법 안내"></textarea>
          <label class="rform-label" style="margin-top:6px">리뷰가이드</label>
          <textarea id="rf_wd_review" class="rform-input" rows="2" placeholder="별점/포토 비율 등"></textarea>
          <label class="rform-label" style="margin-top:6px">특이사항 <span style="font-weight:400;color:var(--t3,#94A3B8);font-size:.68rem">— 참여한 리뷰어에게만 공개</span></label>
          <textarea id="rf_wd_notes" class="rform-input" rows="2" placeholder="선택"></textarea>
        </div>
      </div>

        </section>
        <section class="rf-sec" data-pane="part"><h4 class="rf-sech">📣 모집정보</h4>

      <!-- 공고 제목 -->
      <div class="rform-group">
        <label class="rform-label">공고 제목 <span class="rform-req">*</span></label>
        <input id="rf_title" type="text" class="rform-input" placeholder="예) 쿠팡 립밤 리뷰 모집" maxlength="100">
      </div>

      <!-- ⚡ 참여형 스위치 -->
      <div class="rform-group" style="border:1.5px solid #12b886;border-radius:12px;padding:12px;background:#f6fffb">
        <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:800;font-size:.86rem">
          <input type="checkbox" id="rf_participation" onchange="onParticipationToggle(this.checked)" style="width:17px;height:17px;accent-color:#12b886">
          ⚡ 참여형 캠페인 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.72rem">— 리뷰어가 직접 참여 → 작업내용 확인 → 화면 안에서 구매양식 제출</span>
        </label>
        <div style="font-size:.7rem;color:var(--t3,#94A3B8);margin-top:3px">끄면 기존 공고와 100% 동일하게 동작합니다.</div>
        <div id="rf_part_section" style="display:none;margin-top:10px">
          <!-- 시작일·종료일은 왼쪽에 붙이고, 구매시간대를 같은 행 오른쪽에 -->
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
          <!-- 타계정 허용 / 현금영수증(탭 설정 읽기 전용) -->
          <div class="rf-grid2" style="margin-top:8px;align-items:start">
            <div style="border:1.5px solid #7C3AED;border-radius:10px;padding:10px;background:#F8F5FF">
              <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:800;font-size:.8rem">
                <input type="checkbox" id="rf_multi_account" onchange="onMultiAccountToggle(this.checked)" style="width:16px;height:16px;accent-color:#7C3AED">
                👥 타계정 허용 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.68rem">— 명의당 1건</span>
              </label>
              <div id="rf_multi_section" style="display:none;margin-top:8px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div><label class="rform-label">하루 한도 <span style="font-weight:400;color:#9CA3AF">(0=무제한)</span></label>
                    <input id="rf_multi_daily" type="number" min="0" class="rform-input" placeholder="예: 1" value="1" oninput="renderPartCheck()"></div>
                  <div><label class="rform-label">제한시간(분)</label>
                    <input id="rf_sub_ttl" type="number" min="1" class="rform-input" value="10"></div>
                </div>
                <div style="font-size:.64rem;color:var(--t3,#94A3B8);margin-top:4px">타계정 5개 보유 리뷰어는 하루 한도 1이면 5일에 걸쳐 참여합니다.</div>
              </div>
            </div>
            <div style="border:1.5px solid #F0B45E;border-radius:10px;padding:10px;background:#FFFBF2">
              <div style="font-weight:800;font-size:.8rem;color:#B45309">🧾 현금영수증 <span style="font-weight:600;color:var(--t3,#94A3B8);font-size:.66rem">— 탭 설정 · 읽기 전용</span></div>
              <div id="rf_cashrcpt_ro" style="font-size:.74rem;margin-top:6px;color:var(--t3,#94A3B8)">탭을 연결하면 진행방식에서 판정합니다</div>
              <div style="font-size:.64rem;color:var(--t4,#94A3B8);margin-top:4px">발행 여부는 대시보드 탭설정(진행방식)에서 바꿉니다</div>
            </div>
          </div>
          <details style="margin-top:8px"><summary style="font-size:.74rem;font-weight:700;color:var(--t3,#94A3B8);cursor:pointer">고급 설정 (참여 제한시간·마감 버퍼)</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
              <div><label class="rform-label">참여 제한시간(분)</label><input id="rf_hold_ttl" type="number" min="5" class="rform-input" value="15"></div>
              <div><label class="rform-label">종료 전 신규참여 마감(분)</label><input id="rf_close_buffer" type="number" min="0" class="rform-input" value="10"></div>
            </div>
          </details>
          <div style="margin-top:10px">
            <div style="font-size:.76rem;font-weight:800;margin-bottom:6px">🧮 게시 전 자동 점검</div>
            <div id="rf_part_check" style="display:flex;flex-direction:column;gap:5px"></div>
          </div>
        </div>
      </div>

      <!-- 유의사항(공고 카드 노출) / 상태 · 모집인원 -->
      <div class="rform-group">
        <label class="rform-label">유의사항 <span style="font-weight:400;color:var(--t3,#94A3B8);font-size:.68rem">— 공고 카드에 노출되는 안내문</span></label>
        <textarea id="rf_notes" class="rform-input" rows="2"
          placeholder="리뷰어에게 전달할 유의사항을 자유롭게 입력하세요" style="resize:vertical"></textarea>
      </div>
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

    </section>
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
  //   통합 작업대에서 모달이 스타일 없이 뜬다). 1회만 주입한다.
  // ★ 모달 '껍데기' CSS(.modal-overlay/.modal-box/.rform-* 등)는 원래 admin.html 이
  //   링크하는 css/index.css 에만 있었다 — 통합 작업대는 그 테마를 안 쓰므로 모달이
  //   오버레이가 아니라 **페이지 하단에 일반 블록으로 흘렀다**(실측).
  //   → 필요한 규칙만 `#recruitModal` 로 **스코프해서** 모듈에 동봉한다.
  //     · 스코프 = 호스트 페이지의 다른 모달·폼을 건드리지 않는다
  //     · CSS 변수는 폴백 값을 넣어 admin 테마 변수가 없는 화면에서도 제대로 보인다
  var SHELL_CSS = `#recruitModal.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:5000;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fadeIn .2s ease}
#recruitModal .modal-box{background:var(--card,#FFFFFF);border-radius:24px;width:100%;max-width:460px;max-height:calc(100vh - 40px);box-shadow:0 8px 48px rgba(15,23,42,.18),0 2px 12px rgba(15,23,42,.10);overflow:hidden;display:flex;flex-direction:column;animation:slideUp .22s ease}
#recruitModal .modal-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border,#E2E8F0);background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 100%)}
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

  /* 폰트어썸이 없는 호스트(통합 작업대)에서는 아이콘이 **빈 자리**로 뜬다 —
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

  /* ═══ 모집공고 수정 모달 — 좌(입력) / 우(미리보기 고정) ═══
     미리보기를 입력란 아래에 쌓으면 같은 스크롤을 나눠 써서 "고치면서 확인"이 안 된다 → 옆으로 뺐다.
     입력은 탭으로 나누지 않고 **한 화면에 촘촘히** 둔다(탭 전환으로 항목을 찾아다니지 않게).
     ★ 이 블록은 @media 밖 최상위에 있어야 한다 — 안에 넣으면 특정 폭에서만 적용된다(실측 버그).
     ★ 변수는 전부 폴백을 단다 — admin 테마(css/index.css)가 없는 화면(통합 작업대)에서
       var(--border) 가 무효값이 되면 테두리·색이 통째로 날아간다. */
  var CSS = `.rf-split{display:flex;flex:1;min-height:0;overflow:hidden}
.rf-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.rf-side{width:340px;flex-shrink:0;border-left:1px solid var(--border,#E2E8F0);background:#F7F9FC;
         display:flex;flex-direction:column;min-height:0}
/* 섹션 — 헤더가 스크롤 중에도 붙어 있어 지금 어느 묶음인지 보인다 */
.rf-sec{display:flex;flex-direction:column;gap:9px}
.rf-sech{position:sticky;top:0;z-index:3;margin:0 -18px;padding:7px 18px;background:#fff;
         font-size:.76rem;font-weight:800;color:var(--p,#3182F6);border-bottom:1px solid var(--border,#E2E8F0)}
/* 밀도 — 라벨·입력 간격을 좁혀 한 화면에 더 담는다 */
.rf-main .rform-label{margin-bottom:2px;font-size:.72rem}
.rf-main .rform-input{padding:7px 9px;font-size:.82rem}
.rf-main textarea.rform-input{min-height:52px}
.rf-grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px;align-items:start;margin-bottom:9px}
@media (max-width:1100px){ .rf-grid2{grid-template-columns:1fr} }
/* 가로 표기 — 라벨을 왼쪽에 붙여 같은 높이에 더 많이 담는다(짧은 항목 전용) */
.rf-hrow{display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center;margin-bottom:9px}
.rf-hrow.rf-hrow-w{grid-template-columns:76px 1fr}
.rf-hrow.rf-hrow-top{grid-template-columns:76px 1fr;align-items:start}
.rf-hrow .rf-hl{font-size:.72rem;font-weight:700;color:var(--t2,#475569);text-align:right;line-height:1.25}
.rf-hrow .rform-input{margin:0}
@media (max-width:1100px){
  .rf-hrow,.rf-hrow.rf-hrow-w,.rf-hrow.rf-hrow-top{grid-template-columns:1fr;gap:3px}
  .rf-hrow .rf-hl{text-align:left}
}
/* 진행상품 표 — 상품명 · 옵션명 · 결제금액 · 총인원 · 일건수 */
.rf-prod-head,.rf-opt-row{display:grid;grid-template-columns:1.6fr 1fr .85fr .62fr .62fr 26px;gap:6px;align-items:center}
.rf-prod-head{font-size:.62rem;font-weight:800;color:var(--t3,#94A3B8);padding:0 2px 4px;border-bottom:1px solid var(--border,#E2E8F0);margin-bottom:5px}
.rf-opt-row{margin-bottom:6px}
.rf-opt-row .rform-input{font-size:.74rem;padding:6px 7px;margin:0}
.rf-opt-row .rf-opt-pay,.rf-opt-row .rf-opt-rt,.rf-opt-row .rf-opt-dl{text-align:right}
.rf-opt-row .rf-opt-prod.rf-dup{background:#FAFBFD;color:var(--t2,#475569)}
/* 좁은 화면: 세로로 되돌리고 미리보기는 접어 둔다(입력이 우선) */
@media (max-width:900px){
  .rf-split{flex-direction:column;overflow-y:auto}
  .rf-side{width:auto;border-left:none;border-top:2px dashed var(--border,#E2E8F0)}
  .rf-side.collapsed{display:none}
  .rf-pvtoggle{display:block}
}
.rf-pvtoggle{display:none;width:100%;margin:0;padding:9px;background:#EEF3FD;color:var(--p,#3182F6);
             border:none;border-top:1px solid var(--border,#E2E8F0);font-size:.76rem;font-weight:800;cursor:pointer;font-family:inherit}`;
  function injectCss() {
    if (document.getElementById('recruit-modal-css')) return;
    var st = document.createElement('style');
    st.id = 'recruit-modal-css';
    st.textContent = SHELL_CSS + '\n' + CSS;
    document.head.appendChild(st);
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
    injectIconFallback();
    return true;
  }

  window.RecruitModal = { mount: mount, html: HTML };
  // 스크립트가 마운트 지점 뒤에 로드되면 즉시, 아니면 DOM 준비 후
  if (!mount()) document.addEventListener('DOMContentLoaded', function () { mount(); });
})();
