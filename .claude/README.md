# review-web-system 하네스 (.claude/)

이 디렉토리는 Claude Code가 이 저장소에서 일관되게 작업하도록 돕는 구성입니다.

| 구성요소 | 위치 | 역할 |
|---|---|---|
| 프로젝트 가이드 | `../CLAUDE.md` | 세션 시작 시 읽는 아키텍처·컨벤션·함정 요약 |
| 검토 에이전트 팀 | `agents/` | 읽기전용 제안→검토→판단 서브에이전트 3종 (`agents/README.md`) |
| 작업 절차 스킬 | `skills/` | 반복·실수 잦은 작업의 단계별 절차 |

## 스킬 목록

- `skills/add-endpoint` — 새 API 엔드포인트 추가 시 3종 세트(Express 라우트 + `api.js` `_ACTION_MAP` + 프론트 호출) 동기화·권한 게이팅·응답 형식.
- `skills/add-migration` — 두 마이그레이션 러너 모두에서 안전한 idempotent 마이그레이션 작성.

## 사용 흐름 (권장)

1. 새 기능: `feature-proposer`로 구현안 → `code-reviewer`로 점검 → `proposal-judge`로 판단·보고.
2. 사용자 승인 후 메인 세션이 구현. 엔드포인트/DB 변경은 위 스킬 절차를 따름.

## 확장 방법

- 에이전트: `agents/<name>.md` 의 frontmatter(`name`, `description`, `tools`, `model`) + 본문(시스템 프롬프트) 편집.
- 스킬: `skills/<name>/SKILL.md` 생성 (frontmatter `name`, `description` + 절차 본문).
- 프로젝트 지식이 바뀌면 `../CLAUDE.md`를 갱신.
