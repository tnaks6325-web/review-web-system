# 설계안 — 리뷰제출 경로 DB 원장화 (남은 Sheets 쿼터 제거)

> 상태: **설계안(구현 아님)** · 2026-06-26 · 선행: order-ledger(PR #135) 패턴 재사용
> 목적: 구매폼에 이어 **리뷰제출 경로의 구글 Sheets 직접 read/write를 제거**해 마지막 쿼터 소비원을 없앤다.

---

## 1. 목적 · 범위

구매폼은 order-ledger로 시트 읽기를 제거했다. 리뷰제출도 같은 원칙(**DB 1차 원장 + 시트는 비동기 미러**)으로 정렬해, 아침 동시 제출 시 **시트 헤더 읽기/마커 쓰기로 인한 쿼터 소비를 0에 수렴**시킨다.

**범위**: 리뷰 "제출 마커"(제출칸 값)와 비고 쓰기의 시트 의존 제거 + 상태 즉시성. **범위 밖**: 캡처 이미지 업로드(이건 Drive 쿼터이지 Sheets 아님 — 별도), 결제/입금 경로.

---

## 2. 현재 상태 (codex 브랜치 기준, 정확 진단)

리뷰제출은 **이미 상당 부분 DB-우선**이다:
- `POST /api/submit/review`가 **`review_index.is_submitted=TRUE`를 DB에서 즉시 설정**(다중 캡처 슬롯은 `review_submissions.slot_key` + `tab_configs.capture_slots`로 완료 판정). → UI 즉시 반영 OK.
- 캡처 파일 원장 `review_submissions`(032)는 DB. 업로드는 Drive.

**남은 Sheets 의존(= 제거 대상)**:
1. `POST /review` 백그라운드에서 **제출칸 마커 + 비고**를 시트에 쓸 때, 헤더를 찾으려 매번 시트를 읽음(`getCachedHeaders`가 캐시하지만 미스 시 `A1:ZZ50` 읽기).
2. 큐 `review_submit` 재시도 핸들러가 **매 재시도마다 `'tab'!1:50`을 읽어** 헤더에서 `submitCol` 위치를 찾음(쿼터 소비·동시폭주 시 가중).
3. `smartBuild`가 시트에서 `is_submitted`를 재계산 → **DB에서 먼저 TRUE로 둔 값을 시트 미반영분에 대해 되돌릴(clobber) 위험**.

---

## 3. 제안 설계

### 3.1 헤더 해석을 RAW 미러로 (시트 읽기 제거)
- order-ledger가 채우는 `raw_sheet_tabs.detected_headers`(+`header_row_index`)를 **제출칸/비고칸 컬럼 인덱스 해석에 재사용**.
- `POST /review` 백그라운드와 큐 `review_submit` 양쪽에서 `loadRawTabContext(sheetId, gid, tabName)`로 헤더를 얻어 `submitCol`/비고 컬럼 letter를 계산 → **`1:50` 읽기 제거**.
- RAW 메타가 없으면 order-ledger와 동일하게 **해당 탭 1회 라이브 폴백**(`loadRawTabContextFromSheet`) 후 진행.

### 3.2 제출 마커 쓰기를 미러 큐로 일원화 (+ 가드)
- `POST /review`는 **DB 확정(이미 함) 후 즉시 응답**하고, 제출칸 마커/비고 쓰기는 항상 `sync_queue`의 `review_submit`로 비동기.
- 큐 `review_submit`은 order-append처럼 **쓰기 직전 타겟 셀 1칸 가드 readSheet**로 외부 기입 덮어쓰기 방지(여기 가드 대상 = 제출칸; `guardBlocksWrite`로 "내가 쓴 값이면 멱등 통과"). → 본 PR(#135-후속)에서 만든 `guardBlocksWrite` 재사용.
- 미러 상태 추적: 행 단위 `review_index`에 마커 미러 상태를 두기보다, **제출 단위로 추적**이 자연스러우므로 옵션 검토:
  - (A) `review_index`에 `mark_mirror_status`/`mark_sheet_error` 컬럼 추가(행 1개당 1마커 → 단순).
  - (B) `review_submissions`(슬롯 단위)에 `mark_mirror_status` 추가(다중 슬롯 정밀 추적). → 다중 캡처 슬롯 탭이면 (B)가 정확.
  - **권장**: 행 마커는 1개이므로 **(A)** 로 단순화하고, 다중 슬롯 완료 판정은 기존 `review_submissions.slot_key` 로직 유지.

### 3.3 smartBuild 재조정 우선순위 (clobber 방지)
- 시트가 더 이상 1차 원장이 아니므로, **DB의 `is_submitted=TRUE`가 시트보다 우선**해야 한다.
- smartBuild의 `review_index` upsert에서 `is_submitted`를 **`OR`(시트값 OR 기존DB값)** 로 보존하거나, "미러 대기(`mark_mirror_status='pending'/'queued'`)인 행은 시트값으로 FALSE 덮어쓰기 금지" 규칙 추가.
- 이게 빠지면 "제출 직후 DB=TRUE → 다음 smartBuild가 시트 미반영 보고 FALSE로 되돌림 → 리뷰어 이름 다시 사라짐" 회귀가 난다(주의).

---

## 4. 데이터 모델 변경(스케치, 멱등 마이그레이션)

```sql
-- 036_review_mirror_status.sql (예시, 모두 additive)
ALTER TABLE review_index
  ADD COLUMN IF NOT EXISTS mark_mirror_status TEXT DEFAULT 'none',  -- none|pending|queued|written|failed
  ADD COLUMN IF NOT EXISTS mark_sheet_error   TEXT,
  ADD COLUMN IF NOT EXISTS mark_written_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_review_index_mark_status
  ON review_index(mark_mirror_status) WHERE mark_mirror_status IN ('pending','queued','failed');
```
- 기존 테이블/큐(`sync_queue`,`review_submissions`,`raw_sheet_tabs.detected_headers`) 재사용 → 신규 테이블 불필요.

---

## 5. 영향 받는 코드 (구현 시)

| 파일 | 변경 |
|---|---|
| `routes/submit.routes.js` `POST /review` | 헤더 1:50 읽기 제거 → RAW 헤더 사용. 마커/비고 쓰기를 항상 큐로. `mark_mirror_status='queued'` 기록 |
| `services/syncQueue.service.js` `review_submit` | `loadRawTabContext`로 헤더 해석, 가드 readSheet 1칸, 성공 시 `mark_mirror_status='written'` |
| `services/orderLedger.service.js` (or 신규 `reviewLedger`) | `buildMirrorGuardRange`/`guardBlocksWrite`/`loadRawTabContext` 재사용(공유 모듈로 승격 고려) |
| `services/smartBuild.service.js` | `is_submitted` 보존 규칙(DB TRUE/미러대기 우선) |
| `migrations/036_*.sql` | 위 컬럼 추가 |

---

## 6. 엣지 케이스

- **다중 캡처 슬롯**: 완료 판정은 기존 `review_submissions.slot_key` vs `capture_slots` 유지. 마커 미러는 "완료(complete)된 행"에만 큐잉.
- **재제출/멱등**: 가드 `guardBlocksWrite`가 자기 마커값과 같으면 통과 → 재시도 안전.
- **비고(memo)**: 같은 RAW 헤더로 컬럼 해석. 마커와 한 배치로 묶어 쓰기.
- **RAW 미러 stale**: order-ledger와 동일 위험(최대 5분). 가드가 1차 방어, smartBuild가 최종 정합.
- **마커 컬럼명이 탭마다 다름**: `submitCol`은 프론트가 보내므로 RAW 헤더에서 정확 매칭. 미발견 시 라이브 폴백 후에도 없으면 `mark_mirror_status='failed'` + 진단 노출.

---

## 7. 리스크 · 롤아웃

- **최대 리스크**: §3.3 smartBuild clobber. 이 보존 규칙을 **먼저** 넣지 않으면 이름 재소멸 회귀. → 구현 1순위.
- 점진 적용: ① RAW 헤더로 읽기 제거(무행동 변화) → ② 마커 미러 큐 일원화 + 가드 → ③ smartBuild 보존 규칙 → ④ 모니터링(`mark_mirror_status`별 집계 진단 API).
- 검증: 스테이징에서 동시 리뷰제출 + 마커 미러 지연/실패 + smartBuild 1주기 후 `is_submitted` 유지 확인.

---

## 8. 범위 밖(후속)
- 캡처 업로드 SA 저장 403(ⓓ, Drive 쿼터) — 별건.
- 입금/결제 경로 DB화.
- `sheet_row_claims`/원장 보존정리(TTL) 잡.

---

### 한 줄 요약
리뷰제출은 이미 `is_submitted`가 DB-즉시라 **남은 건 "제출칸 마커 쓰기"의 헤더 읽기 제거(RAW 헤더 재사용) + 미러 큐 일원화(+가드) + smartBuild가 DB의 TRUE를 되돌리지 않게 하는 보존 규칙"** 세 가지다. 신규 테이블 없이 order-ledger 자산을 그대로 재사용한다.
