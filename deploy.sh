#!/bin/bash
# =========================================================
# GitHub 자동 업로드 스크립트
# 사용법: bash deploy.sh
# 또는 최초 1회 실행 권한 부여 후: ./deploy.sh
# =========================================================

# ── 색상 출력 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}================================================${NC}"
echo -e "${BOLD}${CYAN}  YouTube → Notion AI 요약기 GitHub 업로드${NC}"
echo -e "${BOLD}${CYAN}================================================${NC}"
echo ""

# ── 현재 폴더로 이동 ──
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
echo -e "${BLUE}📁 폴더: $APP_DIR${NC}"
echo ""

# ── Git 설치 확인 ──
if ! command -v git &>/dev/null; then
  echo -e "${RED}❌ Git이 설치되어 있지 않습니다.${NC}"
  echo "   https://git-scm.com 에서 설치 후 다시 실행하세요."
  exit 1
fi

# ── .gitignore 자동 생성 (API 키 등 민감 파일 제외) ──
if [ ! -f ".gitignore" ]; then
  cat > .gitignore << 'GITIGNORE'
# API 키가 담긴 파일 제외
playlists.json
scheduler.log
scheduler-error.log
*.env
.env*
node_modules/
.DS_Store
GITIGNORE
  echo -e "${GREEN}✅ .gitignore 생성됨 (playlists.json, 로그파일 제외)${NC}"
fi

# ── scheduler.js API 키 노출 경고 ──
if grep -q "AIzaSy\|secret_\|ntn_" "$APP_DIR/scheduler.js" 2>/dev/null; then
  echo -e "${RED}⚠️  경고: scheduler.js 에 API 키가 포함되어 있습니다!${NC}"
  echo -e "${YELLOW}   GitHub에 올리면 API 키가 공개됩니다.${NC}"
  echo ""
  echo -e "${YELLOW}   계속 진행하시겠습니까? (scheduler.js 는 업로드에서 제외됩니다)${NC}"

  # scheduler.js를 .gitignore에 추가
  if ! grep -q "scheduler.js" .gitignore; then
    echo "scheduler.js" >> .gitignore
    echo -e "${GREEN}   → scheduler.js 를 .gitignore 에 추가했습니다.${NC}"
  fi
  echo ""
fi

# ── Git 초기화 여부 확인 ──
if [ ! -d ".git" ]; then
  echo -e "${YELLOW}📌 Git 저장소가 초기화되어 있지 않습니다.${NC}"
  echo ""
  echo -n "GitHub 저장소 URL을 입력하세요 (예: https://github.com/아이디/저장소명.git): "
  read REMOTE_URL

  if [ -z "$REMOTE_URL" ]; then
    echo -e "${RED}❌ URL이 입력되지 않았습니다.${NC}"; exit 1
  fi

  git init
  git remote add origin "$REMOTE_URL"
  git branch -M main
  echo -e "${GREEN}✅ Git 저장소 초기화 완료${NC}"
  echo ""
fi

# ── 현재 원격 주소 확인 ──
REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE" ]; then
  echo -e "${RED}❌ GitHub 원격 저장소가 설정되어 있지 않습니다.${NC}"
  echo -n "GitHub 저장소 URL 입력: "
  read REMOTE_URL
  git remote add origin "$REMOTE_URL"
fi

echo -e "${BLUE}🔗 원격 저장소: $(git remote get-url origin)${NC}"
echo ""

# ── 커밋 메시지 입력 ──
echo -n "커밋 메시지를 입력하세요 (Enter = 자동 메시지): "
read COMMIT_MSG

if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG="업데이트 $(date '+%Y-%m-%d %H:%M')"
fi

# ── 변경사항 확인 ──
CHANGES=$(git status --porcelain 2>/dev/null)
if [ -z "$CHANGES" ]; then
  echo -e "${YELLOW}ℹ️  변경된 파일이 없습니다. 업로드를 건너뜁니다.${NC}"
  exit 0
fi

echo -e "${CYAN}📝 변경된 파일:${NC}"
git status --short
echo ""

# ── 업로드 실행 ──
echo -e "${CYAN}⬆️  GitHub에 업로드 중...${NC}"
git add -A

if ! git commit -m "$COMMIT_MSG"; then
  echo -e "${RED}❌ 커밋 실패. Git 사용자 정보를 설정하세요:${NC}"
  echo "   git config --global user.email '이메일'"
  echo "   git config --global user.name '이름'"
  exit 1
fi

if ! git push -u origin main 2>&1; then
  echo ""
  echo -e "${YELLOW}💡 처음 push 시 GitHub 로그인이 필요할 수 있습니다.${NC}"
  echo "   GitHub 아이디/패스워드 또는 Personal Access Token을 입력하세요."
  echo "   토큰 발급: https://github.com/settings/tokens"
  exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}  ✅ GitHub 업로드 완료!${NC}"
echo -e "${GREEN}  커밋: $COMMIT_MSG${NC}"
echo -e "${GREEN}  저장소: $(git remote get-url origin)${NC}"
echo -e "${GREEN}${BOLD}================================================${NC}"
echo ""
