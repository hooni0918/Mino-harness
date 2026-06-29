# Mino Harness

화면을 다 만들고 나면 반복 노동이 남는다. **접근성을 붙이고, 테스트를 쓰고, 시뮬레이터에서 직접 눌러보고, 결과를 읽는 일.** 매 피쳐마다 똑같이 반복되는데, 사람이 매번 손으로 한다.

이 저장소는 그 노동을 프롬프트로 옮긴 것이다. Mino(SwiftUI · Clean Architecture · Swift 6 / iOS 17+) iOS 앱에 붙일 작업 자동화 번들이며, Figma URL 하나를 던지면 분류부터 QA까지 알아서 흐른다.

## 한 번 정한 방식을 프롬프트로

한 번 내린 판단은 두 번 내리지 않는다. "이 화면은 이렇게 QA한다"를 정했으면, 그 판단을 프롬프트로 박아 AI에게 위임한다. 그래야 다음 피쳐에서 같은 결정을 또 하지 않는다.

그래서 이 번들은 네 개의 일꾼([에이전트](.claude/agents/))과 그들이 따르는 판단 기준([스킬](.claude/skills/))으로 나뉜다. 일꾼은 손을 움직이고, 스킬은 "이렇게 하면 버그"라는 가드레일을 제공한다. 둘을 분리해 둔 이유는, 판단 기준은 외부에서 검증된 것을 그대로 빌려오고(아래 벤더링) 일꾼만 우리 프로젝트에 맞게 조립하기 위해서다.

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

> **의존**: 전역 `/ios-workflow` 스킬, Figma MCP(claude.ai 인증 — 백그라운드 실행에선 빠질 수 있음), `axe` CLI.

## 첫 판단만 무겁게, 실행은 가볍게

LLM 작업의 비용은 대부분 모델 등급에서 갈린다. 모든 단계를 가장 똑똑한 모델로 돌리면 정확하지만 비싸고, 전부 가벼운 모델로 돌리면 싸지만 엉성하다. 답은 **판단이 필요한 곳에만 비싼 모델을 쓰는 것**이다.

그래서 하네스는 맨 앞에서 Opus를 딱 한 번 쓴다. Figma를 읽고 "새 화면인가 / 기존 수정인가, 복잡도가 어느 정도인가, 각 단계에 어떤 모델이면 충분한가"를 판단한다. 그 판단 결과대로 구현·테스트·QA는 Sonnet이나 Haiku로 내려간다. 모델 배정이 코드에 고정돼 있지 않고 **분류기가 매번 정한다는 것**이 핵심이다 — 단순한 UI면 더 가볍게, 아키텍처가 얽히면 더 무겁게.

PR은 하네스가 직접 만들지 않는다. 구현 단계가 소환하는 `/ios-workflow` 스킬이 만든다. 따라서 기존 화면 수정처럼 구현이 필요 없는 경로(`skipImplement`)에선 PR이 안 생기고 QA 리포트만 나온다.

## 접근성이 자동화의 전제다

화면을 밖에서 조작하려면 요소를 가리킬 이름이 있어야 한다. 그 이름이 `accessibilityIdentifier`다. 이 식별자는 두 가지 일을 동시에 한다 — VoiceOver 사용자를 위한 접근성이자, AXe가 요소를 찾는 선택자다.

그래서 파이프라인의 첫 일꾼이 접근성이다. `accessibility-auditor`가 인터랙션 요소에 `"<Screen>.<element>"` 꼴의 식별자를 붙인다. 이름은 표시 텍스트가 아니라 역할에서 온다 — `"로그인"`이 아니라 `Login.submitButton` — 지역화나 문구 변경에 안 깨지게. 식별자가 하나도 안 붙은 화면은 뒤 단계가 요소를 못 찾으므로, 이 단계는 **게이트**다. 식별자 0개면 그 화면은 파이프라인에서 드롭된다.

## 테스트 코드 없이도 화면을 돌려본다

SwiftUI 화면의 동작을 확인하려면 보통 UI 테스트 타깃을 만들고 `XCUITest`를 쓴다. 이 번들은 대신 [AXe](https://github.com/cameroncooke/AXe) CLI로 시뮬레이터를 밖에서 조작한다. 앱에 테스트 번들을 심는 대신 `tap`·`type`·`describe-ui`로 화면을 움직이고 스크린샷으로 결과를 본다.

그래서 "테스트 코드 없이"는 절반만 사실이다. 순수 로직(Domain·UseCase)은 여전히 Swift Testing 단위 테스트로 박지만, 화면 흐름은 코드 대신 자연어에 가까운 시나리오 파일로 적고 AXe가 구동한다. 대신 한계가 분명하다 — AXe는 한글 입력을 못 하고(US 키보드 한정), HID 명령은 "전달"만 보장할 뿐 앱이 처리했는지는 모른다. 그래서 결과는 항상 스크린샷·`describe-ui`로 따로 검증한다.

## 만들고 끝이 아니라, 적대적으로 단단해진다

AI가 쓴 프롬프트와 에이전트 정의에도 빈틈이 있다. 혼자 검토하면 자기 논리의 구멍을 못 본다. 그래서 [여러 비평가가 차원을 나눠 동시에 공격](docs/adversarial-improvement.md)하게 한다.

`adversarial-harden` 워크플로우는 명령 정확성·스킬 이름·레이어 적합성·접근성 커버리지·테스트 품질·문서 정합성을 각각 다른 눈으로 공격한다. 발견된 결함은 독립 검증자가 **반증을 기본값으로** 두고 다시 검사해, 살아남은 것만 채택한다. 실제로 이 README와 하네스도 그 검증을 한 번 거쳤다 — 그때 "게이트라고 써놓고 코드엔 게이트가 없다"는 지적이 나와 위의 접근성 게이트를 진짜로 구현했다.

수정까지 자동화하지는 않는다. 검증을 통과한 결함도 오판일 수 있어서, 워크플로우는 "확정 결함 목록"까지만 내고 반영은 사람이 diff로 판단할 수 있는 지점에 둔다.

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
