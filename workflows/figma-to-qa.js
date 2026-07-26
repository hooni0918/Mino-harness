// figma-to-qa.js — Mino 작업의 입구 하네스 (QA 전용).
//
// Figma URL을 받아 [Opus]가 화면별로 분류하고, 각 단계를 분류기가 배정한 모델로 내려보낸다.
// 첫 판단만 무겁게(Opus), 실행은 가볍게(Sonnet/Haiku).
//
// 경로 분리 — 사람 게이트가 필요한 작업은 배경에서 돌리지 않는다:
//   new      신규 화면      → 파이프라인 밖. 대화형 /ios-workflow 경로 안내만 낸다 (guidance).
//   modify   기존 화면 수정 → screen-modifier가 Figma 원본 대조로 수정 → design-verifier 독립 대조 게이트 → QA.
//   qa-only  수정 없음      → QA 파이프라인만 (접근성 → 테스트 → 매니페스트 게이트 → 빌드 → QA).
//
// 실행 순서: 화면별 준비(수정→접근성→테스트→매니페스트 게이트)를 순차로 마친 뒤,
//   빌드를 배치 전체에 한 번만 돌리고(공유 시뮬레이터/워킹트리 경합 제거), QA를 화면별 순차 실행한다.
//
// 실행 (반드시 Mino 본체 레포를 cwd로 두고 — make sync 로 .claude/agents·workflows·scripts 를 본체에 배치한 뒤):
//   Workflow({ scriptPath: "workflows/figma-to-qa.js", args: "https://figma.com/..." })
//
// 의존: Figma MCP(claude.ai 인증 — 백그라운드 실행에선 빠질 수 있음), axe CLI(QA 단계), python3(매니페스트 게이트).
// 하네스는 커밋을 만들지 않는다 — 수정·식별자 부여는 워킹트리에 남고,
// 사람이 리포트(qa-artifacts/pr-draft.md)와 diff로 검토한 뒤 커밋·PR을 만든다.

export const meta = {
  name: 'figma-to-qa',
  description: 'Figma URL → Opus 분류 → 화면별 [수정→독립대조→접근성→테스트→매니페스트게이트] 순차 준비 → 빌드 1회 → QA. 신규 화면은 대화형 /ios-workflow 안내. PR 본문 초안 산출',
  phases: [
    { title: 'Classify', detail: 'Opus가 Figma를 읽고 화면별 분류 + 단계 모델 배정', model: 'opus' },
    { title: 'Modify', detail: 'screen-modifier 수정 → design-verifier 독립 대조 게이트' },
    { title: 'Accessibility', detail: 'accessibilityIdentifier 부여 + 매니페스트 파일 (게이트)' },
    { title: 'Tests', detail: 'Swift Testing 단위테스트 + AXe 시나리오 (컴파일 게이트)' },
    { title: 'ManifestGate', detail: 'verify_manifest.py 로 식별자·시나리오 실재 검증 (기계 게이트)' },
    { title: 'Build', detail: 'build-runner가 배치 전체를 한 번 빌드·설치·실행 (실패는 게이트)' },
    { title: 'QA', detail: '시뮬레이터 실행 + 판정 (modify는 Figma 시각 대조, 미가용이면 HOLD)' },
    { title: 'Report', detail: 'PR 본문 초안(qa-artifacts/pr-draft.md) 작성' },
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
    models: {
      type: 'object',
      description: '각 실행 단계 모델',
      properties: {
        modify: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        accessibility: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        tests: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        build: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        qa: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
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
  required: ['complexity', 'summary', 'models', 'screens'],
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

// 독립 대조 판정 — 수정한 에이전트가 아닌 design-verifier가 Figma 원본과 재대조(반증 우선).
const DESIGN_VERDICT = {
  type: 'object',
  properties: {
    matches: { type: 'boolean', description: 'Figma 원본과 차이 0건인가' },
    diffs: {
      type: 'array', description: '어긋난 항목 (있으면 screen-modifier로 재수정 지시)',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, location: { type: 'string' },
        },
        required: ['aspect', 'expected', 'actual'],
      },
    },
    note: { type: 'string', description: 'Figma 미가용 등 판정 불가 사유' },
  },
  required: ['matches'],
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

// 매니페스트 기계 게이트 — verify_manifest.py 실행 결과. 식별자가 소스에 실재하는지·시나리오 --id 가 매니페스트에 있는지.
const MANIFEST_CHECK = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: 'verify_manifest.py 가 exit 0 인가' },
    violations: { type: 'string', description: 'exit≠0 이면 스크립트 stdout(위반 목록)' },
  },
  required: ['passed'],
}

// 빌드 산출물 — 배치 전체 1회. 빌드 실패는 게이트(잔존 화면 전체 드롭), 시뮬레이터 미가용은 소프트(QA를 HOLD).
const BUILD = {
  type: 'object',
  properties: {
    built: { type: 'boolean', description: '빌드 성공 여부' },
    installedAndLaunched: { type: 'boolean', description: '시뮬레이터 설치·실행까지 성공했는가' },
    udid: { type: 'string' },
    note: { type: 'string', description: '대상 없음 사유 / 빌드 실패 핵심 로그(파일:라인) / 화면 직행 딥링크 유무' },
  },
  required: ['built', 'installedAndLaunched'],
}

// Figma 참조 스크린샷 — QA 시각 대조용(modify 화면 한정, best-effort).
const FIGMA_REF = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '저장한 Figma 참조 스크린샷 경로 (실패 시 빈 문자열)' },
    note: { type: 'string' },
  },
  required: ['path'],
}

// 시뮬레이터 실행 산출물.
const SIM_RUN = {
  type: 'object',
  properties: {
    screenshots: { type: 'array', items: { type: 'string' }, description: '단계별 스크린샷 경로 (qa-artifacts/*.png)' },
    log: { type: 'string', description: '실행 로그 — 각 스텝 성공/실패, 실패 시 describe-ui 덤프' },
  },
  required: ['screenshots', 'log'],
}

// QA 판정.
const QA_VERDICT = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASS', 'FAIL', 'PARTIAL', 'HOLD'] },
    report: { type: 'string', description: 'qa-reviewer 판정 리포트 전문 (PR 본문용)' },
  },
  required: ['result', 'report'],
}

// PR 본문 초안 산출.
const DRAFT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '저장한 초안 경로 (qa-artifacts/pr-draft.md)' },
  },
  required: ['path'],
}

const DEFAULTS = { modify: 'sonnet', accessibility: 'sonnet', tests: 'sonnet', build: 'sonnet', qa: 'sonnet' }
const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku']
// 분류기가 배정한 모델을 화이트리스트로 검증한다 — 스키마 enum을 뚫고 온 불량값(예: 전체 모델 ID)이
// agent() 호출을 죽여 화면이 "응답 없음"으로 오드롭되는 것을 막는다. 불량이면 기본값으로 폴백하고 로그를 남긴다.
const modelFor = (plan, stage) => {
  const m = plan.models && plan.models[stage]
  if (ALLOWED_MODELS.includes(m)) return m
  if (m) log(`모델 배정 무시: ${stage}='${m}' 는 허용값(opus|sonnet|haiku) 아님 → ${DEFAULTS[stage]}`)
  return DEFAULTS[stage]
}

if (!figmaUrl) {
  log('Figma URL이 없다. args로 figma.com URL을 넘겨라.')
  return { error: 'no-figma-url' }
}

// ── Phase 1: 분류 (Opus, Figma MCP로 직접 읽기) ──
const plan = await agent(
  `Mino iOS 작업의 분류기다. 아래 Figma 디자인을 읽고 작업을 화면 단위로 분류하라.\n\nFigma: ${figmaUrl}\n\n` +
  `Figma MCP 도구로 직접 읽어라: mcp__claude_ai_Figma__get_metadata(구조) → get_design_context(레이아웃/컴포넌트) ` +
  `→ get_screenshot(시각) → get_variable_defs(토큰). 도구를 못 찾으면 그 사실을 summary에 적고 멈춰라(추측 금지).\n\n` +
  `Mino는 SwiftUI · Clean Architecture · Swift 6 / iOS 17+ 다. CLAUDE.md 규칙을 전제로 분류하라.\n` +
  `각 화면의 changeType을 정하라 — 코드베이스에 없는 화면은 new(이 하네스는 신규 구현을 배경 실행하지 않는다. ` +
  `사람 게이트가 있는 대화형 /ios-workflow 몫이다), 기존 화면에 디자인을 반영하면 modify, 수정 없이 검증만 필요하면 qa-only. ` +
  `화면이 코드에 존재하는지는 Grep으로 실제 확인 후 판정하라.\n` +
  `각 단계(modify/accessibility/tests/build/qa) 모델을 복잡도에 맞게 opus|sonnet|haiku 중에서 배정하라 — 판단·설계가 무거우면 ` +
  `opus/sonnet, 정말 기계적인 변환만 haiku 로 둔다 — 테스트·분석·리뷰가 섞인 단계는 haiku 출력 노이즈가 커서(실측) sonnet 이상으로 둔다.`,
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

// 게이트에서 떨어진 화면은 조용히 사라지지 않는다 — 화면·단계·사유가 dropped[]에 남아 최종 리포트에 포함된다.
const dropped = []

// ── Phase 2~5: 화면별 준비 (순차) — 수정[게이트]→독립대조[게이트]→접근성[게이트]→테스트[게이트]→매니페스트[게이트] ──
// 공유 자원(시뮬레이터·워킹트리)을 나눠 쓰는 빌드·QA는 이 준비 루프 밖으로 빼서 배치 전체에 한 번/순차로 돈다.
const prepared = []
for (const screen of pipelineScreens) {
  let stage = 'start'
  try {
    const ctx = { screen: screen.name, changeType: screen.changeType }

    // 수정 + 독립 대조 (modify만). screen-modifier가 수렴을 선언해도, 만든 쪽이 스스로 통과시키지 않도록
    // design-verifier가 Figma 원본과 반증 우선으로 재대조한다. 차이가 나오면 그 목록으로 1회 재수정 후 재검.
    if (screen.changeType === 'modify') {
      stage = 'modify'
      const nodeHint = screen.figmaNode ? ` (노드 ${screen.figmaNode})` : ''
      let m = await agent(
        `${screen.name} 화면을 Figma 디자인 변경에 맞춰 수정하라. Figma: ${figmaUrl}${nodeHint}. ${screen.notes || ''}\n` +
        `수정 후 Figma 원본을 다시 fetch해 대조하고, 차이 0건까지 수렴시켜라. 수렴하지 못하면 converged=false로 사유와 함께 보고하라.`,
        { agentType: 'screen-modifier', model: modelFor(plan, 'modify'), phase: 'Modify', label: `modify:${screen.name}`, schema: MODIFY }
      )
      if (!m) throw new Error('screen-modifier 응답 없음')
      if (!m.converged) throw new Error(`Figma 대조 수렴 실패${m.note ? ` — ${m.note}` : ''}`)

      let v = await agent(
        `${screen.name} 화면의 수정 결과가 Figma 원본과 일치하는지 반증 우선으로 재대조하라. Figma: ${figmaUrl}${nodeHint}.\n` +
        `수정한 에이전트의 보고를 믿지 말고 Figma를 직접 다시 읽어 색·간격·폰트·문구·구조를 대조하라. 어긋난 곳을 못 찾았을 때만 matches=true.`,
        { agentType: 'design-verifier', model: modelFor(plan, 'modify'), phase: 'Modify', label: `verify:${screen.name}`, schema: DESIGN_VERDICT }
      )
      if (!v) throw new Error('design-verifier 응답 없음')
      if (!v.matches) {
        // 독립 대조에서 나온 차이로 1회 재수정 → 재검. 그래도 안 맞으면 드롭.
        const diffText = (v.diffs || []).map((d) => `- ${d.aspect}: 기대 ${d.expected} / 실제 ${d.actual}${d.location ? ` @${d.location}` : ''}`).join('\n')
        m = await agent(
          `${screen.name} 화면이 아직 Figma와 어긋난다. 아래 차이를 반영해 다시 수정하고 Figma 원본과 재대조해 수렴시켜라. Figma: ${figmaUrl}${nodeHint}.\n${diffText}`,
          { agentType: 'screen-modifier', model: modelFor(plan, 'modify'), phase: 'Modify', label: `modify:${screen.name}#2`, schema: MODIFY }
        )
        v = await agent(
          `${screen.name} 화면의 재수정 결과가 이제 Figma 원본과 일치하는지 반증 우선으로 재대조하라. Figma: ${figmaUrl}${nodeHint}.`,
          { agentType: 'design-verifier', model: modelFor(plan, 'modify'), phase: 'Modify', label: `verify:${screen.name}#2`, schema: DESIGN_VERDICT }
        )
        if (!v || !v.matches) {
          const remain = (v && v.diffs || []).map((d) => `${d.aspect}(기대 ${d.expected}/실제 ${d.actual})`).join(', ')
          throw new Error(`독립 대조 반증 — Figma와 불일치${remain ? `: ${remain}` : (v && v.note ? ` (${v.note})` : '')}`)
        }
      }
      ctx.modified = true
      ctx.modifiedFiles = (m && m.files) || []
    }

    // 접근성 (식별자 0개면 드롭 — 뒤 단계가 선택자를 못 찾는다)
    stage = 'accessibility'
    const a = await agent(
      `${screen.name} 화면의 SwiftUI 뷰에 accessibilityIdentifier를 부여하고, ` +
      `매니페스트를 qa/manifests/${screen.name}.json 파일로 저장한 뒤 식별자 목록(id, kind)과 파일 경로를 반환하라.`,
      { agentType: 'accessibility-auditor', model: modelFor(plan, 'accessibility'), phase: 'Accessibility', label: `a11y:${screen.name}`, schema: A11Y }
    )
    if (!a) throw new Error('accessibility-auditor 응답 없음')
    if (!a.identifiers || a.identifiers.length === 0) throw new Error('인터랙션 식별자 0개 — 접근성 게이트')
    ctx.manifest = a.identifiers
    ctx.manifestPath = a.manifestPath

    // 테스트 (컴파일조차 안 되면 드롭)
    stage = 'tests'
    const t = await agent(
      `${screen.name}의 단위테스트(Swift Testing)와 AXe UI 시나리오를 작성하라. ` +
      `식별자 매니페스트(${ctx.manifestPath}):\n${JSON.stringify(ctx.manifest)}\n` +
      `작성 후 해당 패키지에서 swift test로 컴파일·실행을 확인하고 결과를 보고하라. ` +
      `실패한 테스트가 있으면 failures에 테스트명·메시지를 담아라.`,
      { agentType: 'test-author', model: modelFor(plan, 'tests'), phase: 'Tests', label: `test:${screen.name}`, schema: TESTS }
    )
    if (!t) throw new Error('test-author 응답 없음')
    if (!t.compiled) throw new Error(`테스트 컴파일 실패${t.note ? ` — ${t.note}` : ''}`)
    ctx.tests = t

    // 매니페스트 기계 게이트 — 접근성 단계가 "말로만" 식별자를 낸 게 아니라 소스에 실재하는지,
    // 시나리오의 --id가 매니페스트에 등록됐는지 verify_manifest.py로 결정론적으로 확인한다(빌드 비용 전에).
    stage = 'manifest-gate'
    const mc = await agent(
      `\`python3 scripts/verify_manifest.py ${screen.name}\` 를 실행하라. 이 스크립트는 매니페스트(qa/manifests/${screen.name}.json)의 ` +
      `각 식별자가 실제 .swift 소스에 반영됐는지와 QA 시나리오의 --id가 매니페스트에 있는지 검사한다. ` +
      `exit 0 이면 passed=true, 아니면 passed=false와 stdout(위반 목록)을 violations에 담아라. 스크립트/파일이 없으면 passed=false와 사유를 보고하라. 코드를 수정하지 마라.`,
      { agentType: 'general-purpose', model: 'haiku', effort: 'low', phase: 'ManifestGate', label: `manifest:${screen.name}`, schema: MANIFEST_CHECK }
    )
    if (!mc) throw new Error('매니페스트 검증 에이전트 응답 없음')
    if (!mc.passed) throw new Error(`매니페스트 기계검증 실패 — ${mc.violations || '위반 상세 없음'}`)

    prepared.push(ctx)
  } catch (e) {
    const reason = String((e && e.message) || e)
    dropped.push({ screen: screen.name, stage, reason })
    log(`드롭: ${screen.name} @ ${stage} — ${reason}`)
  }
}

// ── Phase 6: 빌드 (배치 전체 1회, 배리어) ──
// 준비를 통과한 화면들의 수정이 모두 워킹트리에 쌓인 상태를 한 번 빌드한다.
// 화면마다 빌드하면 반쯤 진행된 다른 화면의 수정이 섞여 플레이키 실패가 나므로, 전 화면 준비 후 1회로 모은다.
let build = null
let qaAvailable = false
if (prepared.length > 0) {
  build = await agent(
    `준비된 ${prepared.length}개 화면(${prepared.map((p) => p.screen).join(', ')})의 수정이 워킹트리에 반영된 프로젝트를 빌드하고 ` +
    `시뮬레이터에 설치·실행하라. 앱 타깃이 없으면 추측하지 말고 built=false와 사유를 보고하라. installedAndLaunched는 반드시 명시적으로 ` +
    `true/false로 보고하라(생략하면 파이프라인이 미가용으로 간주한다). 빌드 실패 시 첫 에러의 파일:라인을 note에 담아라.`,
    { agentType: 'build-runner', model: modelFor(plan, 'build'), phase: 'Build', label: 'build:batch', schema: BUILD }
  )
  if (!build || !build.built) {
    const reason = `빌드 실패 또는 대상 없음${build && build.note ? ` — ${build.note}` : ''}`
    prepared.forEach((p) => dropped.push({ screen: p.screen, stage: 'build', reason }))
    log(`빌드 게이트 드롭: ${prepared.length}개 화면 — ${reason}`)
    prepared.length = 0
  } else {
    // fail-closed: installedAndLaunched가 명시적으로 true가 아니면(누락 포함) 미가용으로 취급 → QA는 HOLD.
    qaAvailable = build.installedAndLaunched === true
    if (!qaAvailable) log(`시뮬레이터 미가용 — QA는 HOLD로 진행 (${build.note || '설치·실행 실패'})`)
  }
}

// ── Phase 7: QA (화면별 순차) ── 시뮬레이터 1대를 나눠 쓰므로 순차. modify는 Figma 시각 대조를 붙인다.
const results = []
for (const ctx of prepared) {
  if (!qaAvailable) {
    results.push({ ...ctx, verdict: { result: 'HOLD', report: `시뮬레이터 미가용 — ${(build && build.note) || '설치·실행 실패'}` } })
    continue
  }

  // modify 화면은 Figma 참조 스크린샷을 확보해 렌더링 결과와 시각 대조한다(best-effort — 실패 시 reviewer가 HOLD).
  let figmaRefPath = ''
  if (ctx.changeType === 'modify') {
    const screenMeta = pipelineScreens.find((s) => s.name === ctx.screen)
    const nodeHint = screenMeta && screenMeta.figmaNode ? ` (노드 ${screenMeta.figmaNode})` : ''
    const ref = await agent(
      `${ctx.screen} 화면의 Figma 참조 스크린샷을 확보하라. Figma: ${figmaUrl}${nodeHint}. ` +
      `Figma MCP(get_screenshot 또는 download 계열)로 이미지를 받아 qa-artifacts/${ctx.screen}-figma.png 로 저장하고 그 경로를 path로 반환하라. ` +
      `Figma 도구를 못 찾거나 저장에 실패하면 path를 빈 문자열로 두고 사유를 note에 적어라(추측 금지).`,
      { agentType: 'general-purpose', model: modelFor(plan, 'qa'), effort: 'low', phase: 'QA', label: `figma-ref:${ctx.screen}`, schema: FIGMA_REF }
    )
    figmaRefPath = (ref && ref.path) || ''
  }

  const run = await agent(
    `${ctx.screen}의 AXe 시나리오(${ctx.tests.scenarioPath || 'qa/scenarios/'})를 부팅된 시뮬레이터(udid: ${(build && build.udid) || '자동 탐색'})에서 실행하고 ` +
    `단계별 스크린샷을 남겨라. 앱은 build-runner가 이미 설치·실행했다. 시뮬레이터 미부팅·axe 미설치면 그 사실을 log에 보고하라.`,
    { agentType: 'simulator-qa', model: modelFor(plan, 'qa'), phase: 'QA', label: `qa:${ctx.screen}`, schema: SIM_RUN }
  )
  const verdict = await agent(
    `${ctx.screen}의 실행 증거와 테스트 결과로 판정하라. 증거가 부족하면 result=HOLD.\n` +
    `실행:${run ? JSON.stringify(run) : '(실행 결과 없음 — 시뮬레이터/AXe 미가용 가능성)'}\n테스트:${JSON.stringify(ctx.tests)}\n` +
    (ctx.changeType === 'modify'
      ? (figmaRefPath
        ? `Figma 참조 스크린샷:${figmaRefPath} — 시뮬레이터 스크린샷과 시각 대조(레이아웃·잘림·색·폰트)해 결과에 포함하라.`
        : `Figma 참조 스크린샷 없음(미가용) — 시각 대조는 판정 보류로 분리하라.`)
      : ''),
    { agentType: 'qa-reviewer', model: modelFor(plan, 'qa'), phase: 'QA', label: `review:${ctx.screen}`, schema: QA_VERDICT }
  )
  results.push({ ...ctx, verdict: verdict || { result: 'HOLD', report: 'qa-reviewer 응답 없음' } })
}

const done = results
log(`완료 ${done.length}/${pipelineScreens.length} · 드롭 ${dropped.length}건 · 신규 안내 ${newScreens.length}건`)

// ── Phase 8: PR 본문 초안 산출 ── 화면별 판정·드롭·안내를 팀 PR 템플릿에 맞춰 파일로 남긴다.
let prDraftPath = ''
if (pipelineScreens.length > 0 || guidance.length > 0) {
  const draft = await agent(
    `아래 QA 실행 결과로 Mino 팀 PR 본문 초안을 마크다운으로 작성해 qa-artifacts/pr-draft.md 로 저장하고 경로를 path로 반환하라.\n` +
    `팀 템플릿 섹션(## 📌 Related Issue / ## 🚀 Description / ## ✅ Done / ## 📸 Screenshot / ## 📢 Notes / ## 🧪 Testing)을 쓰되, ` +
    `Description에 분류 요약, Done에 화면별 QA 판정(PASS/FAIL/PARTIAL/HOLD)과 판정 리포트 요약, Screenshot에 qa-artifacts 스크린샷 경로, ` +
    `Notes에 드롭된 화면(화면·단계·사유)과 신규 화면 안내(guidance)를 담아라. 이 초안은 사람이 검토 후 커밋·PR을 만든다는 주석을 상단에 한 줄 남겨라.\n\n` +
    `분류: ${JSON.stringify({ complexity: plan.complexity, summary: plan.summary })}\n` +
    `판정: ${JSON.stringify(done.map((d) => ({ screen: d.screen, changeType: d.changeType, verdict: d.verdict })))}\n` +
    `드롭: ${JSON.stringify(dropped)}\n안내: ${JSON.stringify(guidance)}`,
    { agentType: 'general-purpose', model: modelFor(plan, 'qa'), phase: 'Report', label: 'pr-draft', schema: DRAFT }
  )
  prDraftPath = (draft && draft.path) || ''
}

return {
  figmaUrl,
  classification: { complexity: plan.complexity, summary: plan.summary },
  models: { ...DEFAULTS, ...(plan.models || {}) },
  screens: done,
  dropped,
  guidance,
  prDraftPath,
}
