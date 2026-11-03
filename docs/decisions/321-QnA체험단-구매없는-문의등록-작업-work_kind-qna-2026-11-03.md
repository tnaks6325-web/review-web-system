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
  - 잠금: 문구 부족·빈 문구 · 공개 > 총건수 · 하루 건수 0 · 시작일 없음 · 옛 형식(v1) · **총모집 ≠ 상품별 합**.
- **날짜 건너뛰기 단일 출처 = `worktablePlan.businessDays`** — 리뷰 구매일자(`distributeDates`)도 이것을 탄다(뽑아내기 전과 600 조합 바이트 동일 — 회귀가드).
- **작업표 칸**: 구매일자 → 「진행일자」(같은 dateStr 역할) · 「공개여부」·「문의문구」(역할 없음 — 제출 매퍼가 덮지 않음) 추가 · 리뷰옵션·주문번호·아이디·연락처·주소·결제금액 칸 없음. 이름(수취인)·입금 계좌·리뷰·입금일 칸은 둔다.
- ★★ **작업표 자동 정리 격리 (완화 금지)** — 판정 `qnaSlots.isQnaTab`(조회 실패 = Q&A 로 본다 · fail-closed):
  - 빈 줄 날짜 옮기기(`relayWorktableToProjection`) → 건너뜀.
  - 총 건수 맞추기(`syncWorktableSlotsInTx`·저장 전 확인 `assertWorktableSlotsInTx`) → 줄 수가 바뀌면 `recruit_quota_qna_locked` 로 저장 전체 거절.
  - 번호 겹친 빈 줄 정리(`cleanupPairedBlanks`) → 자리표에 묶인 줄 제외(`boundRowSql`).
  - 빈 줄 고르기·덧붙이기(`writeOrderToWorktable`) → 자리 번호 없는 주문은 `qna_slot_required` 로 멈춤(3단계 Q&A 제출은 줄 번호로 들어온다).
  - 행 삭제 보충(`hideWorkdeskRow`) → 지운 줄과 **같은 날**로 늘 보충하고 자리표 `seq` 를 새 줄로 옮김(같은 트랜잭션).
  - 작업 삭제 → `qna_slots` 도 지움(`workTabDelete.DELETE_TABLES`).
- ★★ **접수 뒤 수정 잠금 (완화 금지)** — 종전 잠금(`isSourceEditLocked`)은 공고·광고주 연결 뒤에만 걸려, **발행 전 Q&A 오더는 건수가 바뀌어도 자리표와 어긋난 채 저장**됐다(로컬 실측). `_qnaCalendarLocked`(Q&A 종류 + 그 오더의 자리표 존재 · 조회 실패 = 잠금)로 세 경로를 막는다:
  - 인트라넷 원본 수정(`PUT /intake/source/:id`) — 양방향·담당자 갈래보다 먼저.
  - 옛 갱신(`POST /intake/:id/update`).
  - 리뷰웹 작업오더 수정 창(`orderAdminEdit`).
  - 공유 패치(`sharedPatch._projectQuantityInTx`) — 건수·하루 건수 변경 `qna_calendar_locked`, 상품 더하기·빼기 영구 금지(`structurePermanentlyLocked`).
  - 비교는 `_acceptedWorktableLockedFields` 한 곳 — 같은 값 재전송·상품 주소·안내 문구·특이사항은 통과.
- 로컬 실측(가짜 DB · 운영 작업표 표준 열 복사 · 서버 TZ=UTC): 첫 실제 오더 모양 50자리, 공개 11/4·6·10·12·16 · 공개 줄 삭제 → 11/4 공개 자리로 보충·자리표 이동 · 인트라넷 수정 5종(건수·문구·시작일·하루건수 거절 / 주소·특이사항 통과) · 리뷰웹 수정 창 3종 거절 · 일반 리뷰 오더는 종전 그대로.
- 회귀가드: `server/tests/qnaSlotCalendar.test.js`(43) · `qnaWorktableGuards.test.js`(29).

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
