# 📡 inadd 인트라넷 ↔ 리뷰웹시스템 작업오더 연동 명세 (inadd-webapp 작업용)

> 이 문서는 **inadd-webapp(인트라넷) 개발 세션**에 전달하는 연동 스펙입니다.
> 리뷰웹시스템(review-web, 백엔드 = Railway) 쪽 작업은 **완료·배포·검증된 상태**이고,
> 인트라넷 쪽에서 아래 2가지를 구현하면 연동이 완성됩니다.
>
> 1. **오더 보내기** — AE가 작성한 리뷰작업요청을 리뷰웹으로 제출
> 2. **보낸 오더 관리** — 제출한 오더의 현재 진행상태 조회/표시

---

## 0. 배경 / 데이터 흐름

```
[inadd 인트라넷 (AE)]                         [리뷰웹시스템 (관리자)]
  작업오더 작성 폼 ──POST /api/order/intake──▶  work_orders 저장(status=submitted)
                                                  └▶ 관리자 화면 신규요청 팝업 + 인박스
  보낸 오더 목록  ◀─GET /api/order/intake/list──  현재 상태(검토중/발행/완료 등) 반환
```

- 리뷰웹 관리자는 받은 오더를 검토 → 모집공고로 발행 → 완료까지 **상태머신**으로 관리합니다.
- 인트라넷은 그 **status** 를 조회해 AE에게 "내 오더 어디까지 진행됐나"를 보여줄 수 있습니다.

---

## 1. 엔드포인트 (리뷰웹 백엔드 — 이미 배포됨)

- **Base URL**: `https://sublime-magic-production-790b.up.railway.app`
- **인증**: 공유 시크릿. 헤더 `X-Intake-Key: <KEY>` (또는 body `intakeKey` / 쿼리 `intakeKey`)
- **KEY 값**: Railway 환경변수 `ORDER_INTAKE_KEY` 와 동일한 값.
  → 보안상 이 문서에는 적지 않습니다. **별도 보안 채널로 전달받은 값**을 사용하세요.
- **CORS**: `inadd-system.pages.dev`(및 `*.inadd-system.pages.dev` 프리뷰) 이미 허용됨. `X-Intake-Key` 헤더 허용됨.

### 1-A. 오더 제출 — `POST /api/order/intake`

요청 (JSON):
```json
{
  "intakeKey": "<KEY>",            // 또는 헤더 X-Intake-Key
  "requester_name": "한가람",       // 요청자(AE) 이름 → 리뷰웹 created_by 에 저장
  "title": "A브랜드 선크림 실배송",   // 필수
  "work_sheet_url": "https://docs.google.com/.../edit#gid=123",  // 필수
  "start_date": "2026-06-10",
  "product_option": "• 티셔츠  https://shop/ts\n   - 블랙/라지: 10,000원 × 20건 = 200,000원\n   소계: 20명 / 200,000원",
  "product_options_json": "[{\"name\":\"티셔츠\",\"url\":\"https://shop/ts\",\"options\":[{\"label\":\"블랙/라지\",\"pay\":10000,\"count\":20}],\"subtotal\":{\"count\":20,\"pay\":200000}}]",
  "daily_count_text": "3~7",
  "pay_amount": 23900,
  "daily_count": 10,
  "purchase_time": "10시~14시",
  "inflow_type": "guide",          // 'guide'(유입가이드) | 'link'(링크유입)
  "inflow_guide": "<div>키워드 검색 후 구매</div><img src=\"https://drive.google.com/thumbnail?id=...\">",  // inflow_type='guide'일 때만, 이미지 포함 HTML
  "delivery_type": "실배송",
  "courier_proxy": false,
  "review_type": "전체포토",
  "recruit_count": 30,
  "review_guide": "...",
  "special_notes": "...",
  "product_url": "https://...",
  "goods_cost_type": "현금"
}
```

응답:
- `200` → `{ "ok": true, "data": { "id": "wo_xxxx", "status": "submitted", ... } }`
  - 반환된 `data.id` 를 인트라넷이 보관하면 이후 상태 추적이 쉬움.
- `400` → 필수값 누락 `{ "ok": false, "error": "..." }`
- `401` → 키 불일치
- `503` → 서버에 키 미설정

### 1-B. 보낸 오더 조회 — `GET /api/order/intake/list`

- 쿼리: `?requester=한가람` (특정 AE 것만) — 생략 시 전체(LIMIT 200, 최신순)
- 인증: 헤더 `X-Intake-Key` 또는 `?intakeKey=<KEY>`

응답:
```json
{
  "ok": true,
  "data": [
    {
      "id": "wo_390629c0cc5e",
      "title": "연동 테스트 오더",
      "status": "submitted",
      "created_by": "한가람",
      "recruit_count": 30,
      "start_date": "2026-06-10",
      "work_sheet_url": "...",
      "linked_campaign_id": "",   // 모집공고로 발행되면 연결된 캠페인 id
      "chat_room_url": "",        // 채팅방 URL(있으면)
      "admin_memo": "",           // 관리자가 [전송]한 처리 메모/보완 사유 (인트라넷에 표시용)
      "created_at": "2026-06-08T13:10:56.489Z",
      "updated_at": "2026-06-08T13:10:56.489Z"
    }
  ]
}
```

> 목록은 **요약 필드만** 내려줍니다(상품/리뷰/유입가이드 등 상세 제외). 과거 오더의 상세 복원이 필요하면 아래 1-B' 단건 상세 조회를 사용하세요.

### 1-B'. 보낸 오더 단건 상세 — `GET /api/order/intake/:id`

- 경로: `GET /api/order/intake/{order_id}`  (예: `/api/order/intake/wo_390629c0cc5e`)
- 인증: 헤더 `X-Intake-Key` 또는 `?intakeKey=<KEY>`
- 반환: 해당 오더의 **전체 필드**(2번 스키마 전체 + `memo_log`, `deleted_at` 등). 상품/옵션·리뷰가이드·유입가이드·특이사항까지 복원 가능.
- 삭제(soft delete)된 오더도 **복원 목적상 반환**하며 `deleted_at` 으로 상태 식별. 없는 id → `404`.

```bash
curl -i "https://sublime-magic-production-790b.up.railway.app/api/order/intake/wo_xxxx" \
  -H "X-Intake-Key: <키>"
```
```json
{ "ok": true, "data": { "id":"wo_xxxx", "title":"...", "product_option":"...", "product_options_json":"...",
  "review_guide":"...", "inflow_type":"guide", "inflow_guide":"...<img ...>", "special_notes":"...",
  "pay_amount":9900, "recruit_count":15, "status":"reviewing", "deleted_at":null, "...": "전체 필드" } }
```

### 1-C. 유입가이드 이미지 업로드 — `POST /api/order/guide-image`

유입가이드 이미지를 **인트라넷·리뷰웹 공용 전용 Drive 폴더에 "비공개"로 저장**하고, **리뷰웹 프록시 URL**을 받습니다. Drive 파일은 공개되지 않고(anyone 링크 X), 리뷰웹 서버가 자기 자격증명으로 꺼내 스트리밍합니다.

- 인증: 헤더 `X-Intake-Key`(인트라넷) 또는 JWT(내부). intake 키 그대로 사용 가능.
- 요청(JSON): `{ "imageBase64": "data:image/jpeg;base64,...", "mimeType": "image/jpeg", "fileName": "guide.jpg" }`
- 응답: `{ "ok": true, "id": "<driveFileId>", "url": "https://<리뷰웹>/api/order/guide-image/<id>", "viewUrl": "<동일 프록시>" }`
  - **반환된 `url` 을 그대로** `inflow_guide`에 넣으세요(`<img src>` 또는 본문 텍스트 어디든). 리뷰웹이 이미지로 렌더합니다.
- 저장 위치: env `GUIDE_FOLDER_ID`(지정 시 그 폴더) 또는 `AI_REVIEW_FOLDER` 하위 `[유입가이드]` 자동. → **하나의 전용 공용 폴더**에 누적.
- 권장: 업로드 전 클라이언트에서 **리사이즈/JPEG 압축**(최대 1600px) — 제공 키트에 구현됨.

> 흐름: 이미지 첨부 → `guide-image`로 업로드(비공개 저장) → **프록시 URL** 수신 → `inflow_guide`에 그 URL 포함 → 오더 제출 → 리뷰웹 관리자 화면이 서버에서 꺼내 이미지로 표시.
> 보안: Drive 원본은 비공개. 표시는 리뷰웹 프록시(`/api/order/guide-image/:id`)를 통해서만. (프록시 URL의 `id`는 추측 불가한 Drive fileId)
> 참고: 리뷰웹은 인트라넷이 보내는 **평문 + URL** 형태의 `inflow_guide`도 URL을 자동으로 이미지/링크로 렌더합니다(과거 Drive 공개 URL도 호환).

---

## 1-D. 옵션 처리 규약 (상품/옵션 → 합계)

인트라넷에서 옵션 유무에 따라 합계를 계산해 전달하고, 리뷰웹은 그 합계값을 그대로 사용한다.

- **옵션 없음**: 상품 결제금액 × 건수 → 모집인원/구입비
- **옵션 있음**: 상품 기본 결제금액/건수는 무시, **옵션별 결제금액/건수만** 합산

리뷰웹으로 전달되는 값:
| 필드 | 의미 |
|---|---|
| `product_option` | 상품명·상품URL·옵션명/값·결제금액·건수·소계 **요약(여러 줄 텍스트)** — 리뷰웹이 사람이 보도록 그대로 표시 |
| `recruit_count` | **최종 모집인원 합계** |
| `pay_amount` | **총 상품구입비 합계** |
| `product_url` | 첫 번째 상품 URL |
| `special_notes` | 일일 진행건수·구매시간대·배송유형·리뷰유형·물건비·상품요약 등 포함(여러 줄) |

> 리뷰웹 관리자 화면은 `product_option`/`special_notes`를 **줄바꿈 그대로 + URL 링크화**해 표시하고, `recruit_count`/`pay_amount`는 합계값으로 노출한다. (계산은 인트라넷에서 완료)

---

## 1-E. 정밀 매핑 주의 (인트라넷이 맞춰야 할 4가지)

리뷰웹이 모든 항목을 정확한 칸으로 받으려면 인트라넷 전송 페이로드를 아래로 맞춰주세요.

1. **유입방식 필드명**: `inflow_keyword`(구) ❌ → **`inflow_type`**(`guide`/`link`) + **`inflow_guide`** ✅
   - (호환) 리뷰웹은 `inflow_keyword`가 와도 값 자체는 보존·표시하지만, `유입가이드/링크유입` 구분은 `inflow_type`이 있어야 정확.
2. **유입가이드 이미지**: `review_guide`에 base64 텍스트로 넣기 ❌ → **`inflow_guide`** 에 넣기 ✅
   - 권장: `POST /api/order/guide-image`로 업로드 후 받은 URL을 `<img src>`로 삽입(1-C).
   - (호환) base64 `<img src="data:...">`를 `inflow_guide`에 직접 넣어도 리뷰웹이 이미지로 렌더함(단 DB·전송 무거움 → URL 권장).
3. **일일건수 범위**: 범위(예 `3~7`)는 `daily_count`(정수)에 최소값만 들어가 손실 → **`daily_count_text`** 에 원문 전송 ✅ (리뷰웹이 화면에 우선 표시)
4. **상품/옵션 구조화**: `product_option`(요약 문자열)은 그대로 두고, 통계/필터가 필요하면 **`product_options_json`**(문자열화 JSON)도 함께 전송 ✅

> 위 4개 필드(`inflow_type`,`inflow_guide`,`daily_count_text`,`product_options_json`)는 리뷰웹 intake가 이미 수신·저장하도록 배포됨. 리뷰웹 제공 키트(`inadd-order-kit.html`)는 이 규약대로 전송하도록 구현되어 있어 참고용으로 사용 가능.

---

## 1-F. 처리메모 Webhook (리뷰웹 → 인트라넷 push)  ★ 인트라넷 구현 요청

관리자가 작업오더에서 **처리메모/보완사유를 [전송]** 하면, 리뷰웹이 **인트라넷 수신 URL로 즉시 POST** 합니다.
인트라넷은 아래 규격의 수신 엔드포인트를 만들어 URL을 알려주세요.

- **인트라넷이 만들 것**: `POST <인트라넷>/api/review-memo` (경로 자유)
- **인증**: 헤더 `X-Review-Key: <공유시크릿>` 검증 (리뷰웹이 보냄). 값은 양측이 합의해 공유.
- **요청 body(JSON)** — 리뷰웹이 보내는 형식:
  ```json
  {
    "order_id": "wo_xxxx",
    "title": "오더 제목",
    "requester_name": "한가람",     // 이 오더를 보낸 AE (created_by)
    "status": "reviewing",
    "memo": "사진 더 필요합니다(보완요청)",
    "sent_by": "관리자김",          // 메모 보낸 리뷰웹 관리자
    "sent_at": "2026-06-09T05:00:00.000Z"
  }
  ```
- **응답**: `200`(+아무 body)면 전송 성공으로 간주. 그 외 상태코드는 실패 처리.
- **타임아웃**: 8초.

리뷰웹 Railway env 2개 설정 필요(인트라넷 URL/키 수령 후):
- `INTRANET_MEMO_WEBHOOK_URL = https://<인트라넷>/api/review-memo`
- `INTRANET_WEBHOOK_KEY = <공유시크릿>`

> webhook 미설정/실패 시에도 메모는 리뷰웹에 저장되고 `intake/list`의 `admin_memo`로 폴링 조회는 가능(폴백).

---

## 1-G. 작업오더 삭제 (양방향 동기화)

삭제는 어느 쪽에서 시작해도 양쪽 모두 사라지도록 동기화한다. (soft delete — 리뷰웹은 행을 보존하고 목록/조회에서만 제외)

### ① 인트라넷 → 리뷰웹  (인트라넷에서 "보낸 오더" 삭제 시)

- **호출**: `DELETE <리뷰웹>/api/order/intake/:id`
- **인증**: 헤더 `X-Intake-Key: <ORDER_INTAKE_KEY>` (등록/조회와 동일 키)
- **body(선택)**: `{ "deleted_by": "username", "deleted_by_name": "표시명" }`
- **응답**: `{ "ok": true, "id": "wo_xxxx" }` · 이미 삭제됨 → `{ "ok": true, "id": "...", "alreadyDeleted": true }`(멱등) · 없는 id → `404`
- 권한(관리자/등록자 본인) 확인은 **인트라넷 측에서 선행**.

```bash
curl -i -X DELETE "https://sublime-magic-production-790b.up.railway.app/api/order/intake/wo_xxxx" \
  -H "X-Intake-Key: <키>" -H "Content-Type: application/json" \
  -d '{"deleted_by":"aekim","deleted_by_name":"김AE"}'
```

### ② 리뷰웹 → 인트라넷  (리뷰웹 인박스에서 삭제 시)  ★ 인트라넷 구현 요청

리뷰웹 관리자가 인박스에서 삭제하면, 리뷰웹이 인트라넷으로 삭제 이벤트를 push 한다.

- **인트라넷이 만들 것**: `POST <인트라넷>/api/review-order-deleted` (경로 자유)
- **인증**: 헤더 `X-Review-Key: <공유시크릿>` 검증 (메모 webhook과 동일 키)
- **요청 body(JSON)** — 리뷰웹이 보내는 형식:
  ```json
  {
    "event": "order_deleted",
    "order_id": "wo_xxxx",
    "title": "오더 제목",
    "requester_name": "한가람",
    "deleted_by": "관리자김",
    "deleted_at": "2026-06-11T05:00:00.000Z"
  }
  ```
  → 인트라넷은 `order_id`로 해당 "보낸 오더"를 삭제 처리.
- **응답**: `200`이면 전송 성공으로 간주. 타임아웃 8초.

리뷰웹 Railway env 1개 추가 필요(인트라넷 URL 수령 후, 키는 메모와 공유):
- `INTRANET_ORDER_DELETE_WEBHOOK_URL = https://<인트라넷>/api/review-order-deleted`
- `INTRANET_WEBHOOK_KEY = <공유시크릿>`  (1-F 메모 webhook과 동일)

> webhook 미설정/실패 시에도 리뷰웹 쪽 삭제는 적용됨(인트라넷 전파만 누락). 이 경우 인트라넷은 `intake/list`로 폴링하면 해당 오더가 빠진 것을 확인 가능(폴백).

---

## 2. 필드 스키마 (work_orders)

| 필드 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| title | string | ✅ | 작업명 |
| work_sheet_url | string | ✅ | 작업시트 탭 URL |
| requester_name | string | (권장) | 요청자(AE) 이름 → `created_by` 저장. 없으면 "인트라넷" |
| start_date | string(YYYY-MM-DD) | | 시작일 |
| product_option | string | | 상품/옵션 요약(여러 줄 텍스트) — 사람이 보도록 표시 |
| product_options_json | string(JSON) | | (선택) 상품/옵션 구조화 데이터 — 표/필터/통계용. 문자열화한 JSON |
| pay_amount | number | | 결제금액(숫자) |
| daily_count | number | | 일일 진행 건수(정수). 범위면 최소/대표값 |
| daily_count_text | string | | (선택) 일일 진행건수 원문(예: `"3~7"`) — 범위 보존용. 있으면 화면에 우선 표시 |
| purchase_time | string | | 구매 시간대 |
| inflow_type | string | | 유입방식: `guide`(유입가이드) / `link`(링크유입) |
| inflow_guide | string(HTML) | | 유입가이드 본문 — 텍스트 + 이미지(`<img src=Drive URL>`). `inflow_type='guide'`일 때만 |
| delivery_type | string | | 배송유형(실배송/빈박스 등) |
| courier_proxy | boolean | | 빈박스 택배대행 여부 |
| review_type | string | | 리뷰유형 |
| recruit_count | number | | 모집인원 |
| review_guide | string | | 리뷰등록 가이드 |
| special_notes | string | | 특이사항 |
| product_url | string | | 상품확인용 URL |
| goods_cost_type | string | | 물건비(현금/계산서 등) |

---

## 3. 상태값(status) → 화면 라벨 매핑

조회 결과의 `status` 를 아래처럼 보여주면 됩니다(리뷰웹 상태머신 기준):

| status | 라벨(예시) | 의미 |
|---|---|---|
| `submitted` | 접수됨 | 인트라넷에서 막 제출됨(관리자 인박스 대기) |
| `reviewing` | 검토중 | 관리자가 검토 시작 |
| `await_chatroom` | 채팅방대기 | 발행 직전(채팅방 준비) |
| `published` | 발행/모집중 | 모집공고로 발행됨 (`linked_campaign_id` 연결) |
| `done` | 완료 | 종료 |
| `rejected` | 반려 | 관리자 반려 |
| `revision` | 보완요청 | AE 보완 후 재제출 필요 |

```js
const STATUS_LABEL = {
  submitted:'접수됨', reviewing:'검토중', await_chatroom:'채팅방대기',
  published:'발행/모집중', done:'완료', rejected:'반려', revision:'보완요청',
};
```

---

## 4. 권장 구현 방식

### (1) 시크릿 키 보관 — 둘 중 택1
- **권장: 서버측 프록시** — 키를 inadd 백엔드(inadd-finance-server) 환경변수에 두고,
  인트라넷 프론트는 자기 백엔드로만 요청 → 백엔드가 키를 붙여 리뷰웹으로 중계.
  → 키가 브라우저에 노출되지 않음. (아래 4-(3) 스니펫)
- **간편: 프론트 직접** — 인트라넷 프론트가 직접 `X-Intake-Key` 붙여 호출.
  → 인트라넷이 접근제한(403)이라 위험은 완화되지만 키가 클라이언트 JS에 보임.
  (리뷰웹 팀이 제공한 `review-order.html` 키트가 이 방식)

### (2) "보낸 오더 관리" 화면
- `GET /api/order/intake/list?requester=<로그인AE>` 를 주기적으로(또는 새로고침 시) 호출
- 각 행에 `STATUS_LABEL[status]` 뱃지 + 작업명 + 시작일 표시
- 제출 시 받은 `data.id` 를 인트라넷 DB에 저장해두면 매핑/중복관리 용이(선택)

### (3) 서버측 프록시 예시 (inadd-finance-server / Node·Express)
```js
// .env: REVIEW_INTAKE_KEY=<KEY>,  REVIEW_API_BASE=https://sublime-magic-production-790b.up.railway.app
app.post('/api/review-order', requireLogin, async (req, res) => {
  const r = await fetch(process.env.REVIEW_API_BASE + '/api/order/intake', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-Intake-Key': process.env.REVIEW_INTAKE_KEY },
    body: JSON.stringify({ ...req.body, requester_name: req.user.name }),  // 서버가 AE 이름 강제
  });
  res.status(r.status).json(await r.json());
});

app.get('/api/review-order/list', requireLogin, async (req, res) => {
  const url = process.env.REVIEW_API_BASE + '/api/order/intake/list?requester=' + encodeURIComponent(req.user.name);
  const r = await fetch(url, { headers:{ 'X-Intake-Key': process.env.REVIEW_INTAKE_KEY } });
  res.status(r.status).json(await r.json());
});
```
→ 프론트는 `POST /api/review-order`, `GET /api/review-order/list` 만 호출(키 없음).

### (4) 프론트 직접 호출 예시 (간편 방식)
```js
// 제출
await fetch('https://sublime-magic-production-790b.up.railway.app/api/order/intake', {
  method:'POST',
  headers:{ 'Content-Type':'application/json', 'X-Intake-Key': INTAKE_KEY },
  body: JSON.stringify({ requester_name, title, work_sheet_url, /* ...나머지 필드 */ }),
});
// 조회
const res = await fetch(
  'https://sublime-magic-production-790b.up.railway.app/api/order/intake/list?requester=' + encodeURIComponent(name),
  { headers:{ 'X-Intake-Key': INTAKE_KEY } }
);
const { data } = await res.json();
```
> 리뷰웹 팀이 제공한 `review-order.html` 은 이 (4) 방식의 완성 폼(제출)입니다. 조회 화면만 추가하면 됩니다.

---

## 5. 빠른 검증 (curl)
```bash
# 제출 (200 + {"ok":true})
curl -i -X POST https://sublime-magic-production-790b.up.railway.app/api/order/intake \
  -H "Content-Type: application/json" -H "X-Intake-Key: <KEY>" \
  -d '{"requester_name":"테스트AE","title":"연동테스트","work_sheet_url":"https://x#gid=1"}'

# 조회 (200 + 목록)
curl -i "https://sublime-magic-production-790b.up.railway.app/api/order/intake/list?requester=테스트AE" \
  -H "X-Intake-Key: <KEY>"
```

---

## 6. 체크리스트 (inadd-webapp 세션)
- [ ] 시크릿 키 보관 방식 결정 (서버측 프록시 권장)
- [ ] 오더 제출 폼/화면 (제공된 `review-order.html` 키트 활용 가능)
- [ ] 제출 성공 시 받은 `id` 보관(선택) + 사용자 피드백
- [ ] "보낸 오더" 목록 화면 — `intake/list` 조회 + `STATUS_LABEL` 뱃지
- [ ] 인트라넷 메뉴에 진입 링크 추가
- [ ] 배포 후 실제 제출 → 리뷰웹 관리자 인박스에 뜨는지 확인
- [ ] "보낸 오더" 삭제 → `DELETE /api/order/intake/:id` 호출 (1-G ①)
- [ ] 리뷰웹발 삭제 수신 엔드포인트 구현 — `POST /api/review-order-deleted` (1-G ②)

---

## 7. 참고: 리뷰웹 쪽 상태 (이미 완료)
- `POST /api/order/intake`, `GET /api/order/intake/list` 배포·검증 완료
- `DELETE /api/order/intake/:id`(인트라넷→리뷰웹 삭제) + `DELETE /api/order/admin/delete`(리뷰웹→인트라넷 삭제 push) 배포·검증 완료
- 리뷰웹 인박스 [접수하기] → 작업시트탭(gid) 자동 등록 + 캠페인 탭 관리 즉시 반영
- CORS에 `inadd-system.pages.dev` 허용 완료
- Railway `ORDER_INTAKE_KEY` 설정 완료
- 관리자 신규요청 팝업 배포 완료
- 즉, **인트라넷 쪽 구현만 하면 연동 끝**입니다. (리뷰웹발 삭제 전파를 쓰려면 `INTRANET_ORDER_DELETE_WEBHOOK_URL` 설정)
