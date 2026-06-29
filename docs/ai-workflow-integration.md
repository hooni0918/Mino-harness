# AI-Workflow 붙이기

[AI-Workflow](https://github.com/revfactory)는 스킬·규칙·hook을 `make`로 전역 배포(`~/.claude`, `~/.codex`,
`~/.gemini`)하는 시스템이다. 구조는 대략 이렇다.

```
AI-Workflow/
├── deploy/{rules,skills,contexts,hooks,templates}/   # 전역 배포 대상
├── local/                                            # 레포 로컬 스킬/설정
├── scripts/sync_*.py · unsync_*.py                   # 배포 인프라(Python)
└── Makefile                                          # make sync-system / install-hooks / ...
```

이 QA 번들을 AI-Workflow와 엮는 길은 두 가지다. 목적이 다르므로 하나를 고른다.

## 방향 A — 번들을 AI-Workflow로 흡수 (전역 배포)

이 QA 파이프라인을 **모든 프로젝트에서 쓰고 싶을 때**. 번들을 AI-Workflow의 배포 대상으로 옮긴다.

- `.claude/skills/mino-qa/` → `deploy/skills/mino-qa/`
- `.claude/agents/*.md` → AI-Workflow가 에이전트 배포를 지원하면 그 위치, 아니면 `deploy/skills/` 하위로 흡수
- `CLAUDE.md`의 프로젝트 규칙 중 범용적인 것 → `deploy/contexts/`의 적절한 맵 아래
- 벤더 스킬(swiftui-expert 등)은 이미 외부 플러그인이므로, 흡수 대신 **각 프로젝트에서 플러그인 설치**를 권장
  (전역 배포 대상에 외부 코드를 복사해 넣으면 업스트림 갱신이 끊긴다)

AI-Workflow의 "배포 시스템 수정 규약"에 따라, 새 동기화 대상을 추가할 때는 같은 변경 안에서
`Makefile`에 `sync-mino-qa`/`unsync-mino-qa` 타겟과 `scripts/sync_mino_qa.py`/`unsync_mino_qa.py`를 함께 등록하고,
`meta/guides/mino-qa.md`에 수행 작업·제거 기준·반복 실행 기준을 적는다.

```sh
# 흡수 후
make sync-system     # mino-qa 스킬이 ~/.claude/skills 등으로 전역 배포됨
```

**트레이드오프**: 어디서나 `/mino-qa`를 쓸 수 있지만, Mino 전용 가정(SwiftUI-first, 특정 레이어 이름)이
다른 프로젝트엔 안 맞을 수 있다. 범용 부분만 흡수하고 프로젝트 특화는 각 레포 `CLAUDE.md`에 남기는 게 낫다.

## 방향 B — 머신리만 차용 (이 레포 자체 배포)

번들을 **Mino 프로젝트에만** 두되, AI-Workflow의 배포 패턴(원본/산출물 분리 + sync 스크립트)을 빌려온다.

- 원본은 이 레포에 두고, 실제 Mino 프로젝트의 `.claude/`로 복사·동기화하는 가벼운 `Makefile` + `scripts/sync.py`를 둔다.
- AI-Workflow의 "로컬 스킬 원본 기준"과 같은 원칙: `.claude/skills/`(산출물)를 직접 고치지 말고 원본을 고친 뒤 배포.

**트레이드오프**: 전역 오염이 없고 Mino에 딱 맞지만, 배포 인프라를 따로 유지해야 한다.
번들이 작으면 그냥 `cp -R`로 충분하고 인프라는 과하다.

## 권장

- 지금(실험 단계): **아무 것도 흡수하지 말고** 이 레포를 그대로 클론해 `.claude/`가 살아있는 상태로 테스트.
- QA 파이프라인이 안정화되면: **방향 A의 범용 부분만** AI-Workflow로 흡수(전역 `/mino-qa`),
  벤더 스킬은 플러그인 설치, 프로젝트 특화 규칙은 Mino `CLAUDE.md`에 잔류.

## 단방향 참조 원칙

AI-Workflow를 호출(참조)하는 쪽은 이 문서다. 역으로 AI-Workflow 본문이 이 레포 경로를 호명하지 않게 한다
(양방향 결합 금지 — AI-Workflow의 프롬프트 작성 원칙과 동일).
