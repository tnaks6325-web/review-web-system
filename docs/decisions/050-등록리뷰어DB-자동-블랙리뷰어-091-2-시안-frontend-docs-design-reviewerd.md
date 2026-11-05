# 등록리뷰어DB 자동 블랙리뷰어 (091-2, 시안 `frontend/docs/design-reviewerdb-blacklist.html`)
- **표에 3열 추가**(타계정 오른쪽 누적참여·이전 리뷰 / 삭제 바로 왼쪽 참여설정 토글, `RV_COLSPAN` 13→16): **누적참여 = 본인+타계정 phone8 합산**(사용자 지시 "타계정 포함"), 이전 리뷰 = `리뷰미작성 N건`(빨강)·`기한경과 N건`(주황). **미작성 1건↑ = 자동 블랙리스트 후보**(빨간 건수 텍스트 + 🚨 후보 필터 칩이 표시의 전부 — ★ **행 배경색·이름 배지 없음**, 사용자 확정). 집계는 저장 없이 **페이지 행(≤200)만 조회 시 파생**(`annotateReviewerRows`), 실패 = `statsUnavailable` → **"집계 실패 ?"**(0으로 꾸미지 않음).
- **참여설정 토글**(빨간 사각 스위치) = 기존 전역 `blacklist` 테이블 등록/해제(`POST /api/trackb/reviewers/blacklist`, adminOrMaster). ★ **확인창 없이 즉시 적용**(사용자 확정 — 낙관 반영 + 실패 롤백), 사유는 현재 집계를 자동 기록. ★★ **효력 = Q1-B**: 전 공고 자동 차단이 아니라 **공고별 [🚫 리뷰어] 팝업 맨 위에 자동 표시**(`listGlobalBlacklist` — reviewer-gate GET에 동봉, 조회 실패는 **필드 미동봉** = 프론트가 "0명"으로 위장하지 않고 "조회 실패" 고지) + [🚫 블랙리스트 모두 차단] 버튼(스테이징 → confirm 경유, ★ **사람이 정한 허용 예외(allow)는 덮지 않는다**). 전역 자동 차단은 여전히 `CAMPAIGN_REVIEWER_GATE_GLOBAL=1` 옵트인 뒤에만.
- 필터 칩(전체/참여가능/블랙리스트/🚨 후보/기한경과만 — "기한경과만"은 승격분 제외) + 검색에 **등록 계좌번호** 부분일치 추가. ★ **엑셀 다운로드 없음**(사용자 확정 Q4 — 팝업의 예외 CSV도 제거). candidate/overdue 필터는 **본인 명의 phone8 기준**(타계정 미작성분은 건수 표시에만 합산 — 문서화된 한계).
- 회귀가드 `tests/reviewerDbBlacklist.test.js`(집계 시맨틱·서비스 스텁 실행·라우터·프론트 배선) + 진짜 PG16으로 승격/이중계수 검증. ⚠ 이 변경으로 `reviewerDbTab.ux`(컬럼 순서 16열)·`campaignReviewerGate`(기본값 14/30) 가드를 갱신(검사 의미 = 새 사용자 확정).
- 회귀가드 `tests/campaignReviewerGate.test.js`(판정 순수함수·스텁 db 서비스 실행(자리표시자 정합·PII 마스킹·tx)·라우터 스택 실검사·apply 배선 위치·프론트 배선) + **진짜 PG16으로 마이그레이션 idempotent·부분유니크·release 재등록·CASCADE·이력 집계 SQL 실행 확인**. ⚠ 이 변경으로 `workdeskSettingsTab` 가드의 패널 목록 패턴을 갱신(검사 의미 불변).
- ★★★ **블랙리스트 해제 = 다시 참여 가능 (사용자 확정 2026-10-01 · 완화 금지)**: 공고별 [🚫 리뷰어]의 "참여 불가"(`campaign_reviewer_gates` mode='block' — [블랙리스트 모두 차단] 버튼이 공고마다 만든다)는 전역 `blacklist` 와 **별개 표**라, 종전에는 블랙리스트만 풀려 리뷰어가 계속 "마감"으로 봤다(실측: 이미정 공고 39곳·모집 중 7곳, 다른 6명 31곳). 이제 `reviewerGate.setGlobalBlacklist(on:false)` 가 **blacklist 삭제 + 그 번호의 block 소프트 해제를 한 트랜잭션으로** 한다(묻지 않는다 · 실패 시 둘 다 되돌림 · `allow` 예외·이력 보존 · 응답 `campaignBlocksReleased`). ★ **해제 경로는 이 함수 하나** — 등록리뷰어DB 토글(`/api/trackb/reviewers/blacklist`)과 관리자 대시보드 옛 `/api/blacklist remove` 가 같은 함수를 쓰고, 옛 경로는 **admin/master 만** 허용(authMiddleware 뿐이라 막지 않으면 낮은 권한이 일괄 해제). ★ 되돌려 "블랙리스트만 풀기"로 나누면 이 사고가 재현된다. 회귀가드 `tests/blacklistCampaignBlocks.test.js`.
- ★ **리뷰어 삭제는 계좌 변경 기록이 있으면 막힌다(정상)** — `reviewer_account_change_audit`(입금 추적)가 RESTRICT 로 붙잡는다. 화면은 "서버오류" 대신 사유와 "재가입 불필요"를 말한다(409 `delete_blocked_by_history`). 재가입은 해결책이 아니다 — 공고별 차단·이력은 전화번호(phone8)에 매달려 있다.

## 개정 — 등록하면 공고별 「참여 불가」에 자동 반영 (사용자 확정 2026-11-05 「b」 · migration 214)
- 발단(직원 요청 2026-11-05): 「블랙리스트에 인원이 새로 추가되면 진행 중인 작업건에 설정된 블랙리스트에도 자동으로 업데이트되게」. 종전 Q1-B 는 공고 팝업 [블랙리스트 모두 차단]을 누르는 순간의 명단을 **복사**했다 → 나중에 추가한 사람은 이미 눌러 둔 공고에서 빠졌다.
- 운영 실측(읽기 전용 11/05): 진행 공고 17곳 **전부** [모두 차단]을 눌러 둔 상태(= 직원은 이미 「모든 공고 차단」으로 쓰고 있었다) · 그중 1곳에 1명 누락. 차단 3,641건 중 3,639건이 문구 「마감」.
- 사용자 선택지: ① 진행 중 공고에만(권장) ② 진행 중 + 앞으로 새로 만드는 공고까지 → **②(「b」)**.
- 동작(`reviewerGate.service`):
  - `setGlobalBlacklist(on:true)` — 블랙리스트 등록과 **같은 트랜잭션**에서 `blockOnOpenCampaigns`: 보관 안 된 공고 전부(작성중·게시중·마감 — 마감 뒤 다시 여는 공고도 빠지지 않게)에 `mode='block'`·`message_type='closed'` 를 **더하기만** 한다. 공고 차단이 실패하면 등록도 되돌린다(반쪽 등록 금지).
  - 새 공고 생성(`campaign.routes` adminCreate · Track B 프록시 포함) 직후 `blockBlacklistOnCampaign` — 블랙리스트 전원. fail-soft(실패해도 공고는 만들어지고 응답 `blacklistWarning`·로그, 종전처럼 [모두 차단]으로 넣을 수 있다).
  - 옛 관리자 창구 `POST /api/blacklist {action:'add'}` 도 같은 함수(어느 창구로 넣든 같은 결과).
  - ★ 그 공고에 이미 활성 행(허용 예외 'allow' · 이미 차단)이 있으면 **건드리지 않는다** — 사람이 정한 예외가 이긴다(NOT EXISTS + 부분 유니크 `ON CONFLICT DO NOTHING`).
  - `created_by` = `<등록자> · 블랙리스트 자동` / migration 은 `migration 214 · 블랙리스트 자동`(되돌릴 때 찾는 표시).
- migration 214 = 그 전에 빠져 있던 것만 한 번 채움(운영 예상 55행: 작성중 53 · 게시중 1 · 마감 1) · 멱등.
- 푸는 쪽(위 ★★★)은 그대로 — 블랙리스트에서 빼면 그 번호의 모든 공고 차단이 함께 풀린다.
- `CAMPAIGN_REVIEWER_GATE_GLOBAL`(전역 옵트인)은 계속 꺼져 있다 — 이번 개정은 행을 넣는 방식이라 팝업 표에 그대로 보인다.
- 남은 것: 등록리뷰어DB 토글 안내 문구(「공고별 팝업 상단에 표시됩니다」)는 화면 변경이라 이번에 바꾸지 않았다. 보관했다가 되살린 공고는 그 사이 추가된 사람이 빠질 수 있다(되살림 경로 없음 확인 전).
- 검증: `tests/blacklistCampaignBlocks.test.js` 2d(종전 「등록은 공고 차단을 안 건드린다」를 뒤집음)·2e(실패 = 등록 롤백)·2f(새 공고) · `tests/blacklistAutoCampaignBlocksPg.test.js`(실 PG 5 — 보관·허용 무접촉·중복 0·migration 214 멱등·해제 연동·실제 참여 판정) · `reviewerDbBlacklist` 해제 판정을 순번 대신 내용으로(의미 불변).
