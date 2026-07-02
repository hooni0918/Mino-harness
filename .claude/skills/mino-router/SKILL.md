---
name: mino-router
description: Figma URL이나 작업 요청을 받아 화면 단위로 "무슨 작업인지" 분류하고 적절한 경로(대화형 ios-workflow / 무인 QA 파이프라인)·에이전트·모델로 라우팅한다. "이 피그마 반영해줘", "이거 QA 돌려줘" + figma.com URL, "mino-router" 요청 시 사용. figma-to-pr 워크플로우의 분류 두뇌.
argument-hint: "[Figma URL 또는 작업 설명]"
---

# Mino Router

## 목적

Mino 작업의 **입구**다. Figma URL이나 요청을 받아, 비싼 모델로 한 번만 판단하고
나머지 실행은 작업 복잡도에 맞는 모델로 내려보낸다. 첫 판단만 무겁게, 실행은 가볍게.

라우팅의 제1 기준은 **사람 게이트가 필요한가**다. 신규 화면 구현은 계획 승인·리뷰가 필요한
작업이라 배경에서 돌리지 않고 대화형 경로로 보낸다. 기존 화면 수정·QA는 기계 게이트
(Figma 원본 대조·컴파일·식별자)가 검증을 대신할 수 있어 무인 파이프라인으로 보낸다.

## 동작

```
입력 (Figma URL / 요청)
  │
  ▼  [Opus] 분류        Figma를 읽고 → 화면별 changeType + 단계별 모델 배정
  │
  ├─ new      → 파이프라인 밖. "대화형 /ios-workflow BG <모드>" 안내만 출력 (guidance)
  ├─ modify   → screen-modifier 수정(게이트) → 접근성(게이트) → 테스트(게이트) → 빌드(게이트) → QA
  └─ qa-only  →                              접근성(게이트) → 테스트(게이트) → 빌드(게이트) → QA
```

실제 실행은 [`workflows/figma-to-pr.js`](../../../workflows/figma-to-pr.js)가 한다. 이 스킬은 그 워크플로우가
따르는 **분류 기준과 라우팅 규칙**을 정의한다.

## Figma 읽기

분류는 Figma MCP 읽기 도구로 디자인을 직접 본 뒤 내린다.

| 도구 | 용도 |
|------|------|
| `mcp__claude_ai_Figma__get_metadata` | 노드 구조·계층 파악 (먼저) |
| `mcp__claude_ai_Figma__get_design_context` | 레이아웃·컴포넌트·코드 컨텍스트 |
| `mcp__claude_ai_Figma__get_screenshot` | 시각 확인 |
| `mcp__claude_ai_Figma__get_variable_defs` | 디자인 토큰(색·간격) |

## 분류 기준

- **screens[].changeType** (화면 단위 — 전역 플래그가 아니다):
  - `new`: 코드베이스에 없는 화면. Grep으로 실존 여부를 확인한 뒤 판정한다. 파이프라인 제외, 안내만.
  - `modify`: 기존 화면에 디자인 변경 반영. screen-modifier가 Figma 원본 대조로 수정.
  - `qa-only`: 코드 수정 없이 검증만 (접근성 점검·테스트·시뮬레이터 QA).
- **complexity**: `low` | `medium` | `high` (상태 분기·비동기·새 모듈 동반 여부)
- **summary**: 작업 한 줄 요약 (분류 근거)
- **needsWiki**: 재사용 패턴/아키텍처 결정이 생겨 위키 갱신이 필요한가 (플래그만 — 실행 단계는 후속 과제)

## 모델 배정 (기본값, Opus가 복잡도 보고 조정)

| 단계 | 기본 모델 | 근거 |
|------|-----------|------|
| 분류 | Opus | 1회, 판단이 결과를 좌우 |
| 화면 수정 (screen-modifier) | Sonnet | Figma 대조 + 코드 편집 |
| 접근성 부여 | Sonnet | 코드 편집 동반 |
| 테스트·시나리오 작성 | Sonnet | 분석·리뷰가 섞여 Haiku는 노이즈가 큼 (실측으로 Haiku가 틀린 지적 다수 → 격상) |
| 빌드·설치·실행 (build-runner) | Sonnet | 빌드 로그 판독 + 명령 조합 |
| 시뮬레이터 QA 판정 | Sonnet | 스크린샷 해석 |

## 실패 보고 원칙

게이트에서 떨어진 화면은 조용히 사라지지 않는다 — 최종 리포트의 `dropped[]`에
화면·단계·사유가 남는다. 신규 화면 안내는 `guidance[]`로 분리된다.

## 한계

- **Figma MCP 가용성**: claude.ai 인증 MCP는 백그라운드/헤드리스 실행에서 빠질 수 있다.
  분류 에이전트가 Figma 도구를 못 찾으면 멈추고 보고한다(좌표·추측으로 우회하지 않는다).
- **신규 화면은 여기서 안 만든다**: 신규 구현은 계획 승인·stub 계약·사용자 리뷰가 필요한
  작업이라 대화형 `/ios-workflow`가 담당한다. 하네스는 안내를 내는 데서 멈춘다.
- 라우팅은 분류의 정확도에 달렸다. 분류가 모호하면 Opus가 사용자에게 되묻도록 한다.
