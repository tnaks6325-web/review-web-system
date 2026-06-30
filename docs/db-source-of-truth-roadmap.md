# DB 전면 주체(Source of Truth) 전환 로드맵

> 목표(북극성): **서버 DB가 리뷰웹시스템 모든 데이터/컬럼의 단일 진실 원천**이 되고,
> 구글시트는 **하류(downstream) 출력·사람용 거울**로 강등된다.
> 시트에 사람이 직접 한 변경은 **충돌(conflict)로 표면화**하되 DB를 조용히 덮지 않는다(클로버 금지).
> 관리자는 **DB 중심 화면**에서 작업하고, `raw-mirror.html`(시트 거울)은 장기적으로 **DB 원장 뷰어로 수렴**한다.

이 문서는 "큰 그림" 설계다. 각 단계의 상세 설계·구현은 별도로 진행하며, 라이브 핫패스 단계는 **레드-블루-심판 적대적 검증**을 거친다(CLAUDE.md 규칙).

---

## 0. 현재 주체 지도 (조사로 확정된 사실)

| 데이터 | 현재 주체 | 흐름 | 근거 |
|---|---|---|---|
| 구매주문 `order_submissions` | **DB** ✅ | DB→시트(미러) | `orderLedger.service.js`, `submit.routes.js:687` |
| 리뷰제출 `review_submissions` | **DB** ✅ | 업로드→DB | `032_*.sql` |
| 탭설정/캠페인 `tab_configs`/`campaigns` | **DB** ✅ | DB(시트는 발견용 참고) | `tabconfig.routes.js`, `indexScan.service.js` |
| 검색/참여 조회 | **DB** ✅ | DB만(시트 안 읽음) | `search.service.js`, `participation.service.js` |
| **리뷰 인덱스 `review_index`/`index_master`** | **시트** ⚠️ | 시트→DB(빌드) | `indexBuilder.service.js`(시트 읽어 빌드) |
| **컬럼정의(헤더)** | **시트** ⚠️ | 시트→감지 | `sheetHeader.js`, 키워드 감지 |
| RAW 미러 `raw_sheet_rows` | 시트(읽기전용 스냅샷) | 시트→DB | `rawMirror.service.js` (주문 행배정 캐시) |

**핵심:** 절반은 이미 DB 주체다. 뒤집어야 할 *마지막 Sheets-주체 영역*은 **① 컬럼정의 ② 리뷰 인덱스(명단)** 둘이다.

**이미 있는 토대(신규 발명 금지, 재사용):**
- `columnMapping.service.js` + `raw-mirror.html` 매핑 에디터 — 컬럼별 **`owner`(db/sheet/shared)** 저장. → "컬럼별 DB 소유권"의 씨앗.
- 주문 원장의 **DB→시트 푸시 + 가드 패턴**: `buildMirrorGuardRanges`/`guardBlocksWrite`/`invalidateSheetMeta`/`sheet_row_claims` 멱등/큐 throttle. → 충돌 비파괴 미러의 검증된 모델.
- 큐 펌프(이번 머지) — DB→시트 근실시간 반영.
- SSE `broadcast()`, `_triggerSheetMirrorOnce`, `withJobLock` 직렬화.

---

## 1. 설계 불변식 (모든 단계 공통)

1. **per-tab 점진 전환** — `tab_configs.source_of_truth`(enum: `'sheet'`(레거시 기본) → `'db'`(옵트인)). 탭 단위로 켜고, 문제 시 그 탭만 되돌린다. **빅뱅 금지.**
2. **컬럼별 소유권** — `columnMapping.owner`(db/sheet/shared)로 "이 컬럼은 DB가 주인"을 선언. DB-owned 컬럼만 DB→시트 푸시 대상.
3. **비파괴 미러(클로버 금지)** — DB-owned 컬럼을 사람이 시트에서 바꾸면 덮지 않고 `conflict` 표면화 → 관리자 해소. 주문 가드 패턴 재사용.
4. **시트쓰기는 전부 큐+throttle** — �in-place 라이브 쓰기 금지, `order_append` 같은 큐 경유(쿼터 안전, 멱등). 펌프로 근실시간.
5. **되돌리기 가능 + 가산적 마이그레이션** — 컬럼/플래그 추가는 idempotent, 기존 경로는 플래그 off면 그대로.
6. **데이터 손실 0** — 전환 중 어떤 단계도 시트/DB 어느 쪽 데이터도 잃지 않는다(양쪽 보존 후 점진 컷오버).

---

## 2. 단계 로드맵 (과업분해 · 종속성)

```
P0 토대(스키마·플래그·가시성)
   └─> P1 주문 원장 DB-SoT 완성 (beachhead, 이미 DB주체라 최저위험)
          └─> P2 컬럼정의 DB 이관 (read 경로: indexBuilder가 DB매핑 우선)
                 └─> P3 리뷰 인덱스/명단 DB-SoT (가장 큼)
                        └─> P4 통합 DB 원장 뷰어 (raw-mirror 대체 지향)
                               └─> P5 시트=순수 출력 (mirror 경화·raw_sheet_rows 강등)
```
각 단계는 앞 단계의 패턴/스키마에 의존. P1은 P2~P5의 **검증된 템플릿**(DB→시트 푸시·충돌·뷰어) 역할.

---

### P0 — 토대 (엔드포인트/UI 거의 없음, 먼저 안전화)
- 마이그레이션(idempotent):
  - `tab_configs.source_of_truth TEXT NOT NULL DEFAULT 'sheet'` (탭별 옵트인 플래그).
  - 컬럼 소유권 영속화: 기존 `columnMapping`이 쓰는 테이블에 `owner`·`db_field`·`col_type`·`confirmed_at`이 없으면 보강(신규 테이블 신설보다 **기존 매핑 확장**).
- `order_submissions`에 원장 운영 컬럼(주문 원장 문서의 036): `deleted_at`/`source`/`last_edit_seq`/`canceled_by`/`updated_at` — **현재 부재 확인됨**.
- 가시성: "탭별 주체 현황"(어느 탭이 db/sheet인지, 컬럼 소유권 요약) 조회 엔드포인트.
- 산출물 외 영향 없음(읽기/플래그 위주) → 100% 롤아웃 후 다음 단계.

### P1 — 주문 원장 DB-SoT 완성 (beachhead)
업로드해 주신 **"구매주문 원장 인라인 뷰어+편집+취소+수동추가"** 문서를, 앞서 검토한 **교정점 반영**해 진행:
- 교정 ①: `retryAllFailed`는 type 필터가 없어 `order_cancel`이 자동 재시도됨 → **"type 목록 추가" 작업 삭제**.
- 교정 ②: `emitOrderUpdate`는 work_orders 전용 아님 → 전용 `order_ledger` 이벤트 신설 근거를 **"관심사 분리/PII"**로 교정(이벤트 신설 자체는 유지).
- 교정 ③: `raw-mirror.html`은 **offset/limit**이라 "패턴 재사용 + keyset"는 모순 → keyset는 **신규 구현**임을 명시.
- 교정 ④: 새 컬럼매핑 테이블 신설 대신 **기존 `columnMapping` 확장**.
- 나머지(2단계 PR-A 경화→PR-B 기능, feature-flag, 가드·멱등·충돌(`conflict`) 모델)는 유효 → 그대로.
- **의의:** 이미 DB-주체인 도메인에서 *DB편집→시트푸시→충돌비파괴* 전 흐름을 가장 낮은 위험으로 완성·검증 → P2~P5의 재사용 템플릿 확보.

### P2 — 컬럼정의 DB 이관 (Sheets-주체 #1 제거)
- `indexBuilder`/`getCachedHeaders`가 **DB 컬럼매핑(owner/col_type/col_index)을 우선** 사용하고, **시트 헤더 감지(`detectSheetHeader`)는 미매핑 탭의 부트스트랩으로만** 격하.
- 관리자가 `raw-mirror.html` 매핑 에디터(이미 존재)에서 컬럼 확정 → `confirmed_at` 기록. 확정 후엔 **시트 헤더 이름이 바뀌어도 인덱싱이 안 깨짐**(no_name_col·키워드 감지 취약성 해소).
- 효과: "컬럼이 무엇인가"의 주체가 DB로 이동. read 경로부터 안전하게 전환(쓰기 흐름 불변).

### P3 — 리뷰 인덱스/명단 DB-SoT (가장 큰 부분, 적대적 검증 필수)
가장 어려운 지점: **리뷰어 명단을 지금은 사람이 시트에 직접 입력**한다. 두 하위 옵션(탭별 선택 가능):
- **(3a) DB-정본 + 시트 인제스트 + 충돌**: 시트에서 계속 받아들이되, 첫 인제스트 후 **DB 행이 정본**. 이후 DB-owned 컬럼의 시트 변경은 **`conflict`로 표면화**(재빌드가 조용히 덮지 않음). `review_index`를 "재빌드 캐시"에서 "원장"으로 승격. → 운영변화 최소, 점진 적합. **기본 권장.**
- **(3b) DB-입력 → 시트 푸시**: 관리자가 DB UI에서 명단을 추가/관리 → 시트로 푸시. 시트는 순수 출력. → 완전한 DB-주체지만 운영 흐름(시트에 명단 붙여넣기) 변경 큼.
- `search.service.js`/`participation.service.js`는 이미 DB(`review_index`)만 읽으므로 **읽기측 변경 작음**. 쓰기측(빌드/충돌)이 핵심.
- 라이브·되돌리기 어려움 → **레드-블루-심판 + 탭별 플래그 + 양쪽 보존 컷오버.**

### P4 — 통합 DB 원장 뷰어 (raw-mirror 대체 지향)
- 탭별 DB-정본 데이터(명단 + 주문 + 리뷰상태)를 보고 편집하면 시트로 푸시하는 **DB 중심 그리드**. P1 주문 뷰어 + `columnMapping` + `order_ledger` SSE 패턴 재사용.
- `raw-mirror.html`은 **"시트 드리프트/충돌 점검·디버그"** 역할로 축소(데이터 소스가 아니라 *대조* 도구).

### P5 — 시트 = 순수 출력 (mirror 경화)
- 모든 DB-owned 컬럼 **DB→시트 단방향 푸시**(큐+throttle+가드). 사람의 시트 편집은 충돌 감지만.
- `raw_sheet_rows`를 **행배정 데이터 소스에서 강등** → DB 슬롯 추적(`order_submission_slots` 류)으로 빈 행 계산(시트 읽기 불요). RAW 미러는 "충돌 감지용 드리프트 스냅샷"으로만.

---

## 3. 횡단 관심사
- **충돌 모델(클로버 금지):** DB-owned 컬럼의 시트 인편집 → `conflict` 상태 + 관리자 해소 UI(주문 원장의 `conflict` 처리 재사용). 절대 자동 덮어쓰기 금지.
- **쿼터/근실시간:** 모든 시트쓰기는 큐+`sheetsThrottle`(45/분)+펌프. 대량 전환은 백로그 드레인(`queue-drain`).
- **권한:** DB-주체 편집/충돌해소는 `adminOrMasterMiddleware`(staff 차단, PII).
- **되돌리기:** 단계·탭별 플래그로 즉시 'sheet' 복귀. 마이그레이션 가산적.
- **적대적 검증:** P3·P5(되돌리기 어려운 핫패스)는 구현 전 red-blue-judge 필수. P1·P2도 in-place 쓰기 부분은 검토.

## 4. 리스크 & 트레이드오프
- **R1 명단 출처 전환(P3)** 이 가장 큰 운영 변화 — 시트에 익숙한 운영자의 워크플로 충돌. → 3a(시트 인제스트 유지+충돌)로 충격 완화, 탭별 점진.
- **R2 양방향 충돌 폭증** — 사람이 시트를 자주 고치는 탭은 conflict가 잦을 수 있음. → 컬럼 owner를 `shared`로 두면 그 컬럼은 충돌 면제(사람 우선) 등 세분화.
- **R3 전환 기간 이중 정본** — DB·시트가 잠시 둘 다 "정본처럼" 보임. → per-tab 플래그로 한쪽만 정본, 반대쪽은 미러로 명시.
- **R4 쿼터** — 대량 푸시가 버스트. → 큐+throttle+드레인, 라이브 이벤트 중 자제.

## 5. 다음 액션(제안)
1. **P0 + P1**을 첫 실행 묶음으로 상세 설계·구현(주문 원장 문서 교정본). ← 가장 안전하고 즉시 가치.
2. P2(컬럼정의 DB 이관)는 P1 패턴 확정 후 착수.
3. P3는 별도 상세설계 + 적대적 검증 세션으로 분리(범위·운영영향 큼).

> 작업 브랜치/배포는 단계별로 분리하고, 각 단계 머지 전 사용자 확인(라이브 핫패스·되돌리기 어려움 → CLAUDE.md "주의" 적용).
