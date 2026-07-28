#!/usr/bin/env bash
# mino-qa 파이프라인의 실행 전제를 점검하고, 빠진 것을 설치한다.
#
# 왜 필요한가: 지금까지 `axe` 미설치는 파이프라인 ④단계(simulator-qa)에서야 드러났다.
# 그 시점이면 이미 뷰 파일을 고치고(①) 테스트를 쓰고(②) 전체 빌드를 마친(③) 뒤다.
# 시작 전에 걸러 그 낭비를 없앤다.
#
# 사용:
#   scripts/setup.sh            점검 + 빠진 것 설치 (설치 전 물어본다)
#   scripts/setup.sh --check    점검만. 빠진 게 있으면 exit 1 (파이프라인 0단계가 쓴다)
#   scripts/setup.sh --yes      물어보지 않고 설치 (무인 실행용)
#
# 종료 코드: 0 = 전제 충족 / 1 = 빠진 것 있음 / 2 = 사용법 오류

set -uo pipefail

MODE=install
ASSUME_YES=0
AXE_RELEASES="https://github.com/cameroncooke/AXe/releases"

for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 인자: $arg (--check / --yes / --help)" >&2; exit 2 ;;
  esac
done

missing=0
note() { printf '  %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$1"; missing=1; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

ask() {
  # 물어보고 y 면 0. --yes 면 묻지 않고 0. 비대화형(파이프 등)이면 1(설치 안 함).
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || { note "비대화형 실행이라 설치를 건너뛴다 (--yes 를 주면 진행)"; return 1; }
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# axe 는 brew 말고 직접 받아 넣는 경우가 흔하다. PATH 에 없다고 바로 미설치로 단정하지 않는다.
find_axe() {
  command -v axe 2>/dev/null && return 0
  for p in "$HOME/.local/bin/axe" /opt/homebrew/bin/axe /usr/local/bin/axe; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

echo "== mino-qa 실행 전제 점검 =="
echo

# ---- 1. axe ----
if axe_path=$(find_axe); then
  axe_ver=$("$axe_path" --version 2>/dev/null | head -1)
  ok "axe ${axe_ver:-(버전 확인 실패)} — $axe_path"
  case ":$PATH:" in
    *":$(dirname "$axe_path"):"*) ;;
    *) warn "$(dirname "$axe_path") 가 PATH 에 없다. 셸 설정에 추가하면 이름만으로 호출된다" ;;
  esac
else
  bad "axe 없음 — 시뮬레이터를 조작할 수 없다"
  if [ "$MODE" = install ]; then
    if ! command -v brew >/dev/null 2>&1; then
      note "Homebrew 가 없다. prebuilt 바이너리를 직접 받아야 한다: $AXE_RELEASES"
    elif ask "brew install cameroncooke/axe/axe 를 실행할까?"; then
      if brew install cameroncooke/axe/axe; then
        ok "axe 설치 완료"
        missing=0
      else
        # 실제로 겪은 실패다. Xcode 는 최신인데 Command Line Tools 만 구버전이면 brew 가 거부한다.
        # 이때 prebuilt 는 빌드를 하지 않으므로 CLT 버전과 무관하게 동작한다.
        warn "brew 설치 실패. Command Line Tools 버전 때문일 수 있다"
        note "그 경우 prebuilt 유니버설 바이너리를 받아 PATH 에 두면 된다(같은 upstream·같은 버전):"
        note "  $AXE_RELEASES"
      fi
    fi
  fi
fi

# ---- 2. 부팅된 시뮬레이터 ----
booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted")
if [ "${booted:-0}" -gt 0 ]; then
  ok "부팅된 시뮬레이터 ${booted}대"
  xcrun simctl list devices booted 2>/dev/null | grep "Booted" | sed 's/^ */  /'
else
  bad "부팅된 시뮬레이터 없음 — ④단계가 돌 곳이 없다"
  if [ "$MODE" = install ]; then
    candidate=$(xcrun simctl list devices available 2>/dev/null | grep -oE 'iPhone [^(]*\([0-9A-F-]{36}\)' | tail -1)
    udid=$(echo "$candidate" | grep -oE '[0-9A-F-]{36}')
    if [ -n "$udid" ] && ask "${candidate% (*} 를 부팅할까?"; then
      xcrun simctl boot "$udid" && open -a Simulator && ok "부팅 요청함" && missing=0
    elif [ -z "$udid" ]; then
      note "사용 가능한 iPhone 시뮬레이터를 찾지 못했다. Xcode 에서 런타임을 설치하라"
    fi
  fi
fi

# ---- 3. 빌드·검사 도구 (설치는 하지 않는다 — Xcode 설치는 스크립트가 대신할 일이 아니다) ----
if xcodebuild -version >/dev/null 2>&1; then
  ok "xcodebuild $(xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}')"
else
  bad "xcodebuild 없음 — Xcode 를 설치하고 xcode-select 로 지정하라"
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  bad "python3 없음 — 매니페스트 기계 검사(verify_manifest.py)를 돌릴 수 없다"
fi

echo
if [ "$missing" = 0 ]; then
  echo "전제 충족. mino-qa 를 돌릴 수 있다."
else
  echo "빠진 것이 있다. 위 ✗ 항목을 해결한 뒤 다시 실행하라: scripts/setup.sh"
fi
exit "$missing"
