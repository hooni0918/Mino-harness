# 아키텍처 — 무엇이 무엇을 합성하는가

이 번들은 세 층위의 조각을 합친 것이다. 각 조각의 역할이 다르므로, 어디를 고칠지 헷갈리지 않게 분리해 둔다.

## 세 층위

### 1. 전문 스킬 (벤더링, `.claude/skills/`)
코드를 **쓸 때의 판단 기준**이다. 에이전트가 작업 중 소환해 "이렇게 하면 버그"라는 가드레일로 쓴다.

- `swiftui-expert-skill` — SwiftUI 상태/성능/접근성/애니메이션 규칙
- `swift-concurrency` — async/await, actor, Sendable, Swift 6 마이그레이션
- `swift-testing-expert` — Swift Testing 작성·이관
- `axe` — iOS 시뮬레이터 CLI 자동화 가이드

이 넷은 외부에서 그대로 가져온 것이라 우리가 내용을 고치지 않는다(업데이트는 NOTICE의 출처에서 다시 받음).

### 2. QA 에이전트 (자작, `.claude/agents/`)
**누가 무슨 일을 하는지**다. 각 에이전트는 독립 컨텍스트에서 돌며 위 스킬을 소환해 일한다.

- `accessibility-auditor` → `test-author` → `simulator-qa` → `qa-reviewer`

### 3. 오케스트레이터 (자작, `.claude/skills/mino-qa/`)
**순서와 게이트**다. 네 에이전트를 파이프라인으로 엮고, 단계 사이의 중단 조건(식별자 누락 등)을 정의한다.

## 데이터가 흐르는 길

```
SwiftUI 뷰
  │   (git diff로 대상 수집)
  ▼
accessibility-auditor ──▶ 식별자 매니페스트 ("Login.emailField": field, ...)
  │
  ▼
test-author ──▶ 단위테스트(.swift) + AXe 시나리오(qa/scenarios/*.txt) + 기대결과 메모
  │
  ▼
simulator-qa ──▶ 스크린샷 시퀀스(qa-artifacts/*.png) + 실행 로그
  │
  ▼
qa-reviewer ──▶ QA 판정 리포트 (PR 본문용)
```

핵심은 **단계 간 산출물이 명시적 인공물**이라는 점이다. 매니페스트·시나리오·스크린샷은 파일로 남아,
파이프라인이 중간에 끊겨도 그 지점부터 다시 이을 수 있고, 사람이 각 단계 산출물을 따로 검수할 수 있다.

## "Harness" 개념과의 관계

[revfactory/harness](https://github.com/revfactory/harness)는 도메인 설명을 주면 팀 아키텍처 패턴(파이프라인,
팬아웃, 전문가 풀 등)에 맞춰 에이전트 팀과 스킬을 자동 생성하는 메타 도구다. 이 번들은 그중 **파이프라인 패턴**을
손으로 구현한 사례에 해당한다. 규모가 커지면 Harness로 이 구조를 재생성·확장하는 길을 검토할 수 있다.

## 경계 — 무엇을 고칠 때 어디를 보나

| 바꾸고 싶은 것 | 고칠 위치 |
|----------------|-----------|
| SwiftUI/테스트/동시성 판단 기준 | 벤더 스킬은 직접 수정 금지 → 업스트림 반영 또는 `CLAUDE.md`에 프로젝트 규칙 추가 |
| 각 단계가 하는 일 | `.claude/agents/<agent>.md` |
| 단계 순서·게이트 | `.claude/skills/mino-qa/SKILL.md` |
| 프로젝트 레이어/네이밍 규칙 | `CLAUDE.md` |
| 산출물을 적대적으로 단단하게 | `workflows/adversarial-harden.js` (→ `adversarial-improvement.md`) |
