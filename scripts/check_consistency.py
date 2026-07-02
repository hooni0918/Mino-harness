#!/usr/bin/env python3
"""Mino-harness 문서-코드 정합성 검사.

결정론적 규칙만 검사한다 — "이 게이트가 실제로 코드에 있는가" 같은 의미론적 판단은
workflows/adversarial-harden.js(harness-truth 차원)가 담당한다. 여긴 grep으로 끝나는 것만.

검사:
  1. 스킬 호명: SKILL.md 디렉토리명과 frontmatter name이 다른 경우, 문서가 디렉토리명을
     그대로(실제 name 없이) 호명하면 위반.
  2. workflows/*.js 의 agentType: '...' 이 .claude/agents/*.md frontmatter name에 존재하는가.
  3. 모든 .md 상대링크(http/mailto/앵커 제외)의 대상 파일이 실제로 존재하는가.
  4. 에이전트 .md가 쓰는 `axe <subcommand>` 가 axe 스킬 문서(SKILL.md + references/)에 등장하는가.
  5. 금지 문자열 "Mino-skills-test" (이 스크립트 자신은 제외).

위반 시 file:line 형식으로 출력하고 exit 1. 위반 없으면 조용히 exit 0.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve()
EXCLUDE_DIR_NAMES = {".git"}

violations = []


def add(path: Path, line: int, message: str) -> None:
    violations.append(f"{path.relative_to(ROOT)}:{line}: {message}")


def iter_files(pattern: str):
    for p in sorted(ROOT.rglob(pattern)):
        if p.is_file() and not any(part in EXCLUDE_DIR_NAMES for part in p.parts):
            yield p


def read_lines(path: Path):
    return path.read_text(encoding="utf-8").splitlines()


# ---- 1. 스킬 호명: 디렉토리명 vs frontmatter name ----
def check_skill_names():
    skills_root = ROOT / ".claude" / "skills"
    if not skills_root.is_dir():
        return
    dir_to_name = {}
    for skill_md in sorted(skills_root.glob("*/SKILL.md")):
        dirname = skill_md.parent.name
        m = re.search(r"^name:\s*(\S+)", skill_md.read_text(encoding="utf-8"), re.MULTILINE)
        if m:
            dir_to_name[dirname] = m.group(1)

    mismatched = {d: n for d, n in dir_to_name.items() if d != n}
    if not mismatched:
        return

    for path in iter_files("*.md"):
        for i, line in enumerate(read_lines(path), start=1):
            for dirname, real_name in mismatched.items():
                if not re.search(rf"`{re.escape(dirname)}`", line):
                    continue
                # 같은 줄에 실제 name이 함께 있으면 "차이를 설명하는 문장"이지 오호명이 아니다.
                if real_name in line:
                    continue
                add(path, i, f"스킬 오호명: 디렉토리명 `{dirname}`을 그대로 호명함 (실제 name은 `{real_name}`)")


# ---- 2. agentType 참조 존재 ----
def check_agent_types():
    agents_dir = ROOT / ".claude" / "agents"
    agent_names = set()
    if agents_dir.is_dir():
        for agent_md in sorted(agents_dir.glob("*.md")):
            m = re.search(r"^name:\s*(\S+)", agent_md.read_text(encoding="utf-8"), re.MULTILINE)
            if m:
                agent_names.add(m.group(1))

    workflows_dir = ROOT / "workflows"
    if not workflows_dir.is_dir():
        return
    for js_path in sorted(workflows_dir.glob("*.js")):
        for i, line in enumerate(read_lines(js_path), start=1):
            for m in re.finditer(r"agentType:\s*['\"]([a-zA-Z0-9_-]+)['\"]", line):
                name = m.group(1)
                if name not in agent_names:
                    add(js_path, i, f"agentType '{name}' 이 .claude/agents/*.md 에 없음")


# ---- 3. 상대링크 대상 존재 ----
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def check_relative_links():
    for path in iter_files("*.md"):
        for i, line in enumerate(read_lines(path), start=1):
            for m in LINK_RE.finditer(line):
                target = m.group(1).strip()
                if not target or target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                target_path = target.split("#", 1)[0]
                if not target_path:
                    continue
                resolved = (path.parent / target_path).resolve()
                if not resolved.exists():
                    add(path, i, f"링크 대상 없음: {target}")


# ---- 4. axe 서브커맨드 존재 ----
def check_axe_commands():
    axe_dir = ROOT / ".claude" / "skills" / "axe"
    if not axe_dir.is_dir():
        return
    axe_doc_text = ""
    for doc in [axe_dir / "SKILL.md", *sorted((axe_dir / "references").glob("*.md"))]:
        if doc.exists():
            axe_doc_text += doc.read_text(encoding="utf-8") + "\n"

    agents_dir = ROOT / ".claude" / "agents"
    if not agents_dir.is_dir():
        return
    cmd_re = re.compile(r"\baxe\s+([a-z][a-z0-9-]{2,})")
    for agent_md in sorted(agents_dir.glob("*.md")):
        for i, line in enumerate(read_lines(agent_md), start=1):
            for m in cmd_re.finditer(line):
                subcommand = m.group(1)
                if not re.search(rf"\baxe\s+{re.escape(subcommand)}\b", axe_doc_text):
                    add(agent_md, i, f"axe 서브커맨드 '{subcommand}' 이 axe 스킬 문서에 없음")


# ---- 5. 금지 문자열 ----
FORBIDDEN = ["Mino-skills-test"]


def check_forbidden_strings():
    for pattern in ("*.md", "*.js", "*.py"):
        for path in iter_files(pattern):
            if path.resolve() == SELF:
                continue
            for i, line in enumerate(read_lines(path), start=1):
                for token in FORBIDDEN:
                    if token in line:
                        add(path, i, f"금지 문자열 '{token}' 발견")


def main():
    check_skill_names()
    check_agent_types()
    check_relative_links()
    check_axe_commands()
    check_forbidden_strings()

    if violations:
        for v in violations:
            print(v)
        print(f"\n{len(violations)}건 위반", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
