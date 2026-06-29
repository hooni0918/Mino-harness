# Mino Skills

화면을 다 만들고 나면 반복 노동이 남습니다. **접근성을 붙이고, 테스트를 쓰고, 시뮬레이터에서 직접 눌러보고, 결과를 읽는 일.** 이 저장소는 그 네 가지를 프롬프트로 옮겨 AI에게 맡기기 위한 것입니다.

Mino(SwiftUI · Clean Architecture · Swift 6 / iOS 17+) iOS 앱에 붙일 QA·접근성·테스트 자동화 번들이며, 지금은 본체에 넣기 전 실험장입니다.

## 사람이 쓰던 QA를 프롬프트로

한 번 정한 QA 방식은 프롬프트로 만들어 AI에게 위임합니다. 같은 점검을 매 피쳐마다 손으로 반복하지 않기 위해서입니다.

피쳐가 끝나면 [mino-qa](.claude/skills/mino-qa/SKILL.md) 파이프라인이 네 단계를 순서대로 돌립니다. 화면에 [접근성을 부여](.claude/agents/accessibility-auditor.md)해 자동화가 요소를 찾을 수 있게 만들고, 그 식별자를 입력 삼아 [단위 테스트와 UI 시나리오를 작성](.claude/agents/test-author.md)하고, [시뮬레이터에서 실제로 실행](.claude/agents/simulator-qa.md)해 단계마다 스크린샷을 남기고, 마지막에 [그 증거를 읽어 통과/실패를 판정](.claude/agents/qa-reviewer.md)합니다.

각 단계는 독립된 에이전트가 독립된 맥락에서 맡습니다. 단계 사이의 산출물 — 식별자 매니페스트, 시나리오 파일, 스크린샷 — 은 모두 파일로 남아, 파이프라인이 중간에 끊겨도 그 지점부터 다시 잇고 사람이 단계별로 검수할 수 있습니다. 전체 그림은 [architecture.md](docs/architecture.md)에 있습니다.

## 테스트 코드 없이도 화면을 돌려본다

SwiftUI 화면의 동작을 확인하려면 보통 UI 테스트 타깃을 만들고 `XCUITest`를 씁니다. 이 번들은 대신 [AXe](https://github.com/cameroncooke/AXe)라는 외부 CLI로 시뮬레이터를 직접 조작합니다. 앱을 빌드해 테스트 번들을 심는 대신, 밖에서 `tap`·`type`·`describe-ui`로 화면을 움직이고 스크린샷으로 결과를 봅니다.

그래서 "테스트 코드 없이"가 절반은 사실입니다. 순수 로직(Domain·UseCase)은 여전히 [Swift Testing 단위 테스트](.claude/skills/swift-testing-expert/SKILL.md)로 박지만, 화면 흐름은 코드 대신 자연어에 가까운 [시나리오 파일](.claude/agents/test-author.md)로 적고 AXe가 구동합니다.

대신 한계가 분명합니다 — AXe는 한글 입력을 지원하지 않고(US 키보드 한정), HID 명령은 "전달"만 보장할 뿐 앱이 처리했는지는 모릅니다. 그래서 결과는 항상 스크린샷·`describe-ui`로 따로 검증합니다. 이 제약들은 [mino-qa SKILL](.claude/skills/mino-qa/SKILL.md)의 "한계" 절에 명시해 두었습니다.

## 접근성이 자동화의 전제다

화면을 밖에서 조작하려면 요소를 가리킬 이름이 있어야 합니다. 그 이름이 `accessibilityIdentifier`입니다. 이 식별자는 두 가지 일을 동시에 합니다 — VoiceOver 사용자를 위한 접근성이자, AXe가 요소를 찾는 선택자입니다.

그래서 파이프라인의 첫 단계가 접근성입니다. [accessibility-auditor](.claude/agents/accessibility-auditor.md)는 [SwiftUI 전문 스킬](.claude/skills/swiftui-expert/SKILL.md)의 접근성 기준을 소환해, 인터랙션 요소와 검증 대상에 `"<Screen>.<element>"` 꼴의 식별자를 붙입니다. 이름은 표시 텍스트가 아니라 역할에서 옵니다 — `"로그인"`이 아니라 `Login.submitButton` — 지역화나 문구 변경에 깨지지 않게요.

## 만들고 끝이 아니라, 적대적으로 단단해진다

AI가 쓴 프롬프트와 에이전트 정의에도 빈틈이 있습니다. 혼자 검토하면 자기 논리의 구멍을 못 봅니다. 그래서 [여러 비평가가 차원을 나눠 동시에 공격](docs/adversarial-improvement.md)하게 합니다.

[adversarial-harden 워크플로우](workflows/adversarial-harden.js)는 명령 정확성, 스킬 이름 정합, 레이어 적합성, 접근성 커버리지, 테스트 품질, 문서 정합성을 각각 다른 눈으로 공격합니다. 발견된 결함은 다시 독립 검증자 셋이 **반증을 기본값으로** 두고 검사해, 살아남은 것만 채택합니다. 통과 기준을 높여 그럴듯한 거짓 결함을 거르는 구조입니다.

수정까지 자동화하지는 않습니다. 검증을 통과한 결함도 오판일 수 있어서, 워크플로우는 "확정 결함 목록"까지만 내고 반영은 사람이 diff로 판단할 수 있는 지점에 둡니다.

## 구성

코드를 쓸 때의 판단 기준(스킬)과 누가 무슨 일을 하는지(에이전트)를 분리해 둡니다.

### QA 파이프라인 (자작)

- [mino-qa](.claude/skills/mino-qa/SKILL.md): 네 에이전트를 순서대로 엮는 오케스트레이터. 단계 사이의 중단 게이트를 정의
- [accessibility-auditor](.claude/agents/accessibility-auditor.md): SwiftUI 뷰에 `accessibilityIdentifier` 부여 + 식별자 매니페스트 산출
- [test-author](.claude/agents/test-author.md): Swift Testing 단위 테스트 + AXe UI 시나리오 작성
- [simulator-qa](.claude/agents/simulator-qa.md): AXe로 시뮬레이터 실행 + 단계별 스크린샷
- [qa-reviewer](.claude/agents/qa-reviewer.md): 스크린샷·테스트 결과 판정 → PR용 QA 리포트

### 전문 스킬 (벤더링, 출처는 [NOTICE](NOTICE))

- [swiftui-expert](.claude/skills/swiftui-expert/SKILL.md): SwiftUI 상태·성능·접근성·애니메이션 (`name: swiftui-expert-skill`)
- [swift-concurrency](.claude/skills/swift-concurrency/SKILL.md): async/await·actor·Sendable·Swift 6 마이그레이션
- [swift-testing-expert](.claude/skills/swift-testing-expert/SKILL.md): Swift Testing 작성·XCTest 이관
- [axe](.claude/skills/axe/SKILL.md): iOS 시뮬레이터 CLI 자동화 가이드

### 문서

- [architecture.md](docs/architecture.md): 스킬·에이전트·오케스트레이터가 합성되는 방식과 경계
- [adversarial-improvement.md](docs/adversarial-improvement.md): 병렬 적대 에이전트 루프 설계와 실행법
- [ai-workflow-integration.md](docs/ai-workflow-integration.md): AI-Workflow 배포 시스템에 붙이는 두 방향

## 설치

이 저장소를 클론하면 `.claude/skills`·`.claude/agents`가 그대로 살아 있어, 여기서 Claude Code를 열면 스킬과 에이전트가 바로 동작합니다. Mino 본체에 넣으려면 `.claude/` 아래 내용을 본체의 `.claude/`로 복사합니다.

시뮬레이터 자동화를 실제로 돌리려면 AXe 실행 파일이 필요합니다.

```sh
brew install cameroncooke/axe/axe
axe list-simulators        # UDID 확인
```

벤더링한 SwiftUI·동시성·테스트 스킬은 원본이 Claude Code 플러그인이기도 합니다. 복사본 대신 최신을 추적하려면 플러그인으로 설치할 수 있습니다.

```
/plugin marketplace add AvdLee/Swift-Concurrency-Agent-Skill
/plugin install swift-concurrency
```

## 라이선스

이 저장소는 MIT입니다([LICENSE](LICENSE)). `.claude/skills/` 아래 네 스킬은 외부에서 벤더링한 것이며, 각 원작자의 저작권과 출처는 [NOTICE](NOTICE)에 있습니다.
