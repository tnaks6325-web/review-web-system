# 쿠팡 썸네일 자동수집 차단 — 원인 분석 보고서 (해결 방법 탐색용 핸드오프)

> 작성: 2026-07-20 · 목적: **다른 세션이 이 문서만 읽고 해결 방법 탐색을 시작할 수 있게** 현상·현재 구현·실측 근거·해결 후보를 정리.
> 결론 요약: **쿠팡 HTML 페이지는 서버측 fetch가 IP·핑거프린트 레벨에서 403 차단**(UA 스푸핑 무효). 단 **이미지 CDN(coupangcdn.com)은 차단 없음**이 실측 확인됨 → "이미지 URL만 어떻게든 얻으면 표시·저장은 가능"이 핵심 공략 지점.

## 1. 현상 (사용자 체감)

관리자 대시보드(admin.html) 모집공고 발행 폼에서 상품확인용 URL이 쿠팡이면:

- [가져오기] 버튼(수동)·작업오더 프리필 직후 자동수집(`fetchProductInfo({auto:true})`) 모두
  토스트 **"쿠팡 접근이 차단되었습니다(봇 차단). 썸네일/상품명/가격을 수동 입력하세요."** 로 실패.
- 2026-07 이후 상품명·가격은 **작업오더 입력값이 기본 프리필**되어 실패해도 채워지지만(PR #305·#307),
  **썸네일만은 소스가 없어** 카드에 기본 아이콘(🛍️)이 노출됨. 현재 우회는 발행 폼의 **직접 업로드**(파일 → Drive+무인증 프록시, PR #297 M3 ③)뿐.

## 2. 현재 구현 (코드 지도)

| 구성요소 | 파일 | 내용 |
|---|---|---|
| 수집 API | `server/src/routes/product.routes.js` (`POST /api/product/preview`) | 서버(Node, Railway)에서 대상 URL을 `fetch`(10s 타임아웃, 크롬 UA·Accept-Language 스푸핑) → **JSON-LD Product 우선, OG/meta 폴백** 파싱 → `{thumbnail, name, price}` 반환. `!resp.ok`이면 403/429는 "봇 차단" 힌트. 인증: admin JWT(adminOrMaster) |
| 호출부 | `frontend/js/index-recruit.js` `fetchProductInfo(opts)` | 발행 폼 [가져오기] + 작업오더 프리필 직후 자동 1회. **성공 항목만 덮어씀**(비클로버), 실패 시 작업오더 기본값 유지 |
| 썸네일 대체 경로 | `frontend/js/index-recruit.js` `uploadCampThumb` | 파일 직접 업로드 → `POST /api/order/guide-image`(Drive 저장) → **절대 프록시 URL**(`/api/order/guide-image/:id`, 무인증 이미지 프록시) 저장. 5MB 상한 |
| 카드 표시 | `frontend/js/campaign-cards.js` | `thumbnail_url` 있으면 background-image, 없으면 🛍️ 플레이스홀더 |

- 썸네일 URL은 `recruit_campaigns.thumbnail_url`(migration 045)에 절대 URL 문자열로 저장 — **어떤 방식이든 "URL 한 줄"만 만들면 나머지 파이프라인은 완성돼 있음**.
- 발행은 fail-soft: 수집 실패해도 공고 발행·참여형 활성화에 지장 없음(썸네일은 선택 필드).

## 3. 실측 결과 (2026-07-20, 모두 재현 가능)

프로덕션 Railway 인스턴스(`/api/product/preview` 경유)에서:

| 대상 | 결과 |
|---|---|
| `https://www.coupang.com/vp/products/9624495419?...` (데스크톱 상품페이지) | **HTTP 403** |
| `https://m.coupang.com/vm/products/9624495419?...` (모바일) | **HTTP 403** |
| `https://link.coupang.com/a/test` (단축링크 도메인) | **HTTP 403** |

교차 확인(별도 데이터센터 IP의 컨테이너, 크롬 UA + ko-KR 헤더 직접 curl):

| 대상 | 결과 |
|---|---|
| `www.coupang.com/vp/products/...` | **HTTP 403 (0.7s — 챌린지 페이지도 아닌 즉시 거부)** |
| `thumbnail6.coupangcdn.com/...(존재하지 않는 경로)` | **HTTP 404** ← 차단이면 403이어야 함. **CDN은 봇차단 없이 도달됨** |

해석:
- 서로 다른 두 데이터센터 IP에서, 완전한 브라우저 헤더로도 즉시 403 → **UA/헤더 스푸핑으로는 못 뚫는 차단**. 데이터센터 IP 대역 평판 차단 및/또는 TLS 핑거프린트(JA3)류 봇 매니저로 추정(추정 부분은 후속 세션에서 검증).
- 반면 **이미지 CDN(`*.coupangcdn.com`)은 서버측 접근이 차단되지 않음**(실측). 상품페이지 HTML을 못 읽는 것뿐, 이미지 자체는 서버가 가져올 수 있다.

## 4. 원인 정리

1. **확인된 사실**: 쿠팡 HTML(www·m·link 전 도메인)은 데이터센터발 서버 요청을 403으로 즉시 차단. 파싱 이전에 본문 자체를 못 받음. JSON-LD/OG 파서 문제가 아님(올리브영 등 타 몰은 동일 코드로 성공).
2. **확인된 사실**: 이미지 CDN은 미차단.
3. **추정(검증 필요)**: 차단 기준은 IP 대역 평판 + TLS/HTTP2 핑거프린트. 주거용/모바일 IP + 실제 브라우저 핑거프린트면 통과 가능성.

## 5. 해결 후보 (다음 세션 조사 순서 제안)

### A. 관리자 브라우저에서 수집 (서버 우회 · 무비용 · 권장 1순위 조사)
관리자는 어차피 쿠팡 페이지를 브라우저로 열 수 있다(사람 트래픽은 차단 안 됨). 서버가 아니라 **관리자 브라우저를 수집기로** 쓰는 방향.
- **A-1. 이미지 URL 붙여넣기 필드**: 쿠팡 앱/웹에서 상품 이미지 우클릭→"이미지 주소 복사" → 발행 폼에 붙여넣기. `coupangcdn.com` URL은 서버가 fetch 가능(실측)하므로 **서버가 받아 Drive 프록시로 재저장**(핫링크 아님 = 쿠팡 CDN 변경·리퍼러 정책에도 안전). 구현 난이도 최하 — `uploadCampThumb` 옆에 URL 입력 1개 + 서버 `fetch→기존 guide-image 저장 재사용`.
- **A-2. 북마클릿/브라우저 확장**: 쿠팡 상품페이지에서 클릭 한 번으로 og:image·상품명·가격을 추출해 발행 폼에 자동 전달(postMessage 또는 클립보드 JSON). CORS 없이 페이지 내 실행이라 차단 무관.
- 한계: 관리자 손이 1번 감(자동은 아님). 그러나 실패율 0%.

### B. 쿠팡 공식 API (정공법 · 조사 가치 높음)
- **쿠팡 파트너스(제휴) API**: 상품 검색/딥링크 API가 상품명·가격·이미지 URL을 반환. 파트너스 가입·승인 + HMAC 키 필요. 약관상 용도(제휴 링크 외 사용) 검토 필요.
- **쿠팡 윙/오픈API(판매자)**: 판매자 계정이면 자사 상품 조회 가능 — 리뷰 캠페인 대상이 자사/광고주 상품이라면 광고주 협조로 이미지 원본을 받는 운영 루트도 검토.

### C. 스크래핑 프록시/API 서비스 (자동화 유지 · 유료)
- Firecrawl(현재 워크스페이스에 커넥터 연결돼 있음 — 탐색 세션에서 바로 실험 가능), ScraperAPI, Zyte, Bright Data 등 주거용 IP + 실브라우저 렌더링 서비스.
- 서버에서 `preview` 실패 시에만 폴백 호출하는 구조면 비용 최소화(발행 시 1회성 호출이라 볼륨 극소).
- 조사 포인트: 쿠팡 성공률(서비스별 상이), 건당 비용, 응답 지연(발행 UX 10s 타임아웃), 약관.

### D. 서버측 실브라우저 (Playwright + stealth)
- Railway에 headless Chromium 탑재. **주의: 쿠팡은 헤드리스 탐지·IP 평판 차단을 함께 쓰므로 데이터센터 IP에서는 성공률 낮을 것으로 추정**(3번 추정과 동일 근거). 주거용 프록시와 결합해야 실효 → 사실상 C와 동급 비용. 우선순위 낮음.

### E. 링크 프리뷰 대행 API (간접 우회)
- 카카오톡/네이버 등이 쓰는 링크 스크랩 인프라를 공개 API로 제공하는지 조사(예: 소셜 공유 미리보기 API, unfurl 서비스). 쿠팡이 메신저 봇은 허용하는 점을 이용하는 아이디어 — 공개 API 존재 여부부터 불확실하므로 탐색 항목.

## 6. 제약 조건 (해결책이 지켜야 할 것)

1. **호출 볼륨 극소**: 공고 발행 시 1회(수동 재시도 포함 분당 수 회 이하). 상시 크롤링 아님 — 과금형 서비스도 부담 적음.
2. **fail-soft 유지**: 어떤 방식이든 실패가 발행을 막으면 안 됨(현재 계약 유지).
3. **이미지는 자체 저장**: 최종 썸네일은 쿠팡 CDN 핫링크가 아니라 **기존 Drive+guide-image 프록시로 재저장**을 권장(링크 부패·리퍼러 정책 리스크 제거, 인프라 기존 재사용).
4. 무인증 공개 엔드포인트 신설 금지(기존 guide-image 프록시 재사용 우선), 시크릿은 Railway env로.
5. 상품명·가격은 이미 작업오더 프리필로 해결됨 — **신규 방안은 썸네일 1개 필드만 채우면 됨**(상품명·가격 개선은 보너스).

## 7. 재현·검증 방법

```bash
# 1) 프로덕션 경유 재현 (admin JWT 필요 — /api/admin/login)
curl -X POST https://sublime-magic-production-790b.up.railway.app/api/product/preview \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://www.coupang.com/vp/products/9624495419?itemId=28743035295"}'
# → {"ok":false,"error":"HTTP 403","hint":"쿠팡 접근이 차단..."}

# 2) CDN 미차단 확인 (403이 아니라 404 = 도달됨)
curl -o /dev/null -w "%{http_code}\n" \
  "https://thumbnail6.coupangcdn.com/thumbnails/remote/492x492ex/image/retail/images/notexist.jpg"
```

성공 판정 기준(어떤 방안이든): 쿠팡 상품 URL 입력 → `recruit_campaigns.thumbnail_url`에 표시 가능한 절대 URL이 채워지고 리뷰어 홈 카드에 이미지가 뜨면 완료. 관련 회귀가드: `server/tests/campaignM3Guards.test.js`(썸네일 섹션).
