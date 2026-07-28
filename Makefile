# Mino-harness 배포(sync) — 이 번들을 Mino 본체 레포로 복사한다.
#
# 왜 필요한가: 이 레포에는 앱 코드가 없고(그래서 build-runner가 "대상 없음"을 낸다),
# 본체 레포에는 에이전트·워크플로가 없다. 하네스를 실제로 돌리려면 둘을 한 cwd에 모아야 한다.
# docs/ai-workflow-integration.md 의 "방향 B"(머시리만 차용)를 구현한 것.
#
# 사용:
#   make sync   TARGET=/path/to/Team-MINO-iOS   # 본체로 에이전트·스킬·워크플로·게이트 스크립트를 복사
#   make unsync TARGET=/path/to/Team-MINO-iOS   # 복사한 것만 제거(본체 고유 파일은 건드리지 않음)
#
# 복사 후 **본체를 cwd로** Claude Code를 열고:
#   Workflow({ scriptPath: "workflows/figma-to-qa.js", args: "https://figma.com/..." })
#
# 원칙: 추가 복사만 한다(rsync --delete 안 씀) — 본체가 이미 가진 .claude/skills/commit 등을 지우지 않는다.

SHELL := /bin/bash

# 복사 대상 (원본 기준으로 파생 — 번들이 커져도 unsync가 따라간다)
SKILL_DIRS   := $(notdir $(wildcard .claude/skills/*))
AGENT_FILES  := $(notdir $(wildcard .claude/agents/*))
WF_FILES     := $(notdir $(wildcard workflows/*))
# 기본은 "scripts/ 에 추가하면 함께 배치". 단 하네스 레포 자신을 검사하는 스크립트는 앱 레포에
# 가 봐야 대상이 없어 오해만 부른다(ROOT 를 자기 위치에서 잡으므로 엉뚱한 트리를 검사한다).
SCRIPT_EXCLUDE := check_consistency.py
SCRIPT_FILES := $(filter-out $(SCRIPT_EXCLUDE),$(notdir $(wildcard scripts/*)))
# 배치 기록. 타깃 레포에 남아 unsync 가 "지난번에 배치한 것"을 정확히 지운다(gitignore 대상).
MANIFEST     := .claude/.mino-harness-manifest

.PHONY: help sync unsync check-target

help:
	@echo "make sync   TARGET=/path/to/Team-MINO-iOS   # 하네스를 본체로 복사"
	@echo "make unsync TARGET=/path/to/Team-MINO-iOS   # 복사한 것만 제거"

check-target:
	@if [ -z "$(TARGET)" ]; then echo "TARGET 미지정 — make sync TARGET=/path/to/Team-MINO-iOS"; exit 1; fi
	@if [ ! -d "$(TARGET)" ]; then echo "TARGET 디렉터리 없음: $(TARGET)"; exit 1; fi

sync: check-target
	@mkdir -p "$(TARGET)/.claude/agents" "$(TARGET)/.claude/skills" "$(TARGET)/workflows" "$(TARGET)/scripts"
	@rsync -a .claude/agents/  "$(TARGET)/.claude/agents/"
	@rsync -a .claude/skills/  "$(TARGET)/.claude/skills/"
	@rsync -a workflows/       "$(TARGET)/workflows/"
	@# 실행 비트를 보존해야 한다(setup.sh) — cp 대신 rsync -a.
	@rsync -a $(foreach f,$(SCRIPT_EXCLUDE),--exclude '$(f)') scripts/ "$(TARGET)/scripts/"
	@echo "sync 완료 → $(TARGET)"
	@echo "  agents:  $(AGENT_FILES)"
	@echo "  skills:  $(SKILL_DIRS)"
	@echo "  workflows: $(WF_FILES)"
	@echo "  scripts: $(SCRIPT_FILES)"
	@# 배치한 경로를 매니페스트로 남긴다 — 다음 unsync 가 "이번 원본에 있는 것"이 아니라
	@# "지난번에 실제로 배치한 것"을 지울 수 있게. 이게 없으면 원본에서 삭제된 자산이 본체에 고아로 남는다.
	@{ for f in $(AGENT_FILES); do echo ".claude/agents/$$f"; done; \
	   for d in $(SKILL_DIRS); do echo ".claude/skills/$$d"; done; \
	   for f in $(WF_FILES); do echo "workflows/$$f"; done; \
	   for f in $(SCRIPT_FILES); do echo "scripts/$$f"; done; } > "$(TARGET)/$(MANIFEST)"
	@echo
	@echo "먼저 실행 전제를 점검하라 (axe·시뮬레이터·python3):"
	@echo "  cd $(TARGET) && scripts/setup.sh"
	@echo "그다음 본체를 cwd로 열고 /mino-qa <화면>  (또는 /ios-workflow 의 동작 테스트 단계가 자동 소환)"

unsync: check-target
	@if [ -f "$(TARGET)/$(MANIFEST)" ]; then \
	   while IFS= read -r p; do \
	     [ -n "$$p" ] && rm -rf "$(TARGET)/$$p"; \
	   done < "$(TARGET)/$(MANIFEST)"; \
	   rm -f "$(TARGET)/$(MANIFEST)"; \
	   echo "unsync 완료 (매니페스트 기준) → $(TARGET)"; \
	 else \
	   for f in $(AGENT_FILES); do rm -f "$(TARGET)/.claude/agents/$$f"; done; \
	   for d in $(SKILL_DIRS); do rm -rf "$(TARGET)/.claude/skills/$$d"; done; \
	   for f in $(WF_FILES); do rm -f "$(TARGET)/workflows/$$f"; done; \
	   for f in $(SCRIPT_FILES); do rm -f "$(TARGET)/scripts/$$f"; done; \
	   echo "unsync 완료 (매니페스트 없음 — 현재 원본 목록 기준)"; \
	   echo "  주의: 원본에서 이미 삭제된 자산은 본체에 남아 있을 수 있다. 목록을 눈으로 확인하라."; \
	 fi
	@# 비어 있을 때만 지운다(rmdir) — 본체가 원래 갖고 있던 디렉터리는 남는다.
	@rmdir "$(TARGET)/.claude/agents" "$(TARGET)/workflows" "$(TARGET)/scripts" 2>/dev/null || true
