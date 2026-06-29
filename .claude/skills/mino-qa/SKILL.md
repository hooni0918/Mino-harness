---
name: mino-qa
description: SwiftUI 피쳐가 끝났을 때 접근성 부여 → 테스트 작성 → 시뮬레이터 실행 → 판정을 순서대로 돌리는 QA 파이프라인. "QA 돌려줘", "피쳐 끝났어 검증해줘", "mino-qa" 요청 시 사용. 별도 UI 테스트 타깃 없이 AXe로 화면을 직접 구동한다.
argument-hint: "[대상 화면/파일 또는 브랜치] [--unit-only | --ui-only]"
---

# Mino QA 파이프라인

## 목적

SwiftUI 피쳐가 끝났을 때, 사람이 테스트를 일일이 쓰는 대신 네 단계를 순서대로 돌려 QA를 자동화한다.
각 단계는 독립된 에이전트가 맡고, 앞 단계의 산출물이 뒤 단계의 입력이 된다.

```
화면 작성 끝
  │
  ▼  ① accessibility-auditor   뷰 → accessibilityIdentifier 부여 + 식별자 매니페스트
  │
  ▼  ② test-author             단위테스트(Swift Testing) + AXe UI 시나리오 작성
  │
  ▼  ③ simulator-qa            AXe로 시뮬레이터 실행 + 단계별 스크린샷
  │
  ▼  ④ qa-reviewer             스크린샷+테스트 결과 판정 → PR용 QA 리포트
```

## 절차

1. **대상 확정**: 인자로 화면/파일/브랜치를 받는다. 없으면 `git diff`로 변경된 SwiftUI 뷰를 대상으로 잡는다.
2. **① 접근성**: `accessibility-auditor`를 호출한다. 결과로 **식별자 매니페스트**를 받는다.
   - 게이트: 인터랙션 요소에 식별자가 안 붙으면 여기서 멈추고 보고한다(뒤 단계가 선택자를 못 찾음).
3. **② 테스트 작성**: 매니페스트를 넘겨 `test-author`를 호출한다. 단위테스트 + AXe 시나리오를 받는다.
   - `--unit-only`면 시나리오를 건너뛴다.
   - 게이트: `swift test`가 컴파일조차 안 되면 멈추고 보고한다.
4. **③ 실행**: `simulator-qa`를 호출한다. 시뮬레이터 미부팅/`axe` 미설치면 안내하고 멈춘다.
   - `--unit-only`면 이 단계를 건너뛴다.
5. **④ 판정**: `qa-reviewer`를 호출해 최종 리포트를 받는다.

각 단계는 별도 에이전트 컨텍스트에서 돈다(`Agent` 툴). 메인 컨텍스트는 산출물 요약만 보유한다.

## 단계 매핑

| 단계 | 에이전트 | 소환 스킬 |
|------|----------|-----------|
| ① 접근성 | `accessibility-auditor` | `swiftui-expert-skill` |
| ② 테스트 | `test-author` | `swift-testing-expert`, `swift-concurrency` |
| ③ 실행 | `simulator-qa` | `axe` |
| ④ 판정 | `qa-reviewer` | — (시각 판단) |

## 한계 (반드시 인지)

- **한글 입력 불가**: AXe `type`은 US 키보드 문자만 지원한다. 한글 입력 흐름은 시드 데이터로 우회하거나 시나리오에서 제외한다.
- **접근성 트리 의존**: 식별자가 안 붙은 화면은 선택자로 못 찾는다. ①이 선행되지 않으면 ③이 무력하다.
- **네트워크 타이밍**: AXe HID 명령은 fire-and-forget이라 "처리 완료"를 보장하지 않는다.
  `--wait-timeout` 폴링과 스크린샷 검증으로 보완하되, 그래도 모호하면 `qa-reviewer`가 "판정 보류"로 분리한다.
- **fire-and-forget**: 탭이 뷰가 인터랙티브해지기 전이나 전환 중에 떨어질 수 있다. 결과는 항상 `describe-ui`/`screenshot`로 따로 검증한다.

## 산출물

- 수정된 뷰(식별자 부여) / 단위테스트 / `qa/scenarios/*.txt` / `qa-artifacts/*.png` / QA 판정 리포트
