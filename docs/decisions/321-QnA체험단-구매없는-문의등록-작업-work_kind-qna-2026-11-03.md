# ★★ Q&A체험단 — 구매 없이 상품 문의만 남기는 세 번째 체험단 종류 (`work_kind='qna'`, 사용자 확정 2026-11-03)

## 무엇을 하는 작업인가
- 참여자는 **상품을 사지 않는다**. 지정된 스마트스토어 상품 페이지에 **문의(Q&A)** 를 남기고, 그 화면 캡처를 올린다.
- 자리마다 **공개 · 정해진 문구 그대로** 또는 **비공개 · 배송문의 자유** 가 붙는다.
- 입금 = **참여비만**(상품값 환급 없음).
- 첫 실제 오더(2026-11-03, 일사공미디어): 총 50건.
  - 6상품 × 4~6건 = 30건 전부 비공개, 상품당 하루 1건.
  - 1상품 20건, 하루 2건 — 공개 5건(문구 지정, 하루 건너), 비공개 15건.

## 사용자 확정 (2026-11-03)
| # | 질문 | 확정 |
|---|---|---|
| 1 | 누가 남기나 | 모집공고로 리뷰어 모집 — 기존 신청·제출·입금 흐름 |
| 2 | 받는 정보 | **전화번호·주문번호·주소 입력 없음**. 로그인 계정에 이미 있는 번호만 시스템이 내부에서 쓴다(중복참여·블랙리스트 유지) |
| 3 | 공개/비공개·문구 | 오더에 상품별 총건수·공개건수·공개 문구 목록 → 시스템이 날짜별 자리를 만들고 자리마다 붙여 보여준다 |
| 4 | 하루 건수 | 시스템이 그날 몫만 연다(상품별 일건수) |
| 5 | 입금 | 참여비만 |
| 6 | 접수 | 인트라넷 리뷰오더의 「체험단 종류」에 Q&A 추가 |
| 7 | 제출물 | 캡처 1장(비공개 표시가 보이게 찍도록 안내) |
| 8 | 못 채운 자리 | 다음 날로 넘기지 않는다 — 일정 끝에 「추가 모집 / 그대로 끝내기」를 담당자가 정한다(228 과 같은 규칙) |

## 단계 (리뷰웹 먼저, 인트라넷 마지막)
- ★★ 순서가 중요하다 — 리뷰웹이 `qna` 를 모르는 동안 인트라넷이 보내면 `normalizeWorkKind` 가 **조용히 review 로 접는다**(구매양식·리뷰 검수가 붙은 리뷰 작업이 된다).
1. **판정 단일 출처에 qna 추가 + 안전핀** ← 이 항목의 첫 PR
2. 날짜별 자리표(날짜 · 공개/비공개 · 문구) 생성 + 작업보드 표시
3. 리뷰어 화면 — 신청 시 오늘 자리 배정·안내, 구매양식 대신 캡처 제출
4. 입금 — qna 는 상품값 없이 참여비만(`payment.service` `no_price` 막힘 해제)
5. 인트라넷 리뷰오더 Q&A 탭(구매·배송·리뷰타입·유입·결제금액 칸 숨김, 상품별 공개건수·공개 문구·간격 입력)

## 1단계 규율 (지금 지켜야 하는 것)
- **판정 = `utils/workKind.js` 한 곳.**
  - `QNA_PATTERN` 은 **확실한 표기만** 잡는다: `Q&A` `Q/A` `QnA` `큐앤에이` `문의등록`.
  - `qa` 같은 짧은 낱말은 다른 글자에 섞여 오탐하므로 잡지 않는다.
  - ★ **블로그를 먼저 본다** — 블로그 판정은 기존 규칙이라 답이 바뀌면 안 된다.
  - 운영 저장값(2026-11-03 읽기 조회)은 `''`·`review`·`blog` 뿐이라, 기존 작업이 qna 로 바뀌는 일은 없다.
- **프론트 사본**: `work-order-detail.js` `WO_KIND_LABELS`·`_woIsQnaKind`·`_woHasNoReviewType`.
  - 서버와 판정이 일치하는지는 회귀가드가 실제 실행으로 대조한다.
  - 프리필을 고치면 `server/scripts/gen-wo-campaign-prefill.js` 로 서버 사본을 다시 만든다.
- ★★ **발행 폼 프리필이 qna 를 지우지 않는다**(`_rfPrefillWorkKind`) — 종전 코드는 blog 가 아니면 `''` 로 접어, Q&A 오더로 발행한 공고가 리뷰 공고로 저장될 자리였다.
- ★★ **검수 격리 (완화 금지)**:
  - 1차 필터는 qna 면 `skip('qna_tab')`.
  - 2차는 형식·상품명·본문겹침을 skip 한다(블로그와 같은 갈래 `_isBlogTab`).
  - **같은 파일(중복) 검사는 그대로 둔다.**
  - 결과물이 문의 화면이라 리뷰 화면 판정이 정상 제출을 `other` 로 잠근다(참여 소각).
- ★★ **업로드 검수도 격리(완화 금지)** — 사진을 올리는 순간 도는 `verifyCapture`(diag 업로드)는 리뷰 칸에 리뷰 화면을 기대한다.
  - qna 탭의 리뷰 칸은 이 검수를 건너뛴다(`_isQnaUpload`). 형식 불일치 경고·관리자 알림·자동 이동이 생기지 않는다.
  - 판정 실패·미등록 탭은 false = 종전 동작.
- **막다른 길·새는 자리(코드 검토 반영)**:
  - 작업보드 「＋ 블로거 추가」는 qna 작업에 안 보인다(서버가 blog 아님으로 거부하는 버튼).
  - 발행 폼: qna 는 리뷰타입 카드를 숨기고 저장 때 비운다. 종류 탭은 qna 를 리뷰로 켜지 않는다(Q&A 탭 자체는 3단계).
  - 광고주 포털 작업 종류 = 「Q&A 체험단」.
- **구매 전제 기능 제외**:
  - 인당 구매수량 단계를 복사하지 않는다(`campaign.routes` 발행).
  - 미달 연장 팝업에 올리지 않는다(`campaignShortage.NO_DAILY_CARRY_KINDS`) — 확정 8.
- 회귀가드: `server/tests/qnaWorkKind.test.js`.
  - 기존 가드 5개(blogWorkKind·reviewType·reviewTypeMixPipelineContract·campaignShortagePrompt·qtyTiersCampaign)는 패턴만 갱신했다 — 검사 의미 불변. 블로그 포함을 함께 고정해 오히려 강화했다.

## 2단계 — 날짜별 자리표 (migration 210 · 사용자 확정 2026-11-03 추가분)
- 추가 확정: **접수 뒤 건수·상품·하루 건수·공개 문구·시작일 변경 금지**(늘리려면 일정 끝 「추가 모집」) · 신청 후 1시간 + 그날 자정까지 제출, 자정 10분 전 신청 막음(3단계).
- **생성 = `utils/qnaCalendar` 순수 함수**, 저장 = `qnaSlots.service.insertCalendar`(접수 때 작업표 줄과 같은 흐름 · 실패는 던짐).
  - 상품(선택지)마다 **시작일부터 동시에** 하루 `daily` 건. 공개글은 하루 1건, 그날 첫 자리, 간격 `public_gap_days`.
  - 줄 순서 = (날짜, 상품 순서, 상품 안 순번) — 같은 입력이면 같은 자리표.
  - 오더 입력: v2 `product_options_json` 각 단위(`base` 또는 `options[i]`)의 `count`·`daily` + `qna:{public_count, public_texts[], public_gap_days}`. 없으면 전부 비공개.
  - 잠금: 문구 부족·빈 문구 · 공개 > 총건수 · 하루 건수 0(선택지에 0 을 적으면 0 그대로 — 안 적었을 때만 오더 하루 건수) · 시작일 없음 · 옛 형식(v1) · **총모집 ≠ 상품별 합** · 자리 합계 > 2000(`qna_too_many` — 자리를 펼치기 **전에** 본다, 큰 오타로 서버가 멈추지 않게).
- **날짜 건너뛰기 단일 출처 = `worktablePlan.businessDays`** — 리뷰 구매일자(`distributeDates`)도 이것을 탄다(뽑아내기 전과 600 조합 바이트 동일 — 회귀가드).
- **작업표 칸**: 구매일자 → 「진행일자」(같은 dateStr 역할) · 「공개여부」·「문의문구」(역할 없음 — 제출 매퍼가 덮지 않음) 추가 · 리뷰옵션·주문번호·아이디·연락처·주소·결제금액 칸 없음. 이름(수취인)·입금 계좌·리뷰·입금일 칸은 둔다.
- ★★ **작업표 자동 정리 격리 (완화 금지)** — 판정 `qnaSlots.isQnaTab` = 자리표가 있거나 `tab_configs.work_kind='qna'`(자리표 저장이 실패한 Q&A 탭도 격리). 조회 실패(표 없음 포함) = Q&A 로 본다(fail-closed). 트랜잭션 연결에서는 SAVEPOINT 로 감싼다(조회 실패가 바깥 트랜잭션을 죽이지 않게). `qna_slots` 는 기동 필수 표(`REQUIRED_TABLES`).
  - 빈 줄 날짜 옮기기(`relayWorktableToProjection`) → 건너뜀.
  - 총 건수 맞추기(`syncWorktableSlotsInTx`·저장 전 확인 `assertWorktableSlotsInTx`) → 줄 수가 바뀌면 `recruit_quota_qna_locked` 로 저장 전체 거절.
  - 번호 겹친 빈 줄 정리(`cleanupPairedBlanks`) → 자리표에 묶인 줄 제외(`boundRowSql`).
  - 빈 줄 고르기·덧붙이기(`writeOrderToWorktable`) → 자리 번호 없는 주문은 `qna_slot_required` 로 멈춤(3단계 Q&A 제출은 줄 번호로 들어온다).
  - 행 삭제 보충(`hideWorkdeskRow`) → **자리표에 묶인 줄만**(`isBoundRow` · 실패 = 묶인 것) 지운 줄과 **같은 날**·같은 진행일 칸 표기로 늘 보충하고 자리표 `seq` 를 새 줄로 옮김(같은 트랜잭션). 자리 없는 줄(손으로 더한 줄)은 보충하지 않는다.
  - 줄 정리·중복 정리·짝 빈 줄 정리의 실행부(`sheetlessLedger.retireRows`) → 묶인 줄이 섞이면 `qna_slot_rows` 로 거절(차수 단위 정리는 통째로). 주문 취소보다 먼저 막힌다.
  - 주문 행 삭제(`deleteWorkdeskOrderRow`) → 묶인 줄은 `qna_slot_row`(409) — 「줄 삭제」로 안내(보충이 있는 쪽).
  - 구매일자 달력(`setWorkdeskPurchaseDate`) → 묶인 줄의 진행일자는 `qna_slot_date_locked`. 일반 칸 편집(`editWorkdeskRow`)도 묶인 줄의 진행일자·공개여부·문의문구·**상품·옵션 칸**(판정 = `orderLedger.productWriteColumns`·`optionWriteColumns` 단일 출처)은 `qna_slot_cell_locked`(보충 줄이 고친 칸을 이어받아 자리표와 갈리지 않게).
  - 번호 없는 주문 옮기기(`assignUnslottedOrderToOpenSlot`) → `qna_slot_required`.
  - 옛 신청 줄 덧붙이기(`sheetlessApplicant.addApplicantRow`) → 던진다(시트로도 넘기지 않음).
  - 차수 추가·삭제(`POST/DELETE /trackb/campaigns/:id/rounds`) → `rounds_qna_locked`(409 · `isQnaCampaign` 실패 = 막음). `_cdpFail` 에 `recruit_quota_qna_locked: 409`.
  - 작업 이름 바꾸기(`tabRename.renameTabState`) → `qna_slots.tab_name` 도 같은 트랜잭션에서 옮긴다(안 옮기면 자리표 잃은 탭이 리뷰 탭처럼 정리된다).
  - 상품·선택지 이름 바꾸기 → **막는다**(`campaignOptionRename.applyRenamePlanInTx` 가 `qna_rename_locked` 로 쓰기 전에 던짐 · 공유 저장은 `w.rename` 쓰기를 `qna_calendar_locked`). 「접수 뒤 상품 변경 금지」(확정 1.가)에 해당하고, 공고 선택지 키(예: `검정`)와 자리표 키(`양말 · 검정`)는 표기가 달라 따라 바꾸면 어긋난다(코덱스 재검토 — 이름 맞바꾸기에서 상품 이름이 한쪽으로 몰림). 자리표를 따라 바꾸는 사본은 두지 않는다.
  - 주말 제외·시작일·제외일 → 공유 저장(`applySharedPatch`)이 쓰기 전에 `qna_calendar_locked`, 공고 창 저장(`PUT /campaign/admin/:id`)도 주말 제외 변경을 모든 쓰기보다 앞에서 409. 주말 제외만 바꿔도 공고가 주말 모집을 닫아 이미 깔린 주말 자리가 안 열린다(자리표는 날짜를 옮기지 않는다).
  - 작업 삭제 → `qna_slots` 도 지움(`workTabDelete.DELETE_TABLES`).
- ★★ **자리표 저장 실패 = 접수를 끝내지 않는다 (완화 금지)** — 접수가 끝나면(상태 전이 `reviewing`) [접수하기] 버튼이 사라지고 재호출은 멱등 반환이라 **다시 깔 길이 없다**(막다른 길). 그래서 Q&A 는 저장 실패 시 상태를 바꾸기 **전에** `qna_calendar_failed`(409)로 멈추고, 다시 누르면 남은 줄을 재사용해 같은 자리표를 깐다.
  - 깔기 전에 **이미 있는 줄이 계획과 줄마다 같은지**(`verifyRowsMatchPlan` — 선택지·진행일 칸·공개여부·문의문구) 본다. 다르면 깔지 않고 멈춘다(어긋난 자리표는 없는 것보다 나쁘다 → 작업을 지우고 다시 접수).
  - 연결까지 끝난 오더의 재접수(반려 뒤 등)에서 자리표가 비어 있으면 `repairCalendarIfMissing` 으로 같은 대조 뒤 되살린다.
  - ★ 3단계: 신청 때 자리표가 0칸이면 신청을 막는다(fail-closed) — 자동 복구를 붙이려면 같은 대조를 거친다.
- ★★ **접수 뒤 수정 잠금 (완화 금지)** — 종전 잠금(`isSourceEditLocked`)은 공고·광고주 연결 뒤에만 걸려, **발행 전 Q&A 오더는 건수가 바뀌어도 자리표와 어긋난 채 저장**됐다(로컬 실측). `_qnaCalendarLocked`(Q&A 종류 + (작업표 연결 `linked_tab_name` 또는 자리표 존재) · 조회 실패 = 잠금)로 세 경로를 막는다:
  - 인트라넷 원본 수정(`PUT /intake/source/:id`) — 양방향·담당자 갈래보다 먼저.
  - 옛 갱신(`POST /intake/:id/update`).
  - 리뷰웹 작업오더 수정 창(`orderAdminEdit`).
  - 공유 패치(`sharedPatch._projectQuantityInTx`) — 건수·하루 건수 변경 `qna_calendar_locked`, 상품 더하기·빼기 영구 금지(`structurePermanentlyLocked`).
  - 비교는 Q&A 전용 `_qnaLockedFields` — **자리표를 정한 칸만**(총 건수·하루 건수·시작일·주말 제외·제외일·종류·상품 구성) 자리표 계획이 읽는 모양으로 정규화해 비교한다(글자 숫자·시각 붙은 날짜·주말 true↔빈 값·제외일 순서/중복은 같은 값). 리뷰타입·배송유형은 Q&A 자리표와 무관해 잠그지 않는다. 제외일 정규화는 `worktablePlan.normalizeHolidayList` 단일 출처. 옛 갱신 경로는 종전 잠금이 걸린 오더면 종전 비교(`_acceptedWorktableLockedFields`) 그대로.
  - 자리표 계획은 미리보기의 날짜 조정(시작일·주말·제외일)을 받지 않는다 — 잠금이 오더 값과 비교하므로, 조정값으로 깔면 "잠겼는데 표와 오더가 다른" 상태가 된다.
- 로컬 실측(가짜 DB · 운영 작업표 표준 열 복사 · 서버 TZ=UTC): 첫 실제 오더 모양 50자리, 공개 11/4·6·10·12·16 · 공개 줄 삭제 → 11/4 공개 자리로 보충·자리표 이동 · 인트라넷 수정 5종(건수·문구·시작일·하루건수 거절 / 주소·특이사항 통과) · 리뷰웹 수정 창 3종 거절 · 일반 리뷰 오더는 종전 그대로.
- 코드 검토 반영 뒤 로컬 실측(같은 조건): 같은 값 표기 차이 재전송 통과 / 제외일·하루 건수 변경 거절 · 자리표 저장 실패 흉내(로컬 DB 쓰기 막음) → 접수 안 끝남 → 다시 누르면 처음과 같은 50자리 · 줄 하나 날짜가 다르면 깔지 않음 · 자리 없는 줄 삭제 보충 없음 · 자리 줄 날짜 고치기 거절 · 차수 추가·삭제 거절 · 작업 이름 바꾸기에 자리표 따라감 · 리뷰 작업(줄 삭제 보충·날짜 고치기·접수 뒤 수정) 종전 그대로.
- 회귀가드: `server/tests/qnaSlotCalendar.test.js`(47) · `qnaWorktableGuards.test.js`(66 — 이름 바꾸기 막음은 실제 실행 · 잠금 비교·자리 판정·복구 대조·이름 바꾸기는 실제 실행) · `sheetlessNoEmptyOverflow.test.js` 패턴 보정(Q&A 판정 조회는 덧붙이기 준비가 아님 — 검사 의미 불변).

## 3~5단계 — 사용자 확정 (2026-11-03 「전부 권장」)
- 진행 방식: 3단계(리뷰어 신청·제출)와 5단계(인트라넷 Q&A 탭)를 동시에, 4단계(참여비만 입금)는 3단계 제출 기록 모양이 정해지면 바로. **운영 반영은 리뷰웹(3·4) 먼저, 인트라넷 탭 마지막.**
1. 자리 배정 = 그 상품의 **오늘 빈 자리를 앞에서부터**(공개 자리가 그날 첫 자리라 먼저 채워진다). 리뷰어가 공개/비공개를 고르지 않는다.
2. 모집 페이지 = **[Q&A] 탭·표시를 따로** 둔다(리뷰 탭에 섞지 않음).
3. 재구매 제한(같은 상품 일정 기간)은 **적용하지 않는다**(구매가 아님). 같은 공고 1인 1회는 유지.
4. 하루 신청 한도(10회)에는 **센다**, 인기 공고 참여 횟수에는 **세지 않는다**.
5. 「추가 모집」 = 못 채운 자리를 **공개/비공개·문구 그대로**, 다음 진행일부터 같은 하루 건수로 다시 깐다.
6. 인트라넷 Q&A 탭은 유입방식(유입 검색어·유입가이드)도 **숨긴다**.
7. 캡처가 마감(신청 후 1시간·그날 자정 중 빠른 쪽) 전에 안 올라오면 **미제출 — 자리를 다시 푼다**(마감 뒤 30초 여유만 유지). 23:50부터 새 신청 막음.

## 조사로 확인한 남은 단계의 함정 (2~5단계 착수 전 다시 읽을 것)
- **순차진행(212·228)은 하루에 상품 하나뿐**(`sequentialSchedule.byDate` = 날짜당 1건) — 여러 상품을 동시에 하루 1건씩 여는 데 쓰면 안 된다.
  - 상품별 일건수는 균등 모드 + 선택지 `daily_limit`(결정 210) 으로 이미 된다.
  - 「공개는 하루 건너」처럼 날짜마다 다른 규칙은 **새 자리표**가 필요하다.
- **작업표 행 날짜는 믿을 수 없다** — `sheetlessDailyPlan.relayWorktableToProjection` 이 빈 행 날짜를 계속 옮기고, 행은 구매양식 제출 때에야 묶인다(`_pickOpenSlot`). 자리표를 `row_json` 에만 두지 않는다.
- **구매양식이 없으면 장부 줄이 안 생긴다.** 그러면 작업보드 채움·검색·입금이 전부 `order_submissions` 에 매달려 있어 아무것도 세지지 않는다. Q&A 제출 경로가 최소 장부 줄과 홀드 확정(`confirmHoldInTx`)을 만들어야 한다.
- **입금**: `amount = productPrice + fee` 이고, `!productPrice` 면 `no_price` 로 막힌다(`payment.service`).
- **전화번호**: 로그인·신청·홀드 유니크(`uq_campaign_apps_active_hold` = campaign_id+phone8)·블랙리스트·입금 대상(`ri.phone8 <> ''`)이 전부 phone8 이다. 계정 phone8 을 그대로 쓴다(확정 2) — 화면에서 묻지만 않는다.
- **표기 규칙의 한계** — `faq/answer`·「문의등록 없음」 같은 자유 문구는 qna 로 잡히고, 전각 `Q＆A` 는 review 로 접힌다.
  - 그래서 인트라넷(5단계)은 **코드값 `qna` 만** 보낸다. 규칙을 넓히지 않는다.
- **아직 qna 를 리뷰로 다루는 곳(단계별로 고친다)**:
  - 2단계: `worktablePlan.isBlogWorkOrder`(구매일자별 준비 행), `sharedPatch.structurePermanentlyLocked`(접수 뒤 상품 추가·삭제를 자리표와 함께 정한다).
  - 3단계: `campaign.routes` 신청 분기, `campaign.html isBlogCampaign`, `search-app.js _isBlogItem`, `campaign-cards.js` 배지, `index.html`·`recruit.html _rcKindOf`, `index-recruit.js` 게시 전 점검(구매채널·구매시간 요구), `submit.routes` 리뷰 제출 경로, `recruit-modal.js` 종류 탭.
  - 4단계: `payment.service`(종류 분기 없음 → `no_price`).

## 3단계 — 리뷰어 신청·제출 (2026-11-03 · migration 211)
- **신청 = 그날 자리 하나를 묶는다** — `campaign_applications.qna_slot_id`(211). `_applyParticipation` 의 모든 게이트 뒤·INSERT 직후 UPDATE(INSERT 칸 목록 가드 유지). 고르기 = `qnaSlots.bindSlotForApply`(공고 선택지 키 → `qnaOptKeyMap` → 자리 단위) → `pickSlotInTx`(지난 홀드 정리 → 오늘·열린·묶이지 않은 자리 `unit_seq` 순 FOR UPDATE). `camp_tab_daily` 잠금 안. 한 자리에 둘 = 부분 유일 색인 `uq_campaign_apps_qna_slot`(applied·submitted). 못 고르면 `qna_no_slot`(fail-closed).
- 기한 = `qnaHoldExpiry`(신청 + 1시간과 그날 자정 중 빠른 쪽) · 23:50 KST 부터 새 신청 막음(잠금 앞 `qna_day_closing` + 상태 엔진 `cutoff`). 마감 뒤 자리 풀기 = 줄 기록 전이면 기존 홀드 스윕(30초 여유), 줄 기록 뒤 캡처를 안 냈으면 아래 「검토 반영」의 캡처 기한 스윕 — 자리 점유는 신청 상태로만 판단하므로 자리 표에 쓸 것이 없다.
- 개수 단계(289)·재구매 기간 판정 건너뜀. 같은 공고 같은 명의 제출완료 = `one_per_person`(확정 3). 하루 신청 한도는 그대로 센다 · 인기 참여권 적립에서 `qna_slot_id IS NULL`(확정 4). 상품 바꾸기(change-option) = `qna_option_locked`.
- **오늘 정원 단일 출처** = `qnaSlots.loadTodayByCampaign`(오늘 날짜 자리 수, 취소 제외) — `fetchCampaignCounts`(맨 뒤 · 066 순서 계약)·`fetchOptionCountsBatch`(Map 속성 `qnaToday`)가 싣고, `computeCampaignState` 는 `counts.qnaToday` 가 숫자면 그것을 정원으로(이월 0), `computeOptionViews` 는 상품별 오늘 자리 수를 하루 몫으로 쓰며 순차진행 규칙을 쓰지 않는다. 조회 실패 = 미부착 = 종전 정원(신청은 자리 묶기가 다시 막는다).
- **제출 창구 `POST /api/submit/qna`**(구매양식 대신): 리뷰어 세션 필수 → 홀드 인증(`_authoritativeHold`) → 기한(+30초) 확인 **뒤에만** 최소 장부 줄(이름·연락처·입금 계좌·진행일자 = 그 줄에 적힌 표기 그대로, `source='qna_submit'`) + 홀드 확정(같은 트랜잭션) → **그 자리 줄 번호로만** 작업표 기록(`writeOrderToWorktable sheetRow`). 확정이 `late` 면 장부 줄을 지운다(자리 없는 Q&A 주문은 갈 곳이 없다). 다른 주문이 앉은 줄은 덮지 않는다(`qna_row_taken`). 다시 누르면 같은 줄(줄 기록만 다시 맞춤).
- 화면(`campaign.html`): Q&A 공고는 구매양식 대신 Q&A 카드(날짜·공개/비공개·문구 복사·상품 페이지·캡처 1장). 제출 = ① `/api/submit/qna` ② 기존 리뷰 캡처 업로드 ③ `/api/submit/review`. ②·③ 이 실패하면 ① 은 남고 **캡처 다시 올리기 카드**로 남는다 — 진입·폴링 둘 다 `qnaSlot.captureDone === false` 면 완료 화면(홀드 정리)으로 넘기지 않는다. 유입가이드 카드는 숨긴다(`showInflow:false`).
- 모집 목록: 리뷰/블로그/Q&A 탭 · 💬 Q&A 배지 · 카드 문구 "참여·신청". ★ 공개 목록 SELECT 에 `work_kind` 가 빠져 있어 종류 탭이 늘 리뷰로 접히던 것을 함께 고쳤다(공개 칸 목록에는 있었다 · 운영 실측 2026-11-03: 목록에 오른 공고 20건 전부 리뷰라 지금 화면 변화 없음).
- 검색 색인 날짜: Q&A 작업표의 날짜 칸은 「진행일자」 — 다른 날짜 칸이 없을 때만 그것을 시작일로 읽는다(`columnResolver`). 빠지면 관리자 카드 오늘 인원·리뷰 마감 안내가 날짜를 못 읽는다.
- **일정 끝(확정 5)** — 순차진행 끝 창(`/api/trackb/sequential-end-prompts`)에 `kind:'qna'` 항목으로 함께 묻는다. 마지막 자리 날짜가 지났고 못 채운 자리(열림·제출 없음)가 있으면 대상. [추가 모집] = 못 채운 자리를 **같은 공개 여부·문구 그대로**, 다음 날부터 영업일에 그 상품의 하루 건수(처음 자리표의 하루 최대)로 **그 줄의 진행일자만** 옮긴다(새 줄·새 자리 없음 · 주문 붙은 줄 제외 · 작업표 기록과 같은 잠금 · 같은 일정 끝 한 번만 `campaign_plan_events.qna_extra`). [그대로 끝내기] = 못 채운 자리 `lapsed` + 공고 마감(`qna_finish`).
- 로컬 실측(가짜 데이터): API 21항목 · 일정 끝 17항목 · 브라우저(참여 → Q&A 카드 → 캡처 제출 → 완료 / 줄 기록 뒤 캡처 실패 → 다시 올리기 카드 유지 → 완료) 통과. 회귀가드 `qnaReviewerFlow.test.js`.
- ★ 완화 금지: 자리 묶기를 게이트 앞으로 옮기거나 fail-open 으로 바꾸지 않는다(빈 신청 = 제출할 줄이 없다) · 제출 창구의 기한 확인을 장부 쓰기 뒤로 옮기지 않는다 · 캡처 전 완료 화면 전환 금지(홀드 정리 = 다시 올릴 길이 사라진다).
- **독립 검토 반영(2026-11-03 · PR #1744 2차 커밋)**
  - ★ 캡처 기한 넘김 = 자리 풀기(확정 7을 실제로 지키기): 제출 창구 ①이 캡처 **전에** 신청을 확정(submitted)하므로 기존 홀드 스윕(applied 만 봄)으로는 풀리지 않았다. 매분 스윕에 `qnaSlots.sweepQnaCaptureTimeouts`(잠금 `qna_capture_sweep`)를 더했다 — 기한 + 30초 + 여유 2분이 지났고 캡처가 없으면 `trackB.hideWorkdeskRow`(「줄 삭제」와 같은 길: 주문 취소·신청 취소·줄 삭제·**같은 날·같은 자리 빈 줄 보충**·자리표 seq 이동)로 푼다. 줄 리비전을 넘겨 그 사이 바뀐 줄은 건너뛴다. 끄는 스위치 `QNA_CAPTURE_SWEEP=0`.
  - ★ 캡처 제출 판정 = **작업표 줄 `campaign_participants.is_submitted`(진실원본) 또는 색인 `review_index.is_submitted`** — 색인만 보면 장부 재생성(`rebuildLedgers`)이 표시를 지워 **낸 사람의 자리를 푸는** 사고가 난다(로컬 실측으로 재현). 리뷰어 화면 `captureDone` 도 같은 기준.
  - 일정 끝 반영 잠금 순서 = 작업표 잠금 → 공고 잠금(다른 경로와 같은 순서 · 반대면 교착) · 잠근 뒤 공고의 작업표 연결 재확인. 못 채운 자리 = 빈 줄이 살아 있는 자리(줄에 주문이 앉았거나 줄이 지워진 자리는 묻지도 옮기지도 않는다) · 잠금 안에서 줄이 안 움직이면 전부 되돌림.
  - 자리 고르기 = 공개 자리 먼저(`ORDER BY (visibility <> 'public'), unit_seq` — 추가 모집으로 순서가 섞여도) · 유예 = `HOLD_GRACE_SEC` 단일 출처.
  - 작업표 지정 줄 쓰기(`writeOrderToWorktable requireEmptyOrSame`) = 줄 잠금 안에서 남의 주문 줄이면 `row_taken`(바깥 확인과 잠금 사이 끼어들기 차단).
  - 구매양식 창구(`/api/submit/order`)는 Q&A 자리 신청을 받지 않는다(`qna_use_capture`) — 홀드 조회가 같은 왕복에 `qna_slot_id` 를 읽는다(부팅 필수 칸이라 늘 있음).
  - 신청 종류 판정이 공고의 없는 칸(`linked_tab_sheet_id`)을 읽어 탭 종류를 못 보던 것을 `linked_sheet_id` 로 고쳤다(운영 실측: 공고 종류 빈칸 + 탭 종류 블로그/Q&A 조합 0건 — 블로그 동작 변화 없음). 잠근 공고로 종류를 다시 맞춰 갈리면 `kind_changed`.
  - 공개 목록의 선택지 카운트 맵을 다시 만들 때 `qnaToday` 를 함께 옮긴다(빠지면 Q&A 선택지가 일반 하루 한도로 계산). 자리 이중 묶기 충돌(23505 `uq_campaign_apps_qna_slot`) = 「자리 찼음」 안내. Q&A 제출은 세션 로그인 번호 우선 · 두 번 눌러 먼저 확정됐으면 그 결과를 돌려준다. 화면: Q&A 공고는 자리 정보를 못 받으면 완료 화면 대신 다시 불러온다.
  - 로컬 실측: API 21 · 일정 끝 17 · 검토 반영 17(목록 오늘 자리 수 · 구매양식 막힘 · 캡처 안 낸 사람만 풀림 · 낸 사람 그대로 · 풀린 공개 자리를 다음 사람이 받음 · 재실행 0건) · 매분 스윕 본문 1회 실행 통과.
  - ★ 완화 금지: 캡처 기한 스윕 판정에서 작업표 줄 `is_submitted` 를 빼지 않는다 · 일정 끝 잠금 순서(작업표 → 공고)를 뒤집지 않는다 · 지정 줄 쓰기의 줄 잠금 안 확인을 빼지 않는다.
- 4단계 메모: Q&A 줄은 `productPrice=0` 이라 지금은 `no_price` 로 입금 대상에서 빠진다(안전 — 아직 보내지 않음). 참여비만 보내면 회차 항목 모양이 결정 292 「리뷰비만 보낸 건」(`isFeeOnlyItem`)과 같아져 입금일 기록·페이백 완료 표시를 건너뛴다 — 4단계에서 정한다.
