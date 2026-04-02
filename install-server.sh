#!/bin/bash
# =====================================================
# server.js 로그인 자동 시작 설치 스크립트
# =====================================================

set -e

# 현재 스크립트 위치 = 앱 폴더
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$APP_DIR/com.irichgreen.server.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.irichgreen.server.plist"
NODE_PATH="$(which node 2>/dev/null || echo '/opt/homebrew/bin/node')"

echo "======================================"
echo "  server.js 자동 시작 설치"
echo "======================================"
echo "  앱 폴더: $APP_DIR"
echo "  Node:    $NODE_PATH"
echo ""

# node 존재 확인
if [ ! -f "$NODE_PATH" ]; then
  echo "❌ Node.js를 찾을 수 없습니다: $NODE_PATH"
  echo "   'which node' 로 경로 확인 후 plist 파일을 직접 수정하세요."
  exit 1
fi

# server.js 존재 확인
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "❌ server.js를 찾을 수 없습니다: $APP_DIR/server.js"
  exit 1
fi

# LaunchAgents 폴더 생성
mkdir -p "$HOME/Library/LaunchAgents"

# plist 복사 및 경로 치환
sed \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  -e "s|/Users/사용자명/youtube-notion-app|$APP_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

# 기존 등록 해제 (있는 경우)
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# 새로 등록
launchctl load "$PLIST_DEST"

# 즉시 시작
launchctl start com.irichgreen.server

echo ""
echo "✅ 설치 완료!"
echo ""
echo "  서버가 http://localhost:3000 에서 시작되었습니다."
echo "  맥북 로그인 시 자동으로 시작됩니다."
echo ""
echo "  로그 확인:"
echo "  tail -f $APP_DIR/server.log"
echo ""
echo "  중지:   launchctl stop com.irichgreen.server"
echo "  제거:   launchctl unload $PLIST_DEST"
