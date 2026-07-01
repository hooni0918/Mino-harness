// figma-to-pr.js — Mino 작업의 입구 하네스.
//
// Figma URL을 받아 [Opus]가 한 번 분류하고, 각 단계를 분류기가 배정한 모델로 내려보낸다.
// 첫 판단만 무겁게(Opus), 실행은 가볍게(Sonnet/Haiku).
//
// 실행 (반드시 Mino-skills-test 레포를 cwd로 두고 — .claude/agents 의 에이전트가 등록돼 있어야 함):
//   Workflow({ scriptPath: "workflows/figma-to-pr.js", args: "https://figma.com/..." })
//
// 의존: 전역 /ios-workflow 스킬, Figma MCP(claude.ai 인증 — 백그라운드 실행에선 빠질 수 있음).

export const meta = {
  name: 'figma-to-pr',
  description: 'Figma URL → Opus가 분류·모델배정 → ios-workflow 구현 + mino-qa(접근성·테스트·QA) 파이프라인',
  phases: [
    { title: 'Classify', detail: 'Opus가 Figma를 읽고 작업 분류 + 단계별 모델 배정', model: 'opus' },
    { title: 'Implement', detail: '배정 모델로 화면 구현 (ios-workflow 소환)' },
    { title: 'Accessibility', detail: '뷰에 accessibilityIdentifier 부여 (게이트)' },
    { title: 'Tests', detail: 'Swift Testing 단위테스트 + AXe 시나리오' },
    { title: 'QA', detail: '시뮬레이터 실행 + 판정 (시뮬레이터 있으면)' },
  ],
}

const figmaUrl = (typeof args === 'string' && args.trim()) ? args.trim()
  : (args && args.figmaUrl) ? args.figmaUrl : null

// 분류기 산출 계획. 각 단계 모델은 Opus가 복잡도 보고 배정한다.
const PLAN = {
  type: 'object',
  properties: {
    changeType: { type: 'string', enum: ['new-screen', 'modify-screen', 'architecture', 'ui-only'] },
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    skipImplement: { type: 'boolean', description: '기존 화면 수정 등으로 ios-workflow 구현이 불필요하면 true' },
    needsWiki: { type: 'boolean' },
    models: {
      type: 'object',
      description: '각 실행 단계 모델 (opus|sonnet|haiku)',
      properties: {
        implement: { type: 'string' }, accessibility: { type: 'string' },
        tests: { type: 'string' }, qa: { type: 'string' },
      },
      required: ['implement', 'accessibility', 'tests', 'qa'],
    },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, figmaNode: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['changeType', 'complexity', 'summary', 'skipImplement', 'needsWiki', 'models', 'screens'],
}

// 접근성 산출물 — 게이트 판정을 위해 구조화해서 받는다.
const A11Y = {
  type: 'object',
  properties: {
    identifiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, kind: { type: 'string' } },
        required: ['id', 'kind'],
      },
    },
    note: { type: 'string' },
  },
  required: ['identifiers'],
}

const DEFAULTS = { implement: 'sonnet', accessibility: 'sonnet', tests: 'sonnet', qa: 'sonnet' }
const modelFor = (plan, stage) => (plan.models && plan.models[stage]) || DEFAULTS[stage]

if (!figmaUrl) {
  log('Figma URL이 없다. args로 figma.com URL을 넘겨라.')
  return { error: 'no-figma-url' }
}

// ── Phase 1: 분류 (Opus, Figma MCP로 직접 읽기) ──
phase('Classify')
const plan = await agent(
  `Mino iOS 작업의 분류기다. 아래 Figma 디자인을 읽고 작업을 분류하라.\n\nFigma: ${figmaUrl}\n\n` +
  `Figma MCP 도구로 직접 읽어라: mcp__claude_ai_Figma__get_metadata(구조) → get_design_context(레이아웃/컴포넌트) ` +
  `→ get_screenshot(시각) → get_variable_defs(토큰). 도구를 못 찾으면 그 사실을 summary에 적고 멈춰라(추측 금지).\n\n` +
  `Mino는 SwiftUI · Clean Architecture · Swift 6 / iOS 17+ 다. CLAUDE.md 규칙을 전제로 분류하라.\n` +
  `각 단계(implement/accessibility/tests/qa) 모델을 복잡도에 맞게 배정하라 — 판단·설계가 무거우면 opus/sonnet, ` +
  `정말 기계적인 변환만 haiku 로 둔다 — 테스트·분석·리뷰가 섞인 단계는 haiku 출력 노이즈가 커서(실측) sonnet 이상으로 둔다. ` +
  `기존 화면 수정이라 새 구현이 불필요하면 skipImplement=true.`,
  { model: 'opus', effort: 'high', phase: 'Classify', schema: PLAN }
)

log(`분류: ${plan.changeType}/${plan.complexity} · 화면 ${plan.screens.length}개 · ${plan.summary}`)

// ── Phase 2~5: 화면별 파이프라인 (구현 → 접근성[게이트] → 테스트 → QA[소프트]) ──
const results = await pipeline(
  plan.screens,

  // 구현: ios-workflow 소환 (기존 수정이면 통과)
  // 모든 스테이지에서 screen은 originalItem(slot2)으로 받는다 — 첫 스테이지도 동일하게 통일.
  (_prev, screen) => plan.skipImplement
    ? { screen: screen.name, implemented: false, note: '기존 화면 수정 — 구현 단계 건너뜀' }
    : agent(
        `/ios-workflow 스킬을 소환해 이 화면을 구현하라. 화면: ${screen.name}` +
        `${screen.figmaNode ? ` (Figma 노드 ${screen.figmaNode})` : ''}. Figma: ${figmaUrl}. ` +
        `${screen.notes || ''}`,
        { model: modelFor(plan, 'implement'), phase: 'Implement', label: `impl:${screen.name}` }
      ).then((out) => ({ screen: screen.name, implemented: true, out })),

  // 접근성: accessibility-auditor (게이트 — 인터랙션 식별자 0개면 throw → 이 화면 드롭)
  (_prev, screen) => agent(
    `${screen.name} 화면의 SwiftUI 뷰에 accessibilityIdentifier를 부여하고, 부여한 식별자 목록(id, kind)을 반환하라.`,
    { agentType: 'accessibility-auditor', model: modelFor(plan, 'accessibility'), phase: 'Accessibility', label: `a11y:${screen.name}`, schema: A11Y }
  ).then((m) => {
    if (!m.identifiers || m.identifiers.length === 0) {
      throw new Error(`${screen.name}: 인터랙션 식별자 0개 — 접근성 게이트에서 드롭`)
    }
    return { screen: screen.name, manifest: m.identifiers }
  }),

  // 테스트: test-author (단위테스트 + AXe 시나리오)
  (prev, screen) => agent(
    `${screen.name}의 단위테스트(Swift Testing)와 AXe UI 시나리오를 작성하라. 식별자 매니페스트:\n${JSON.stringify(prev.manifest)}`,
    { agentType: 'test-author', model: modelFor(plan, 'tests'), phase: 'Tests', label: `test:${screen.name}` }
  ).then((tests) => ({ ...prev, tests })),

  // QA: 시뮬레이터 실행 + 판정 (소프트 — 시뮬레이터 없으면 보고만)
  (prev, screen) => (async () => {
    try {
      const run = await agent(
        `${screen.name}의 AXe 시나리오를 부팅된 시뮬레이터에서 실행하고 단계별 스크린샷을 남겨라. 없거나 axe 미설치면 그 사실을 보고하라.`,
        { agentType: 'simulator-qa', model: modelFor(plan, 'qa'), phase: 'QA', label: `qa:${screen.name}` }
      )
      const verdict = await agent(
        `${screen.name}의 실행 증거와 테스트 결과로 통과/실패를 판정하라.\n실행:${run}\n테스트:${JSON.stringify(prev.tests)}`,
        { agentType: 'qa-reviewer', model: modelFor(plan, 'qa'), phase: 'QA', label: `review:${screen.name}` }
      )
      return { ...prev, verdict }
    } catch (e) {
      return { ...prev, verdict: '시뮬레이터/AXe 미가용 — QA 보류' }
    }
  })()
)

const done = results.filter(Boolean)
log(`완료 화면 ${done.length}/${plan.screens.length}` + (plan.needsWiki ? ' · 위키 갱신 권장' : ''))

return {
  figmaUrl,
  classification: { changeType: plan.changeType, complexity: plan.complexity, summary: plan.summary },
  models: { ...DEFAULTS, ...(plan.models || {}) },
  screens: done,
  needsWiki: plan.needsWiki,
}
