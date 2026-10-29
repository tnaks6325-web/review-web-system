# 작업담당 양방향 동기화 / 작업보드 빠른 배정 계획

상태: 2026-10-29 로컬 구현·검증 완료. 미배포. 사용자 미리보기 승인 전 푸시·PR·머지하지 않는다.

## 승인한 범위
- 두 저장소 최신 origin/main에서 각각 격리 작업트리를 만든다. 기존 dirty 작업트리는 건드리지 않는다.
- 연결된 수정 가능한 작업오더의 work_manager만 양방향으로 연다. 발행 전/off/diverged/따로 두기 포함. 다른 필드의 소유권·전체 bidir_state는 그대로 둔다.
- 작업 조건 담당 행에 미지정 [만두] [망고]. 최초 배정과 재배정 모두 지원. 새 빠른 컨트롤은 master/admin + 기존 편집 정책. 품절 접기 제외.
- 기존 공식 원본 수정·내구성 대기열·서명·충돌/재시도 장치를 재사용한다. 운영 자료·과거 자료 일괄 변경 없음.

## 구현 순서와 완료
1. **완료** 공유 필드 목록·정규화·쓰기 허용·전체 송신 목록·push-back 목록을 함께 확장했다.
2. **완료** 담당자 단독 상태 예외와 내구성 송신 범위를 추가했다. 전체 대기 항목/승인 버전은 부분 송신으로 완료되지 않는다. 인트라넷에 독립 담당자 수신 버전을 추가했다.
3. **완료** capability/기준 버전(0 포함)·옛 창 보존·혼합 저장 원자성·서버 권한·삭제/완료/보관 보호를 연결했다.
4. **완료** 조건 카드의 managerName 오독을 work_manager 우선 공통 판정으로 바꿨다. 홈/입금관리와 같은 최신 직접 연결 오더를 편집한다. 새 버튼·공유 수정창을 기존 저장 경로에 연결했다.
5. **완료** 실제 PGlite/SQLite 저장과 실제 Hono 라우트를 왕복 연결했다. 스코프 교차 도착·중복·원본 해시 충돌·동시 저장·실패 재전송·held 후 수렴·권한/구버전/실패 UI를 확인했다.
6. **완료** 실제 HTTP PC/모바일 가짜 자료 before/after와 배정/재배정/실패 캡처. 화면 검사는 API가 가짜이며, 왕복 성공의 근거는 별도 실제 SQL 통합 검사다.
7. **완료** 결정 305·목차·미배포 패치노트 작성. 전체 검사 RWS 642 files, 인트라넷 159 pretest + 1,142 main test, 형식 검사·빌드 통과.

## 재현 명령
- `cd server && env -u PGURL -u DATABASE_URL -u PGOPTIONS npm test`
- `env -u PGURL -u DATABASE_URL -u PGOPTIONS node scripts/verify-manager-roundtrip.cjs` (sibling inadd-manager-bidir 필요; MANAGER_INADD_REPO로 경로 변경)
- `NODE_PATH=<playwright가 있는 node_modules> PW_CHROMIUM=<기존 브라우저 실행파일> node scripts/verify-manager-ui.cjs before|after`
- 인트라넷 작업트리에서 `npm test`, `npm run typecheck`, `npm run build` (DB 환경변수 제거)

## 남은 것
부모 검토·사용자 미리보기 확인·배포/운영 읽기 검증. 인트라넷 수신 지원을 먼저 반영해야 한다. RWS migration 206은 새 view_scope 칸 하나이며 기존 행의 기본값만 full이다. 원본 담당자를 옮기는 데이터 이관은 없다. 자세한 규칙과 되돌림은 [결정 305](../decisions/305-작업담당-양방향-빠른배정-2026-10-29.md).
