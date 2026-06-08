# review-web-system 검토 에이전트 팀

코드 작성·수정 관련 기능을 **제안 → 검토 → 판단·보고**하는 읽기 전용 서브에이전트 3종.
세 에이전트 모두 코드를 직접 고치지 않습니다(advisory). 실제 수정은 메인 세션이 승인하에 진행.

## 구성

| 에이전트 | 역할 | 도구 |
|---|---|---|
| `feature-proposer` | 기존 패턴에 맞는 기능/구현안 제안 (file:line + 트레이드오프) | Read, Grep, Glob |
| `code-reviewer` | 작성·수정 코드/제안을 정확성·보안·일관성 검토 (심각도별 보고) | Read, Grep, Glob, Bash(읽기전용) |
| `proposal-judge` | 제안 + 검토를 종합해 판단·추천을 사용자에게 보고 | Read, Grep, Glob |

## 사용법

- 자연어로 위임:
  - "feature-proposer로 work_orders MVP 구현안 제안해줘"
  - "방금 변경분을 code-reviewer로 검토해줘"
  - "이 제안들을 proposal-judge로 판단해서 보고해줘"
- 추천 파이프라인: **proposer**(안 도출) → **reviewer**(리스크 점검) → **judge**(판단·보고) → 사용자 승인 → 메인 세션이 구현.
- 여러 안을 병렬로 받고 싶으면 proposer를 동시에 여러 번 호출 가능.

## 수정

각 `.md` 파일의 frontmatter(`tools`, `model`)와 본문(시스템 프롬프트)을 편집하면 동작이 바뀝니다.
`model: inherit`는 메인 세션 모델을 따릅니다(원하면 `sonnet`/`opus`/`haiku`로 고정 가능).
