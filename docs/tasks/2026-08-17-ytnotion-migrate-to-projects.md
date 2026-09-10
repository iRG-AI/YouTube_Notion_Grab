# 작업지시서 — Youtube_Notion_Grap 폴더 이관 (Projects/ 표준 경로)

- 작성일: 2026-08-17
- 대상 프로젝트: **Youtube_Notion_Grap** (Daily_Investment_Info와 무관, 별도 레포)
- GitHub: `iRG-AI/YouTube_Notion_Grab` (main)
- 성격: **인프라 이관** — 코드 로직 변경 없음
- 위험도: **높음** (launchd 데몬 3개 + MCP 서버 1개가 현 경로에 물려 있음)

```
FROM  /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap
TO    /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
```

---

## 1. 현황

Daily_Investment_Info는 `Projects/`로 이관됐으나 이 프로젝트는 구 경로에 남아 있다.
그런데 **살아서 돌고 있다** — `scheduler.log`·`wiki_index.vec`가 2026-08-17 12:01에 갱신됨.

경로를 물고 있는 것들:

| 종류 | 이름 | 상태 | 스케줄 |
|---|---|---|---|
| launchd | `com.irichgreen.server` | PID 961 상주 | `KeepAlive`, `RunAtLoad=true` |
| launchd | `com.irichgreen.wiki-ingest` | 대기 | 매일 03:00 |
| launchd | `com.irichgreen.ytsummarizer` | 대기 | 00/06/12/18시 |
| MCP | `wiki-search` | Connected | `node .../wiki_mcp.js` |

폴더만 옮기면 이 4개가 전부 죽는다. 아래 순서를 지킬 것.

## 2. ⚠️ 사전 확인 — 미커밋 변경부터 처리

**이관 전에 반드시 커밋한다.** 현재 미커밋 상태가 남아 있다:

```
 M .gitignore          M scheduler.js        M server.js
 M sync_obsidian.py    M com.irichgreen.{server,wiki-ingest,ytsummarizer}.plist
?? build_search_index.py  ?? lib/wiki_search.js  ?? wiki.html  ?? wiki_mcp.js
```

```bash
cd /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap
git status
git add -A
git commit -m "chore: 이관 전 작업분 커밋 (wiki search / MCP 서버 추가)"
```

⚠️ `git add -A` 전에 `.gitignore`가 `.env`·`.claude/settings.local.json`·상태 파일들을
제대로 막고 있는지 `git status`로 눈으로 확인할 것. `.env`에 API 키가 들어 있다.

## 3. 이관 절차

### 3-1. 데몬 정지 (반드시 이동 전에)

```bash
for L in com.irichgreen.server com.irichgreen.wiki-ingest com.irichgreen.ytsummarizer; do
  launchctl unload ~/Library/LaunchAgents/$L.plist
done

launchctl list | grep irichgreen      # server/wiki-ingest/ytsummarizer 사라졌는지 확인
pgrep -fl "Youtube_Notion_Grap"       # 잔존 프로세스 없어야 함 (있으면 kill)
```

상태 파일(`wiki_index.vec` 8.8MB, `pending_playlist_adds.json` 2.2MB,
`.wiki_state.json`, `.migrate_state.json`)을 쓰는 중에 옮기면 깨진다.
**프로세스가 완전히 죽은 뒤 이동한다.**

### 3-2. 폴더 이동

`cp`가 아니라 `mv`를 쓴다. 같은 볼륨이라 즉시 끝나고, `.env`·`.claude/`·상태 파일 등
gitignore 대상까지 통째로 따라간다 (git clone으로는 복제되지 않는 것들이다).

```bash
mv /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap \
   /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap

NEW=/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
ls -la $NEW/.env $NEW/.claude $NEW/wiki_index.vec   # 딸려왔는지 확인
git -C $NEW log --oneline -2                        # 히스토리 보존 확인
```

### 3-3. LaunchAgents plist 3개 수정 (총 6군데)

각 plist의 `ProgramArguments`(스크립트 경로)와 `WorkingDirectory` 두 곳씩이다.
로그 경로(`~/Library/Logs/irichgreen/`)는 그대로 두고 건드리지 않는다.

```bash
OLD="/Users/tycoonan/Documents/Claude/Youtube_Notion_Grap"
NEW="/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap"

for L in com.irichgreen.server com.irichgreen.wiki-ingest com.irichgreen.ytsummarizer; do
  F=~/Library/LaunchAgents/$L.plist
  cp "$F" "$F.bak"                       # 롤백용
  sed -i '' "s#$OLD#$NEW#g" "$F"
  plutil -lint "$F"
done

grep -h "Youtube_Notion_Grap" ~/Library/LaunchAgents/com.irichgreen.{server,wiki-ingest,ytsummarizer}.plist
```

마지막 grep 결과가 **6줄 모두 `Projects/Youtube_Notion_Grap`** 이어야 한다.
`plutil -lint`가 3개 다 `OK`가 아니면 즉시 `.bak`으로 되돌린다.

### 3-4. 레포 안의 plist 사본 처리

레포에도 같은 이름의 plist 3개가 들어 있는데 내용이 제각각이다.

| 파일 | 현재 내용 | 조치 |
|---|---|---|
| `com.irichgreen.server.plist` | `/Users/사용자명/youtube-notion-app` (placeholder) | **그대로 둠** — 배포용 템플릿 |
| `com.irichgreen.ytsummarizer.plist` | placeholder | **그대로 둠** |
| `com.irichgreen.wiki-ingest.plist` | 실제 경로가 박혀 있음 | **새 경로로 갱신** |

```bash
sed -i '' "s#$OLD#$NEW#g" $NEW/com.irichgreen.wiki-ingest.plist
```

> 3개의 스타일이 통일돼 있지 않은 건 원래 있던 문제다. 이번엔 경로만 맞추고,
> placeholder 통일은 별도 작업으로 미룬다 (§7).

### 3-5. 소스 내 하드코딩 경로 수정

```bash
grep -rn "Documents/Claude/Youtube_Notion_Grap" $NEW \
  --include="*.py" --include="*.js" --include="*.json" \
  | grep -v node_modules | grep -v "^.*/.git/"
```

수정 대상 3건:

| 파일 | 내용 |
|---|---|
| `check_duplicates.py:7` | `open('.../Youtube_Notion_Grap/.env')` — **깨지므로 반드시 수정** |
| `wiki_mcp.js:4` | MCP 등록 안내 주석 — 문서 정합성 차원에서 수정 |
| `.claude/settings.local.json:25` | Bash 허용 규칙에 박힌 `.env` 경로 — 수정 |

⚠️ **Obsidian VAULT 경로는 절대 건드리지 말 것.**
`wiki_config.py`, `sync_obsidian.py`, `lib/wiki_search.js`, `notion_to_obsidian.js`,
`cleanup_duplicates.py`, `build_obsidian_wiki.py`의
`/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/...`는 이번 이관과 무관하다.
일괄 sed를 돌리지 말고 위 3건만 개별 수정한다.

`install-*.sh`, `deploy.sh`는 `APP_DIR="$(cd "$(dirname "$0")" && pwd)"` 상대경로라 수정 불필요.

### 3-6. MCP 서버 재등록

`wiki-search`가 옛 경로로 등록돼 있다.

```bash
claude mcp get wiki-search        # 먼저 scope(user/project/local) 확인
claude mcp remove wiki-search
claude mcp add wiki-search -- node /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap/wiki_mcp.js
claude mcp list | grep wiki-search # ✔ Connected 확인
```

기존과 **동일한 scope**로 다시 등록할 것. scope가 다르면 다른 세션에서 안 보인다.

### 3-7. 데몬 재기동

```bash
for L in com.irichgreen.server com.irichgreen.wiki-ingest com.irichgreen.ytsummarizer; do
  launchctl load ~/Library/LaunchAgents/$L.plist
done

launchctl list | grep irichgreen   # 3개 모두 2번째 열(종료코드)이 0
```

`com.irichgreen.server`만 `RunAtLoad=true`라 즉시 기동한다.
나머지 둘은 스케줄(03:00 / 00·06·12·18시)까지 대기 상태가 정상이다.

## 4. 검증

### 4-1. 프로세스가 새 경로를 물고 있는지

```bash
ps -o pid,lstart,command -p $(pgrep -f "Youtube_Notion_Grap")
```

→ `Projects/Youtube_Notion_Grap/server.js` 여야 한다. 구 경로가 보이면 unload/load 재실행.

### 4-2. server 살아있는지

```bash
tail -20 ~/Library/Logs/irichgreen/ytnotion-server.log
tail -20 ~/Library/Logs/irichgreen/ytnotion-server-err.log   # 비어 있어야 정상
lsof -i -P -n | grep -i node | grep LISTEN                    # 리슨 포트 확인
```

### 4-3. 스케줄 잡 수동 1회 실행

스케줄 시각까지 기다리지 말고 지금 강제 실행해 본다.

```bash
launchctl start com.irichgreen.ytsummarizer
sleep 20 && tail -30 ~/Library/Logs/irichgreen/ytsummarizer.log

launchctl start com.irichgreen.wiki-ingest
sleep 30 && tail -30 ~/Library/Logs/irichgreen/wiki-ingest.log
```

`ModuleNotFoundError`, `Cannot find module`, `ENOENT ... no such file or directory`가
뜨면 경로 누락이다. 로그에 찍힌 경로를 그대로 확인할 것.

> `wiki-ingest`는 brew가 아니라 **`/usr/bin/python3`(시스템 파이썬)**을 쓴다.
> 의존성이 `--user`로 깔려 있을 수 있으니 import 에러가 나면 이쪽을 먼저 의심한다.

### 4-4. MCP 동작

```bash
claude mcp list | grep wiki-search
```

→ `✔ Connected`.

### 4-5. 상태 파일 무결성

```bash
NEW=/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
python3 -c "import json;[json.load(open(f'$NEW/{n}')) and print(f'{n} OK') for n in ['.wiki_state.json','.migrate_state.json','pending_playlist_adds.json','wiki_index.json']]"
ls -l $NEW/wiki_index.vec    # 8.8MB 내외 유지
```

## 5. 롤백

문제가 생기면 순서를 그대로 뒤집는다.

```bash
for L in com.irichgreen.server com.irichgreen.wiki-ingest com.irichgreen.ytsummarizer; do
  launchctl unload ~/Library/LaunchAgents/$L.plist
  mv ~/Library/LaunchAgents/$L.plist.bak ~/Library/LaunchAgents/$L.plist
done

mv /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap \
   /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap

claude mcp remove wiki-search
claude mcp add wiki-search -- node /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap/wiki_mcp.js

for L in com.irichgreen.server com.irichgreen.wiki-ingest com.irichgreen.ytsummarizer; do
  launchctl load ~/Library/LaunchAgents/$L.plist
done
```

## 6. 마무리

### 6-1. 구 백업 폴더 정리

```bash
mv /Users/tycoonan/Claude/Youtube_Notion_Grap \
   /Users/tycoonan/Claude/Youtube_Notion_Grap_BACKUP_20260717
```

(7/17 스냅샷이며 현역이 아니다. Daily_Investment_Info와 동일한 규칙으로 이름만 변경.)

### 6-2. 문서 갱신

- `CLAUDE.md` (프로젝트 내, 5/21자) — 경로 언급이 있으면 새 경로로 수정하고,
  §3 성격의 **launchd 3종 주의사항** 섹션을 추가한다. Daily_Investment_Info의
  `CLAUDE.md` §3을 참고 양식으로 삼을 것.
- `README.md` / `README.html` — 설치·실행 경로 안내 갱신, Changelog에 이관 이력 추가
- `git push`는 사전 확인 후 실행

### 6-3. 이력 메모

`CLAUDE.md` 하단 이력에 추가:

```markdown
- 2026-08-17: `Documents/Claude/`에서 Claude Code 표준 경로
  `Documents/Claude/Projects/`로 이관. LaunchAgents plist 3개(각 2곳),
  레포 내 wiki-ingest plist 사본, `check_duplicates.py`, `wiki_mcp.js` 주석,
  `.claude/settings.local.json`, MCP `wiki-search` 등록 경로 동기화 완료.
```

## 7. 범위 밖 (이번엔 하지 않음)

- 레포 내 plist 3개의 placeholder 스타일 통일
- `scheduler.log` 19.6MB 로테이션 도입 (별도 검토 대상)
- `Documents/Claude/`에 남은 나머지 프로젝트(`QuakeOS`, `asset_manage`, `Tools`,
  `AI_eBook_Publish` 등) 이관
- 코드 로직 일체
