// adversarial-harden.js — 병렬 적대 에이전트로 이 번들의 산출물을 단단하게 만드는 워크플로우.
//
// 실행: Claude Code에서 Workflow 툴로 이 스크립트를 돌린다.
//   Workflow({ scriptPath: "workflows/adversarial-harden.js" })                    // cwd가 이 레포일 때
//   Workflow({ scriptPath: ".../adversarial-harden.js", args: "/abs/path/to/repo" }) // 다른 cwd에서 실행할 때
// args로 저장소 절대경로를 넘기면 비평가가 그 경로를 기준으로 파일을 연다. 없으면 cwd 기준.
//
// 한 라운드 = 차원별 비평가가 동시에 산출물을 공격(find) → 각 발견을 독립 검증(verify, refute 우선)
//             → 다수결 생존분만 confirmed로 채택. 사람(또는 메인 에이전트)이 confirmed를 수정에 반영한다.
// "loop-until-dry": 새 발견이 없는 라운드가 2회 연속이면 종료.
//
// 결정론적 정합(호명 오류·죽은 링크·axe 명령 존재·금지 문자열)은 scripts/check_consistency.py가 담당한다.
// 여기 DIMENSIONS는 grep으로 못 잡는 의미론적 판단(약속과 코드의 괴리, 아키텍처 위반 등)만 남긴다.

export const meta = {
  name: 'adversarial-harden',
  description: '이 QA 번들의 에이전트·스킬·README를 차원별 적대 리뷰어로 공격하고, 살아남은 결함만 보고한다',
  phases: [
    { title: 'Find', detail: '차원별 비평가가 동시에 산출물을 공격' },
    { title: 'Verify', detail: '각 발견을 독립 검증 (refute 우선, 다수결)' },
  ],
}

// 저장소 루트. args로 절대경로를 받으면 그 기준, 아니면 cwd 기준.
const ROOT = (typeof args === 'string' && args.trim()) ? args.trim() : '.'

// 공격 차원. 각 비평가는 자기 차원만 본다 — 한 명이 모든 걸 보는 것보다 빈틈이 적다.
const DIMENSIONS = [
  { key: 'harness-truth',  prompt: 'mino-qa/SKILL.md, mino-router/SKILL.md, README.md, docs/*.md 가 약속하는 게이트·산출물·흐름(예: "식별자 0개면 드롭", "빌드 실패면 게이트", "qa/manifests/*.json로 저장")을 workflows/*.js 와 .claude/agents/*.md 의 실제 코드·지시와 대조하라. 문서만 약속하고 코드가 안 지키는 것, 코드에 있는데 문서가 모르는 것을 찾아라.' },
  { key: 'mino-arch-fit',  prompt: 'CLAUDE.md 의 Clean Architecture 레이어 규칙(Domain은 바깥 모름, DTO 비노출, Protocol 의존)에 비춰 에이전트들이 레이어 경계를 위반하도록 유도하는 지점을 찾아라. 예: test-author가 Domain에 Data를 끌어들이게 하는 안내.' },
  { key: 'a11y-coverage',  prompt: 'accessibility-auditor 가 로딩/빈/에러 상태, 리스트 행, 토글 등 자동화에 필요한 요소를 빠뜨릴 수 있는 구멍을 찾아라. 식별자 네이밍이 표시 텍스트에 결합되는 위험도 본다.' },
  { key: 'test-quality',   prompt: 'test-author 가 플레이키 테스트, 병렬 비안전 테스트, 트리비얼 테스트를 만들도록 유도하는 지점을 swift-testing-expert/swift-concurrency 기준으로 찾아라.' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'file', 'detail', 'fix', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

const key = (f) => `${f.file}::${f.title}`
const seen = new Set()
const confirmed = []
let dry = 0

while (dry < 2) {
  // Find: 차원별 비평가 동시 실행 (배리어 — 이번 라운드 발견을 모두 모은 뒤 dedup)
  const found = (await parallel(DIMENSIONS.map((d) => () =>
    agent(
      `이 저장소(Mino-harness QA 번들, 루트: ${ROOT})의 산출물을 적대적으로 검토하라. 차원: ${d.key}\n\n${d.prompt}\n\n` +
      `경로는 모두 ${ROOT} 기준이다. 실제 파일을 Read/Grep으로 직접 열어 근거를 확인한 결함만 보고하라. 추측 금지. 결함이 없으면 빈 배열.`,
      { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }
    )
  ))).filter(Boolean).flatMap((r) => r.findings || [])

  const fresh = found.filter((f) => !seen.has(key(f)))
  if (fresh.length === 0) { dry++; log(`새 발견 0건 (dry ${dry}/2)`); continue }
  dry = 0
  fresh.forEach((f) => seen.add(key(f)))
  log(`이번 라운드 새 발견 ${fresh.length}건 → 검증 진입`)

  // Verify: 각 발견을 독립 검증. refute 우선, 3표 중 2표 이상 생존해야 confirmed.
  const judged = await parallel(fresh.map((f) => () =>
    parallel(Array.from({ length: 3 }, (_, i) => () =>
      agent(
        `다음 결함 주장을 반증하라. 기본 입장은 "반증됨(refuted=true)". 실제 파일을 직접 열어 주장이 틀렸음을 보이지 못할 때만 refuted=false.\n\n` +
        `주장: ${f.title}\n파일: ${f.file}\n근거: ${f.detail}\n제안수정: ${f.fix}`,
        { label: `verify:${f.file}#${i}`, phase: 'Verify', schema: VERDICT }
      )
    )).then((votes) => {
      const survive = votes.filter(Boolean).filter((v) => !v.refuted).length
      return { finding: f, survive, real: survive >= 2 }
    })
  ))

  confirmed.push(...judged.filter((j) => j.real).map((j) => j.finding))
}

log(`확정 결함 ${confirmed.length}건`)
return { confirmed }
