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
  "product_option": "50ml 1+1 / 23,900원",
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
      "created_at": "2026-06-08T13:10:56.489Z",
      "updated_at": "2026-06-08T13:10:56.489Z"
    }
  ]
}
```

### 1-C. 유입가이드 이미지 업로드 — `POST /api/order/guide-image`

유입가이드 본문에 넣을 **이미지를 Google Drive에 업로드**하고 표시용 URL을 받습니다.
(인트라넷 폼에서 붙여넣기/드래그/첨부한 이미지를 업로드 → 받은 URL을 `inflow_guide` HTML의 `<img src>`로 삽입)

- 인증: 헤더 `X-Intake-Key`(인트라넷) 또는 JWT(내부). intake 키 그대로 사용 가능.
- 요청(JSON): `{ "imageBase64": "data:image/jpeg;base64,...", "mimeType": "image/jpeg", "fileName": "guide.jpg" }`
- 응답: `{ "ok": true, "id": "<driveId>", "url": "https://drive.google.com/thumbnail?id=...&sz=w1600", "viewUrl": "<webViewLink>" }`
  - `url` 을 `<img src>` 로 쓰면 화면에 렌더됩니다(파일은 anyone-reader 자동 설정).
- 권장: 업로드 전 클라이언트에서 **리사이즈/JPEG 압축**(최대 1600px) — 제공된 키트(`inadd-order-kit.html`)에 구현돼 있음.

> 흐름: 이미지 첨부 → `guide-image`로 업로드 → 받은 `url`을 가이드 HTML에 `<img>`로 삽입 → 오더 제출 시 `inflow_guide`(HTML)로 전송 → 리뷰웹 관리자 화면에 이미지 그대로 표시.

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

## 2. 필드 스키마 (work_orders)

| 필드 | 타입 | 필수 | 설명 |
|---|---|:--:|---|
| title | string | ✅ | 작업명 |
| work_sheet_url | string | ✅ | 작업시트 탭 URL |
| requester_name | string | (권장) | 요청자(AE) 이름 → `created_by` 저장. 없으면 "인트라넷" |
| start_date | string(YYYY-MM-DD) | | 시작일 |
| product_option | string | | 상품옵션 및 결제금액(자유문구) |
| pay_amount | number | | 결제금액(숫자) |
| daily_count | number | | 일일 진행 건수 |
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

---

## 7. 참고: 리뷰웹 쪽 상태 (이미 완료)
- `POST /api/order/intake`, `GET /api/order/intake/list` 배포·검증 완료
- CORS에 `inadd-system.pages.dev` 허용 완료
- Railway `ORDER_INTAKE_KEY` 설정 완료
- 관리자 신규요청 팝업 배포 완료
- 즉, **인트라넷 쪽 구현만 하면 연동 끝**입니다.
