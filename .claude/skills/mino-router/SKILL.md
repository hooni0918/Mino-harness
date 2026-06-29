---
name: mino-router
description: Figma URL이나 작업 요청을 받아 "무슨 작업인지" 분류하고 적절한 워크플로우·에이전트·모델로 라우팅한다. "이 피그마 만들어줘", "이거 구현해줘" + figma.com URL, "mino-router" 요청 시 사용. figma-to-pr 워크플로우의 분류 두뇌.
argument-hint: "[Figma URL 또는 작업 설명]"
---

# Mino Router

## 목적

Mino 작업의 **입구**다. Figma URL이나 요청을 받아, 비싼 모델로 한 번만 판단하고
나머지 실행은 작업 복잡도에 맞는 모델로 내려보낸다. 첫 판단만 무겁게, 실행은 가볍게.

## 동작

```
입력 (Figma URL / 요청)
  │
  ▼  [Opus] 분류        Figma를 읽고 → changeType·complexity + 각 단계 모델 배정
  │                      + skipImplement(기존 수정이면 구현 생략) + needsWiki
  │
  ▼  단일 파이프라인 (배정 모델로)
     구현(skipImplement면 생략) → 접근성(게이트) → 테스트 → QA
```

실제 실행은 [`workflows/figma-to-pr.js`](../../../workflows/figma-to-pr.js)가 한다. 이 스킬은 그 워크플로우가
따르는 **분류 기준과 라우팅 규칙**을 정의한다.

현재 라우팅은 분류 결과를 **두 가지**로 반영한다: `skipImplement`(새 화면 vs 기존 수정)와 **단계별 모델 배정**
(complexity가 낮으면 더 가벼운 모델). changeType은 모델·생략 판단의 입력으로 쓰인다.
changeType별 세분 분기(`ui-only`면 QA 경량, `architecture`면 설계 분리·문서 생성)는 의도된 확장 방향이며 아직 단일 파이프라인으로 처리한다.

## Figma 읽기

분류는 Figma MCP 읽기 도구로 디자인을 직접 본 뒤 내린다.

| 도구 | 용도 |
|------|------|
| `mcp__claude_ai_Figma__get_metadata` | 노드 구조·계층 파악 (먼저) |
| `mcp__claude_ai_Figma__get_design_context` | 레이아웃·컴포넌트·코드 컨텍스트 |
| `mcp__claude_ai_Figma__get_screenshot` | 시각 확인 |
| `mcp__claude_ai_Figma__get_variable_defs` | 디자인 토큰(색·간격) |

## 분류 기준

- **changeType**: `new-screen` | `modify-screen` | `architecture` | `ui-only`
- **complexity**: `low` | `medium` | `high` (상태 분기·비동기·새 모듈 동반 여부)
- **summary**: 작업 한 줄 요약 (분류 근거)
- **skipImplement**: 기존 화면 수정 등으로 ios-workflow 구현이 불필요하면 `true`
- **screens**: 영향 화면 목록 (이름 + Figma 노드)
- **needsWiki**: 재사용 패턴/아키텍처 결정이 생겨 위키 갱신이 필요한가 (플래그만 — 실행 단계는 후속 과제)

## 모델 배정 (기본값, Opus가 복잡도 보고 조정)

| 단계 | 기본 모델 | 근거 |
|------|-----------|------|
| 분류·설계 | Opus | 1회, 판단이 결과를 좌우 |
| 화면 구현 (ios-workflow) | Sonnet | 코드 작성, 컨텍스트 큼 |
| 접근성 부여 | Sonnet | 코드 편집 동반 |
| 테스트·시나리오 작성 | Haiku | 규칙 기반 텍스트 생성 |
| 시뮬레이터 QA 판정 | Sonnet | 스크린샷 해석 |

## 한계

- **Figma MCP 가용성**: claude.ai 인증 MCP는 백그라운드/헤드리스 실행에서 빠질 수 있다.
  분류 에이전트가 Figma 도구를 못 찾으면 멈추고 보고한다(좌표·추측으로 우회하지 않는다).
- **ios-workflow 의존**: 구현 단계는 전역 설치된 `/ios-workflow` 스킬을 소환한다. 없으면 구현을 건너뛰고 보고한다.
- 라우팅은 분류의 정확도에 달렸다. 분류가 모호하면 Opus가 사용자에게 되묻도록 한다.
