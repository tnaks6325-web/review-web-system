# P2a 상세설계 — 인덱스 빌더 컬럼감지 공용화 (columnResolver)

> 목적: `review_index`를 만드는 **두 빌더의 분리된 컬럼감지 로직을 단일 공용 모듈로 통합**한다.
> 이는 ① 두 빌더가 같은 탭을 다르게 인덱싱해 생기는 **진동 제거**(G4의 빈번한 부분), ② 이후 **P2b(DB매핑 우선)를 한 곳에만** 넣으면 되게 하는 토대다.
> **P2a는 기능 무변경 리팩터**(indexBuilder 동작 그대로 + smartBuild가 누락 컬럼 3개를 획득)다. DB매핑·체크섬무효화는 P2b/P2c.

## 1. 현 구조 (정밀 diff — 조사 완료)

`review_index`를 만드는 컬럼감지 구현이 **둘**이다:
- `indexBuilder.service.js parseTabRows`(:903-1082) — 9/15시·수동·4시 빌드. **슈퍼셋**.
- `smartBuild.service.js _parseTabRows`(:143-238) — 5분 주기. **부분집합**.

**동일한 부분(검증됨, 바이트 일치):**
- 헬퍼 `_isSubmittedValue`/`_isDataTabRow`/`_formatDate` — 두 파일에서 동일.
- 헤더행 탐지(`_isDataTabRow` 50행 스캔), `nameColIdx`(NAME_KEYWORDS, <0이면 `return []`).
- 제출열 3단계(리뷰접두사>일반>폴백, EXCLUDE 동일), product/url/phone/startDate/endDate/round 감지 — 동일.
- 행 반환: name/tabGid/rowIndex/isSubmitted/submitCol/productName/productUrl/rowJson/startDate/endDate/round/campaignName/phone8.

**유일한 차이 (indexBuilder에만 있음):**
- `recipientColIdx`(주문자/예금주 헤더면 수취인 탐색, 역방향 포함) → `recipientName`.
- `paymentColIdx`(정확/부분/제외 3단계) → `isSubmitted2`('PAID'|'NONE'), `submitCol2`.

→ smartBuild는 이 3개(`recipient_name`/`is_submitted2`/`submit_col2`)를 **계산도, upsert 컬럼도 없다**(smartBuild upsert `:336-356`은 이 3컬럼 미포함, ON CONFLICT SET에도 없어 기존값은 보존하나 신규행은 비움). indexBuilder는 모두 계산·기록.

**키워드:** 양쪽 다 `index_keywords` 테이블에서 `NAME/SUBMIT/DATA_TAB_KEYWORDS`·`SUBMITTED_VALUES`를 로드(각자 로더). → 공용화 시 **로더도 통일**(같은 테이블이라 결과 동일해야 함 — 구현 전 1회 확인).

## 2. 공용 모듈 설계 — `server/src/services/columnResolver.js` (신규)

키워드 로드는 async(DB), 파싱은 sync(빌더가 이미 그렇게 호출)인 현 패턴 유지:

```
// columnResolver.js (신규)
let _kw = null;                          // {NAME, SUBMIT, DATA_TAB, SUBMITTED} 캐시
async function loadKeywords() { /* index_keywords에서 1회 로드·캐시. 빌더가 run 시작 시 호출 */ }

function detectHeaderRow(values)         // _isDataTabRow 스캔 → headerRowIdx (또는 -1)
function resolveColumns(headers)         // → { nameColIdx, recipientColIdx, submitColIdx, paymentColIdx,
                                         //     productColIdx, urlColIdx, phoneColIdx, startDateIdx, endDateIdx, roundIdx }
                                         //   (= 현 indexBuilder.parseTabRows의 슈퍼셋 결정 로직 그대로 이식)
function parseTabRows(values, sheetId, tabName, tabGid, campaignTitle)
                                         // → 슈퍼셋 행 객체 배열(recipientName/isSubmitted2/submitCol2 포함)
                                         //   헬퍼(_isSubmittedValue/_formatDate/_isDataTabRow)도 이 모듈로 이동(동일코드라 안전)
module.exports = { loadKeywords, detectHeaderRow, resolveColumns, parseTabRows, /* 테스트용 헬퍼 */ }
```

핵심: **`parseTabRows`의 본문 = 현재 `indexBuilder.parseTabRows`를 그대로 복사**(슈퍼셋이므로). 따라서 indexBuilder 출력은 100% 동일.

## 3. 빌더 위임 (행위 보존)

- **indexBuilder.service.js**: `parseTabRows`를 `return columnResolver.parseTabRows(...)`로 위임(기존 export 이름 유지 — diag `:3367/:3379`·post-build `:403` 호출부 무변경). 키워드는 build 시작 시 `await columnResolver.loadKeywords()`. **출력 동일 → 무변경.**
- **smartBuild.service.js**: `_parseTabRows`를 `columnResolver.parseTabRows(...)`로 위임. run 시작 시 `loadKeywords()`. 이제 반환에 `recipientName/isSubmitted2/submitCol2` 포함.
  - `_upsertTab`(:336-356) INSERT 컬럼·VALUES·ON CONFLICT SET에 **`recipient_name`, `is_submitted2`, `submit_col2` 추가**(스키마엔 이미 존재, 001). 이것이 smartBuild의 **유일한 동작 변화**(누락 채움 = 개선).

## 4. 검증 (행위 보존 증명이 핵심)

- **골든 테스트(필수)**: 대표 `values`(주문자형/수취인형/입금열 유무/병합헤더/그리드밖 등 케이스) 입력을 ① 통합 전 `indexBuilder.parseTabRows`(git 이전 버전 캡처) ② 신규 `columnResolver.parseTabRows`에 넣어 **출력 deepEqual** → indexBuilder 무변경 증명. smartBuild 경로는 recipient/payment 필드가 **추가로** 채워지는지 확인.
- **키워드 로더 동등성**: `columnResolver.loadKeywords()` 결과 = 기존 두 로더 결과 동일(같은 index_keywords) 1회 확인.
- `node --check` 전 파일 + 회귀(orderLedger/PRB/queuePump/orderRowMatcher) + 순환 require 로드 확인.
- (선택) 스테이징/프로덕션: 강제 전체 재빌드 후 `review_index` 카운트·`recipient_name` 채움률이 떨어지지 않는지(개선이어야).

## 5. 리스크 & 완화

- **R: 키워드 로더 미묘한 차이** → 구현 전 두 로더 SQL·기본값 대조(같은 테이블·같은 카테고리면 안전). 다르면 합집합으로 통일.
- **R: smartBuild upsert 컬럼 추가가 기존 행 영향** → 추가는 가산적. ON CONFLICT SET에 3컬럼 추가 시, indexBuilder가 채운 값을 smartBuild가 (이제 같은 로직으로 계산한) 같은 값으로 덮으므로 진동 없음(통합의 효과). 신규행은 이제 채워짐(개선).
- **R: 핫패스** → G4 락(머지됨)으로 동시성 제거됨. 골든 테스트로 무변경 증명. feature-flag 불요(행위 보존이라). 되돌리기 = 위임 1줄 되돌림.
- **범위 밖(P2b/P2c로)**: DB매핑 우선·re-anchor·col_index 범위가드·체크섬 무효화·saveMapping warn/drop·debug-parse 매핑적용.

## 6. 적용 순서
1. `columnResolver.js` 신규(슈퍼셋 이식 + 헬퍼 이동 + loadKeywords).
2. 골든 테스트 작성(통합 전 indexBuilder 출력 캡처 vs 신규) → 통과 확인.
3. indexBuilder/smartBuild 위임 + smartBuild upsert 3컬럼 추가.
4. node --check·회귀·골든 통과 → 작업 브랜치 → PR → (확인 후) 머지.
> 라이브 핫패스라 PR 머지 전 사용자 확인. P2b는 이 위에서 DB매핑을 한 곳에만 추가.
