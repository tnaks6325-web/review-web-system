# 인트라넷(inadd-system) → 리뷰웹시스템 작업오더 연동

AE가 인트라넷에서 리뷰작업요청을 작성하면 → 리뷰웹 백엔드로 직접 전송 → 관리자 인박스에 팝업/누적 → 모집공고 전환.

## 데이터 흐름
```
inadd-webapp(인트라넷)  ──POST /api/order/intake (X-Intake-Key)──▶  review-web 백엔드(Railway)
                                                                         │ work_orders 저장
                                                                         ▼
                                                        review-web 관리자: 신규요청 팝업 + 목록 + 모집공고 전환
```

## 설정 (3단계)

### 1) 리뷰웹 백엔드 (Railway) — 시크릿 설정
- Railway 환경변수 추가: `ORDER_INTAKE_KEY = <임의의 긴 랜덤 문자열>`
- 이 브랜치 배포 후 CORS는 `inadd-system.pages.dev` 자동 허용됨.

### 2) 인트라넷(inadd-webapp) — 키트 적용
- `inadd-order-kit.html`의 마크업/스크립트를 인트라넷 페이지에 붙여넣기.
- 상단 `RK_CONFIG` 설정:
  - `API_BASE`   = `https://sublime-magic-production-790b.up.railway.app`
  - `INTAKE_KEY` = ①에서 정한 `ORDER_INTAKE_KEY`와 **동일**
- `getRequester()` 가 인트라넷 로그인 AE 이름을 반환하도록 연결(없으면 입력칸 사용).

### 3) 동작 확인
- 인트라넷에서 폼 작성 → "요청 보내기" → review-web 관리자 화면에서 신규요청 팝업/인박스 확인.
- "요약 복사" 버튼 → 카톡 리마인드용 요약 클립보드 복사(전송 시 자동 복사도 됨).

## 보안 메모
- `INTAKE_KEY`가 인트라넷 클라이언트 JS에 노출됩니다. 인트라넷이 접근제한(403)이라 위험은 완화되지만,
  더 엄격히 하려면 인트라넷 백엔드(inadd-finance-server)가 서버측에서 중계하도록 바꾸세요(키 미노출).
- intake 엔드포인트는 `ORDER_INTAKE_KEY` 미설정 시 503으로 비활성(안전 기본값).

## 필드 매핑 (work_orders)
title, start_date, product_option, pay_amount, daily_count, purchase_time, inflow_keyword,
delivery_type, courier_proxy, review_type, recruit_count, review_guide, special_notes,
product_url, **work_sheet_url(필수)**, goods_cost_type, requester_name(→created_by)
