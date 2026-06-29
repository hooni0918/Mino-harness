# Mino Skills

Mino(SwiftUI · Clean Architecture · Swift 6 / iOS 17+) iOS 앱을 위한 **AI 작업 자동화 번들**.
Figma URL 하나를 던지면 — 분류 → 구현 → 접근성 → 테스트 → QA 까지 알아서 흐른다.

핵심은 **첫 판단만 무겁게(Opus), 실행은 가볍게(Sonnet/Haiku)**. 비싼 모델로 한 번 분류하고, 나머지는 작업 복잡도에 맞는 모델로 내려보낸다.

## 한 줄 트리거 — figma-to-pr 하네스

```
Workflow({ scriptPath: "workflows/figma-to-pr.js", args: "https://figma.com/..." })
```

```
Figma URL
  │
  ▼  [Opus]  분류        Figma MCP로 디자인 읽고 → 무슨 작업인지 + 단계별 모델 배정
  │
  ▼  화면별 파이프라인 (분류기가 배정한 모델로)
  │
  ├─ [Sonnet] 구현        /ios-workflow 소환 → 화면 코드 (기존 수정이면 건너뜀)
  ├─ [Sonnet] 접근성      accessibility-auditor → accessibilityIdentifier 부여 (게이트)
  ├─ [Haiku]  테스트      test-author → Swift Testing 단위테스트 + AXe 시나리오
  └─ [Sonnet] QA          simulator-qa → 시뮬레이터 실행 → qa-reviewer 판정
  │
  ▼  QA 판정 리포트(분류·모델·화면별 결과) + 구현 경로에선 /ios-workflow가 만든 PR
```

PR은 하네스가 직접 만들지 않는다 — 구현 단계가 소환하는 `/ios-workflow` 스킬이 만든다. 따라서 `skipImplement`(기존 화면 수정) 경로에선 PR이 생기지 않고 QA 리포트만 나온다. 하네스 자체의 반환값은 분류·모델·화면별 QA 결과 JSON이다.

모델 배정은 고정이 아니다 — Opus가 복잡도를 보고 단계마다 정한다(단순하면 더 가볍게, 무거우면 더 무겁게). 라우팅 규칙은 [mino-router](.claude/skills/mino-router/SKILL.md), 실행은 [figma-to-pr.js](workflows/figma-to-pr.js).

> **의존**: 전역 `/ios-workflow` 스킬, Figma MCP(claude.ai 인증 — 백그라운드 실행에선 빠질 수 있음), `axe` CLI.

## 구성요소

### 입구 · 오케스트레이션

| 무엇 | 한 줄 |
|------|-------|
| [mino-router](.claude/skills/mino-router/SKILL.md) | Figma/요청을 분류하고 워크플로우·모델로 라우팅하는 두뇌 |
| [figma-to-pr.js](workflows/figma-to-pr.js) | 분류 → 구현 → 접근성 → 테스트 → QA 를 모델별로 실행하는 하네스 |
| [mino-qa](.claude/skills/mino-qa/SKILL.md) | QA 4단계를 순서대로 엮는 파이프라인 (게이트 포함) |

### QA 에이전트 (각자 독립 컨텍스트, 전문 스킬 소환)

| 에이전트 | 한 줄 |
|----------|-------|
| [accessibility-auditor](.claude/agents/accessibility-auditor.md) | SwiftUI 뷰에 `accessibilityIdentifier` 부여 + 매니페스트 산출 |
| [test-author](.claude/agents/test-author.md) | Swift Testing 단위테스트 + AXe UI 시나리오 작성 |
| [simulator-qa](.claude/agents/simulator-qa.md) | AXe로 시뮬레이터 실행 + 단계별 스크린샷 |
| [qa-reviewer](.claude/agents/qa-reviewer.md) | 스크린샷·테스트 결과 판정 → PR용 리포트 |

### 전문 스킬 (벤더링 — 코드 작성 시 판단 기준, 출처 [NOTICE](NOTICE))

| 스킬 | 한 줄 |
|------|-------|
| [swiftui-expert-skill](.claude/skills/swiftui-expert/SKILL.md) | SwiftUI 상태·성능·접근성·애니메이션 규칙 (디렉토리명은 `swiftui-expert`) |
| [swift-concurrency](.claude/skills/swift-concurrency/SKILL.md) | async/await·actor·Sendable·Swift 6 마이그레이션 |
| [swift-testing-expert](.claude/skills/swift-testing-expert/SKILL.md) | Swift Testing 작성·XCTest 이관 |
| [axe](.claude/skills/axe/SKILL.md) | iOS 시뮬레이터 CLI 자동화 (`tap`/`type`/`describe-ui`…) |

### 자기 개선

| 무엇 | 한 줄 |
|------|-------|
| [adversarial-harden.js](workflows/adversarial-harden.js) | 차원별 비평가가 산출물을 적대적으로 공격 → 살아남은 결함만 보고 |

## 문서

- [architecture.md](docs/architecture.md) — 스킬·에이전트·오케스트레이터가 합성되는 방식
- [adversarial-improvement.md](docs/adversarial-improvement.md) — 병렬 적대 에이전트 루프
- [ai-workflow-integration.md](docs/ai-workflow-integration.md) — AI-Workflow 배포 시스템 연결

## 설치

이 저장소를 클론하면 `.claude/`가 살아 있어 여기서 Claude Code를 열면 스킬·에이전트가 바로 동작한다.
(하네스의 `agentType` 디스패치는 이 레포가 cwd일 때 에이전트가 등록되므로 동작한다.)

```sh
brew install cameroncooke/axe/axe   # 시뮬레이터 자동화 실행용
axe list-simulators                 # UDID 확인
```

벤더 스킬은 원본이 Claude Code 플러그인이기도 하다. 최신 추적이 필요하면 플러그인으로 설치할 수 있다.

```
/plugin marketplace add AvdLee/Swift-Concurrency-Agent-Skill
/plugin install swift-concurrency
```

## 라이선스

MIT([LICENSE](LICENSE)). `.claude/skills/` 아래 네 스킬은 외부에서 벤더링했으며 출처·라이선스는 [NOTICE](NOTICE).
