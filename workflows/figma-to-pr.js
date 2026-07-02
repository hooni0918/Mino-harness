// figma-to-pr.js — Mino 작업의 입구 하네스 (QA 전용).
//
// Figma URL을 받아 [Opus]가 화면별로 분류하고, 각 단계를 분류기가 배정한 모델로 내려보낸다.
// 첫 판단만 무겁게(Opus), 실행은 가볍게(Sonnet/Haiku).
//
// 경로 분리 — 사람 게이트가 필요한 작업은 배경에서 돌리지 않는다:
//   new      신규 화면      → 파이프라인 밖. 대화형 /ios-workflow 경로 안내만 낸다 (guidance).
//   modify   기존 화면 수정 → screen-modifier가 Figma 원본 대조로 직접 수정 → QA 파이프라인.
//   qa-only  수정 없음      → QA 파이프라인만 (접근성 → 테스트 → 빌드 → QA).
//
// 실행 (반드시 Mino-harness 레포를 cwd로 두고 — .claude/agents 의 에이전트가 등록돼 있어야 함):
//   Workflow({ scriptPath: "workflows/figma-to-pr.js", args: "https://figma.com/..." })
//
// 의존: Figma MCP(claude.ai 인증 — 백그라운드 실행에선 빠질 수 있음), axe CLI(QA 단계).
// 하네스는 커밋을 만들지 않는다 — 수정·식별자 부여는 워킹트리에 남고,
// 사람이 리포트와 diff로 검토한 뒤 커밋한다.

export const meta = {
  name: 'figma-to-pr',
  description: 'Figma URL → Opus 분류 → 화면별 [수정(modify) → 접근성 → 테스트 → 빌드 → QA] 파이프라인. 신규 화면은 대화형 /ios-workflow 안내',
  phases: [
    { title: 'Classify', detail: 'Opus가 Figma를 읽고 화면별 분류 + 단계 모델 배정', model: 'opus' },
    { title: 'Modify', detail: 'screen-modifier가 Figma 원본 대조로 기존 화면 수정 (게이트)' },
    { title: 'Accessibility', detail: 'accessibilityIdentifier 부여 + 매니페스트 파일 (게이트)' },
    { title: 'Tests', detail: 'Swift Testing 단위테스트 + AXe 시나리오 (컴파일 게이트)' },
    { title: 'Build', detail: 'build-runner가 빌드·설치·실행 (빌드 실패는 게이트, 시뮬레이터 미가용은 소프트)' },
    { title: 'QA', detail: '시뮬레이터 실행 + 판정 (미가용이면 HOLD)' },
  ],
}

const figmaUrl = (typeof args === 'string' && args.trim()) ? args.trim()
  : (args && args.figmaUrl) ? args.figmaUrl : null

// 분류기 산출 계획. 판단은 화면 단위 — 전역 플래그가 아니라 screens[].changeType이 경로를 정한다.
const PLAN = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    needsWiki: { type: 'boolean' },
    models: {
      type: 'object',
      description: '각 실행 단계 모델 (opus|sonnet|haiku)',
      properties: {
        modify: { type: 'string' }, accessibility: { type: 'string' },
        tests: { type: 'string' }, build: { type: 'string' }, qa: { type: 'string' },
      },
      required: ['modify', 'accessibility', 'tests', 'build', 'qa'],
    },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          changeType: {
            type: 'string', enum: ['new', 'modify', 'qa-only'],
            description: 'new=코드에 없는 화면(파이프라인 제외, 대화형 안내) / modify=기존 화면에 디자인 반영 / qa-only=수정 없이 검증만',
          },
          figmaNode: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['name', 'changeType'],
      },
    },
  },
  required: ['complexity', 'summary', 'needsWiki', 'models', 'screens'],
}

// 수정 산출물 — Figma 원본 대조 수렴에 실패하면 게이트에서 드롭.
const MODIFY = {
  type: 'object',
  properties: {
    converged: { type: 'boolean', description: 'Figma 원본 재대조에서 차이 0건 도달 여부' },
    files: { type: 'array', items: { type: 'string' } },
    rounds: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['converged', 'files'],
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
    manifestPath: { type: 'string', description: '저장한 매니페스트 파일 경로 (qa/manifests/<Screen>.json)' },
    note: { type: 'string' },
  },
  required: ['identifiers', 'manifestPath'],
}

// 테스트 산출물 — 컴파일조차 안 되면 드롭 (mino-qa 스킬의 게이트 약속을 코드로).
const TESTS = {
  type: 'object',
  properties: {
    compiled: { type: 'boolean', description: 'swift test가 컴파일에 성공했는가' },
    unitPassed: { type: 'number' }, unitFailed: { type: 'number' },
    failures: {
      type: 'array', description: '실패한 단위테스트 목록 (qa-reviewer 리포트의 실패 상세 근거)',
      items: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' } }, required: ['name', 'message'] },
    },
    scenarioPath: { type: 'string', description: 'AXe 시나리오 파일 경로 (qa/scenarios/<screen>.txt)' },
    expectations: { type: 'string', description: '기대 결과 메모 — 어느 식별자가 보이면 성공인지' },
    note: { type: 'string' },
  },
  required: ['compiled'],
}

// 빌드 산출물 — 빌드 실패는 게이트(드롭), 시뮬레이터 미가용은 소프트(QA를 HOLD로 대체).
const BUILD = {
  type: 'object',
  properties: {
    built: { type: 'boolean', description: '빌드 성공 여부' },
    installedAndLaunched: { type: 'boolean', description: '시뮬레이터 설치·실행까지 성공했는가' },
    udid: { type: 'string' },
    note: { type: 'string', description: '대상 없음 사유 / 빌드 실패 핵심 로그 / 화면 직행 딥링크 유무' },
  },
  required: ['built', 'installedAndLaunched'],
}

// 시뮬레이터 실행 산출물 — 다른 모든 단계처럼 명시적 인공물로 구조화한다(architecture.md 약속).
const SIM_RUN = {
  type: 'object',
  properties: {
    screenshots: { type: 'array', items: { type: 'string' }, description: '단계별 스크린샷 경로 (qa-artifacts/*.png)' },
    log: { type: 'string', description: '실행 로그 — 각 스텝 성공/실패, 실패 시 describe-ui 덤프' },
  },
  required: ['screenshots', 'log'],
}

// QA 판정 — 리포트 본문은 그대로 받되, 결과만 구조화해 기계가 집계할 수 있게 한다.
const QA_VERDICT = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASS', 'FAIL', 'PARTIAL', 'HOLD'] },
    report: { type: 'string', description: 'qa-reviewer 판정 리포트 전문 (PR 본문용)' },
  },
  required: ['result', 'report'],
}

const DEFAULTS = { modify: 'sonnet', accessibility: 'sonnet', tests: 'sonnet', build: 'sonnet', qa: 'sonnet' }
const modelFor = (plan, stage) => (plan.models && plan.models[stage]) || DEFAULTS[stage]

if (!figmaUrl) {
  log('Figma URL이 없다. args로 figma.com URL을 넘겨라.')
  return { error: 'no-figma-url' }
}

// ── Phase 1: 분류 (Opus, Figma MCP로 직접 읽기) ──
phase('Classify')
const plan = await agent(
  `Mino iOS 작업의 분류기다. 아래 Figma 디자인을 읽고 작업을 화면 단위로 분류하라.\n\nFigma: ${figmaUrl}\n\n` +
  `Figma MCP 도구로 직접 읽어라: mcp__claude_ai_Figma__get_metadata(구조) → get_design_context(레이아웃/컴포넌트) ` +
  `→ get_screenshot(시각) → get_variable_defs(토큰). 도구를 못 찾으면 그 사실을 summary에 적고 멈춰라(추측 금지).\n\n` +
  `Mino는 SwiftUI · Clean Architecture · Swift 6 / iOS 17+ 다. CLAUDE.md 규칙을 전제로 분류하라.\n` +
  `각 화면의 changeType을 정하라 — 코드베이스에 없는 화면은 new(이 하네스는 신규 구현을 배경 실행하지 않는다. ` +
  `사람 게이트가 있는 대화형 /ios-workflow 몫이다), 기존 화면에 디자인을 반영하면 modify, 수정 없이 검증만 필요하면 qa-only. ` +
  `화면이 코드에 존재하는지는 Grep으로 실제 확인 후 판정하라.\n` +
  `각 단계(modify/accessibility/tests/build/qa) 모델을 복잡도에 맞게 배정하라 — 판단·설계가 무거우면 opus/sonnet, ` +
  `정말 기계적인 변환만 haiku 로 둔다 — 테스트·분석·리뷰가 섞인 단계는 haiku 출력 노이즈가 커서(실측) sonnet 이상으로 둔다.`,
  { model: 'opus', effort: 'high', phase: 'Classify', schema: PLAN }
)

if (!plan) {
  log('분류 실패 — 분류 에이전트가 결과를 내지 못했다.')
  return { figmaUrl, error: 'classify-failed' }
}

const newScreens = (plan.screens || []).filter((s) => s.changeType === 'new')
const pipelineScreens = (plan.screens || []).filter((s) => s.changeType !== 'new')
const guidance = newScreens.map((s) =>
  `${s.name}: 신규 화면 — 배경 파이프라인 대상이 아니다. 대화형 세션에서 /ios-workflow BG <실무|개인> 으로 진행하고, ` +
  `머지 후 이 하네스를 qa-only로 다시 돌려라.${s.notes ? ` (${s.notes})` : ''}`
)

log(`분류: ${plan.complexity} · 파이프라인 ${pipelineScreens.length}개 / 신규 안내 ${newScreens.length}개 · ${plan.summary}`)

// ── 게이트 헬퍼: 드롭을 침묵시키지 않는다 ──
// 스테이지가 throw하면 그 화면은 드롭되고 사유가 dropped[]에 남아 최종 리포트에 포함된다.
// (pipeline의 기본 동작은 throw 시 항목을 null로 지우는 것 — 사유가 사라지므로 marker로 통과시킨다.)
const dropped = []
const gated = (stage, fn) => async (prev, screen, i) => {
  if (prev && prev.droppedAt) return prev
  try {
    return await fn(prev, screen, i)
  } catch (e) {
    const reason = String((e && e.message) || e)
    dropped.push({ screen: screen.name, stage, reason })
    log(`드롭: ${screen.name} @ ${stage} — ${reason}`)
    return { screen: screen.name, droppedAt: stage }
  }
}

// ── Phase 2~6: 화면별 파이프라인 (수정[게이트] → 접근성[게이트] → 테스트[게이트] → 빌드[게이트] → QA[소프트]) ──
const results = pipelineScreens.length === 0 ? [] : await pipeline(
  pipelineScreens,

  // 수정: screen-modifier (modify만 — Figma 원본 대조 수렴 실패면 드롭)
  gated('modify', async (_prev, screen) => {
    if (screen.changeType !== 'modify') return { screen: screen.name, modified: false }
    const m = await agent(
      `${screen.name} 화면을 Figma 디자인 변경에 맞춰 수정하라. Figma: ${figmaUrl}` +
      `${screen.figmaNode ? ` (노드 ${screen.figmaNode})` : ''}. ${screen.notes || ''}\n` +
      `수정 후 Figma 원본을 다시 fetch해 대조하고, 차이 0건까지 수렴시켜라. 수렴하지 못하면 converged=false로 사유와 함께 보고하라.`,
      { agentType: 'screen-modifier', model: modelFor(plan, 'modify'), phase: 'Modify', label: `modify:${screen.name}`, schema: MODIFY }
    )
    if (!m) throw new Error('screen-modifier 응답 없음')
    if (!m.converged) throw new Error(`Figma 대조 수렴 실패${m.note ? ` — ${m.note}` : ''}`)
    return { screen: screen.name, modified: true, modifiedFiles: m.files }
  }),

  // 접근성: accessibility-auditor (식별자 0개면 드롭 — 뒤 단계가 선택자를 못 찾는다)
  gated('accessibility', async (prev, screen) => {
    const m = await agent(
      `${screen.name} 화면의 SwiftUI 뷰에 accessibilityIdentifier를 부여하고, ` +
      `매니페스트를 qa/manifests/${screen.name}.json 파일로 저장한 뒤 식별자 목록(id, kind)과 파일 경로를 반환하라.`,
      { agentType: 'accessibility-auditor', model: modelFor(plan, 'accessibility'), phase: 'Accessibility', label: `a11y:${screen.name}`, schema: A11Y }
    )
    if (!m) throw new Error('accessibility-auditor 응답 없음')
    if (!m.identifiers || m.identifiers.length === 0) throw new Error('인터랙션 식별자 0개 — 접근성 게이트')
    return { ...prev, manifest: m.identifiers, manifestPath: m.manifestPath }
  }),

  // 테스트: test-author (컴파일조차 안 되면 드롭 — mino-qa 스킬의 게이트)
  gated('tests', async (prev, screen) => {
    const t = await agent(
      `${screen.name}의 단위테스트(Swift Testing)와 AXe UI 시나리오를 작성하라. ` +
      `식별자 매니페스트(${prev.manifestPath}):\n${JSON.stringify(prev.manifest)}\n` +
      `작성 후 해당 패키지에서 swift test로 컴파일·실행을 확인하고 결과를 보고하라. ` +
      `실패한 테스트가 있으면 failures에 테스트명·메시지를 담아라.`,
      { agentType: 'test-author', model: modelFor(plan, 'tests'), phase: 'Tests', label: `test:${screen.name}`, schema: TESTS }
    )
    if (!t) throw new Error('test-author 응답 없음')
    if (!t.compiled) throw new Error(`테스트 컴파일 실패${t.note ? ` — ${t.note}` : ''}`)
    return { ...prev, tests: t }
  }),

  // 빌드: build-runner (빌드 실패·대상 없음은 게이트/드롭 — 앱이 안 뜨면 뒤 단계가 근본적으로 무력하다)
  gated('build', async (prev, screen) => {
    const b = await agent(
      `${screen.name} 화면이 포함된 프로젝트를 빌드하고 시뮬레이터에 설치·실행하라. ` +
      `앱 타깃이 없으면 추측하지 말고 built=false와 사유를 보고하라. installedAndLaunched는 반드시 명시적으로 ` +
      `true/false로 보고하라(생략하면 파이프라인이 미가용으로 간주한다).`,
      { agentType: 'build-runner', model: modelFor(plan, 'build'), phase: 'Build', label: `build:${screen.name}`, schema: BUILD }
    )
    if (!b) throw new Error('build-runner 응답 없음')
    if (!b.built) throw new Error(`빌드 실패 또는 대상 없음${b.note ? ` — ${b.note}` : ''}`)
    // 빌드는 됐지만 설치·실행(시뮬레이터 미가용 등)까지는 못 갔으면 드롭하지 않고 QA를 HOLD로 넘긴다.
    // fail-closed: installedAndLaunched가 명시적으로 true가 아니면(누락 포함) 미가용으로 취급한다.
    return { ...prev, build: b, qaAvailable: b.installedAndLaunched === true }
  }),

  // QA: 시뮬레이터 실행 + 판정 (build가 qaAvailable=false로 통과시켰으면 HOLD 직행 — 소프트)
  gated('qa', async (prev, screen) => {
    if (prev.qaAvailable === false) {
      const note = (prev.build && prev.build.note) || '설치·실행 실패'
      return { ...prev, verdict: { result: 'HOLD', report: `시뮬레이터 미가용 — ${note}` } }
    }
    const run = await agent(
      `${screen.name}의 AXe 시나리오(${prev.tests.scenarioPath || 'qa/scenarios/'})를 부팅된 시뮬레이터(udid: ${(prev.build && prev.build.udid) || '자동 탐색'})에서 실행하고 ` +
      `단계별 스크린샷을 남겨라. 앱은 build-runner가 이미 설치·실행했다. 시뮬레이터 미부팅·axe 미설치면 그 사실을 log에 보고하라.`,
      { agentType: 'simulator-qa', model: modelFor(plan, 'qa'), phase: 'QA', label: `qa:${screen.name}`, schema: SIM_RUN }
    )
    const verdict = await agent(
      `${screen.name}의 실행 증거와 테스트 결과로 판정하라. 증거가 부족하면 result=HOLD.\n` +
      `실행:${run ? JSON.stringify(run) : '(실행 결과 없음 — 시뮬레이터/AXe 미가용 가능성)'}\n테스트:${JSON.stringify(prev.tests)}`,
      { agentType: 'qa-reviewer', model: modelFor(plan, 'qa'), phase: 'QA', label: `review:${screen.name}`, schema: QA_VERDICT }
    )
    return { ...prev, verdict: verdict || { result: 'HOLD', report: 'qa-reviewer 응답 없음' } }
  })
)

const done = results.filter(Boolean).filter((r) => !r.droppedAt)
log(
  `완료 ${done.length}/${pipelineScreens.length} · 드롭 ${dropped.length}건 · 신규 안내 ${newScreens.length}건` +
  (plan.needsWiki ? ' · 위키 갱신 권장' : '')
)

return {
  figmaUrl,
  classification: { complexity: plan.complexity, summary: plan.summary },
  models: { ...DEFAULTS, ...(plan.models || {}) },
  screens: done,
  dropped,
  guidance,
  needsWiki: plan.needsWiki,
}
