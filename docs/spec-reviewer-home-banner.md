# Spec: 리뷰어 홈 배너광고

## Objective

관리자/마스터가 리뷰어 홈의 공지와 모집공고 사이에 노출할 단일 가로 배너를 관리한다. 배너 이미지를 업로드하고 클릭 URL을 지정하면, 리뷰어는 배너를 눌러 새 창에서 해당 URL을 연다.

## Contract

- 공개 조회: `GET /api/reviewer/home-banner` → 활성 상태일 때만 `{ ok: true, banner: { imageUrl, clickUrl, width: 1080, height: 240 } }`
- 관리자 조회/저장: `GET`/`POST /api/trackb/settings/home-banner`
- 관리자 업로드: `POST /api/trackb/settings/home-banner/upload`
- 저장 값: `app_settings.reviewer_home_banner`의 JSON 한 건

## Behavior

- 권장 이미지 크기는 `1080 × 240px`(4.5:1)로 설정 화면에 안내한다.
- 홈에서는 화면 너비에 맞춰 비율을 유지해 표시한다.
- 이미지 또는 URL이 없거나 비활성화면 배너 영역은 표시하지 않는다.
- 클릭 URL은 `https://` 또는 `http://`만 허용하고 `target="_blank" rel="noopener noreferrer"`로 연다.
- 업로드는 관리자/마스터만 가능하며 PNG/JPEG/WebP/GIF, 5MB 이하만 허용한다.

## Testing

- 서버: 권한, URL 검증, 공개 응답의 비활성 숨김을 테스트한다.
- 프런트: 관리자 설정 패널, 권장 픽셀 표기, 리뷰어 홈 삽입 및 새 창 보안 속성을 회귀 테스트한다.

## Boundaries

- 기존 Drive 업로드 인프라와 `app_settings`를 재사용한다.
- 배너 클릭 수 추적, 다중 배너/로테이션, 광고주 화면 노출은 이번 범위에 포함하지 않는다.
