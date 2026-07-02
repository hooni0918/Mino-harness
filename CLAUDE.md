# Mino iOS — AI 작업 지침

Mash-Up MINO 팀의 iOS 앱. 이 저장소는 Mino 본체에 붙일 **QA·접근성·테스트 자동화 번들**의 실험장이다.
여기 정의된 스킬과 에이전트는 아래 프로젝트 규칙을 전제로 동작한다.

## 프로젝트 프로필

- **언어**: Swift 6.0 (strict concurrency)
- **최소 타깃**: iOS 17
- **UI**: SwiftUI (내부 화면 구현은 SwiftUI가 기본. 일부 `UIViewControllerRepresentable` 브리지 허용)
- **아키텍처**: Clean Architecture + DDD
- **빌드**: 로컬 SPM 패키지 (과거 Tuist → SPM 로컬 패키지로 마이그레이션됨), App은 xcodegen 부트스트랩

## 레이어 (의존 방향: 바깥 → 안쪽만)

```
App → Feature → Domain ← Data → Networking
              ↘ DesignSystem ↗        ↘ Core ↙
```

| 레이어 | 역할 | 의존 |
|--------|------|------|
| Core | 공용 유틸 | 무의존 |
| Networking | HTTP 클라이언트, 엔드포인트 | Core |
| Domain | Entity, UseCase, Repository **인터페이스** | Core |
| Data | Repository 구현, DTO, Mapper | Domain, Networking |
| DesignSystem | SwiftUI 컴포넌트, 디자인 토큰 | Core |
| Feature | 화면 (SwiftUI View + 상태) | Domain, DesignSystem |
| App | 컴포지션 루트 (DI 조립) | 전체 |

### 경계 규칙
- **Domain은 바깥을 모른다**: Data/Networking/SwiftUI/Feature import 금지. Package.swift 의존성으로 강제된다.
- **DTO는 Domain에 노출 금지**: Data 내부에서만 쓰고 `toDomain()`으로 변환한다.
- **Entity는 Codable 직접 채택 금지**: API 스키마와 결합되지 않게 한다.
- 구체 타입이 아니라 **Protocol에 의존**한다 (DIP). 구현 주입은 App의 컴포지션 루트에서.

## 접근성-first (이 번들의 전제)

- 인터랙션·검증 대상이 되는 모든 SwiftUI 요소(버튼, 입력 필드, 토글, 핵심 텍스트, 리스트 행)는
  **안정적인 `accessibilityIdentifier`를 가진다**. 이것이 AXe 시뮬레이터 자동화의 선택자가 된다.
- 네이밍: `"<Screen>.<element>"` 계층형. 예) `"Login.emailField"`, `"Login.submitButton"`, `"Home.courseList"`.
- 식별자는 **표시 텍스트가 아니라 역할**에서 온다 (지역화·문구 변경에 안 흔들리게).
- VoiceOver 사용자를 위한 `accessibilityLabel`은 식별자와 별개다. 식별자는 자동화용, 레이블은 사용자용.

## 화면 직행 진입 (QA 자동화 전제)

- `build-runner`가 시뮬레이터에 앱을 설치·실행한 뒤 QA 대상 화면까지 바로 들어가려면 **launch argument 기반
  딥링크**가 필요하다. 앱 진입점(App/컴포지션 루트)에서 `ProcessInfo.processInfo.arguments`를 읽어
  `-qaScreen <ScreenName>` 인자가 있으면 해당 화면으로 직행하는 경로를 둔다.
- 이 규약이 없는 화면은 `build-runner`가 launch만 하고 멈춘다 — AXe 시나리오 앞부분에 홈부터 대상 화면까지의
  내비게이션 탭 시퀀스를 직접 포함시켜야 한다(`test-author`가 시나리오 작성 시 확인).
- 딥링크 인자는 릴리스 빌드에서 비활성화하거나 DEBUG 빌드 컨피그에서만 읽는다 — QA 전용 뒷문을 배포판에 남기지 않는다.

## 테스트-first

- **순수 로직(Domain/Core)**: Swift Testing 단위 테스트. `swift test`로 시뮬레이터 없이 돈다.
- **화면 흐름(Feature)**: AXe 기반 시뮬레이터 UI 자동화. 별도 UI 테스트 타깃 대신 외부 CLI로 구동한다.
- 한 테스트는 한 가지 행동만 검증한다. 전제값은 `#require`, 그 외 단언은 `#expect`.
- 기본은 병렬 안전. 공유 상태를 `.serialized`로 덮기 전에 공유 상태부터 제거를 검토한다.

## 동시성

- strict concurrency가 컴파일러로 강제된다. 데이터 레이스 경고는 빌드 게이트.
- `@MainActor`를 만능 해결책으로 바르지 않는다 (UI 바인딩에 한해 정당화).
- 구조화된 동시성을 선호한다. `Task.detached`는 명확한 이유가 있을 때만.

## 전문 스킬 (이 저장소에 벤더링됨)

코드를 쓰거나 고칠 때 아래 스킬을 그 자리에서 소환해 판단 기준으로 삼는다.

- SwiftUI 작성/리뷰/리팩토링 → `swiftui-expert-skill`
- 동시성·Sendable·Swift 6 마이그레이션 → `swift-concurrency`
- 테스트 작성·XCTest 이관 → `swift-testing-expert`
- 시뮬레이터 자동화 → `axe`

QA 파이프라인 전체는 `mino-qa` 스킬이 오케스트레이션한다.
