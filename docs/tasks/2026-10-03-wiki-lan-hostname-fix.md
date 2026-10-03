# 작업지시서 — `wiki_lan_server.js` 기동 로그 주소 교정 + 뒷정리 (v3.2 보완)

작성일: 2026-10-03 · 대상: Claude Code · 영역: **Node (`wiki_lan_server.js` 3곳)** + `.gitignore` + 문서
지시 번호: `[CC-1003-B]` · 선행: `docs/tasks/2026-10-03-wiki-lan-server.md` (`[CC-1003-A]`, 커밋 `3618c05` — Cowork 재검증 통과)

> 이 파일을 읽고 그대로 실행한다. 범위 밖 항목은 손대지 않는다.
> 이 문서에는 맥 이름·집 대역·개인 절대경로를 적지 않는다(레포 공개).

---

## 1. 배경

`[CC-1003-A]` 재검증에서 나온 것들이다. 서버 동작·차단·한도는 전부 정상이고, 아래는 표시·정리 문제다.

| 항목 | 실측 (2026-10-03) | 원인 |
|---|---|---|
| 기동 로그의 `가족 접속:` 주소가 틀림 | 로그에 찍힌 이름은 `.local`로 풀리지 않았다(`curl` 000). `scutil --get LocalHostName` 값으로는 200 | **지시서 A의 설계 오류.** `os.hostname()`이 Bonjour 이름과 같다고 가정했고, 사전 검증이 리눅스 스텁 환경이라 걸러지지 않았다 |
| 미추적 폴더 `Claude outputs/` | 안에 지시서 A의 사본 1개 | Cowork 세션이 산출물 사본을 연결 폴더에 두는 자리다. "무관한 기존 폴더"가 아니라 이번 세션이 만든 것 |
| `AGENTS.md:307` | "`wiki-ingest`만 `/usr/bin/python3`" | 2026-09-10에 `/opt/homebrew/bin/python3`로 바뀐 뒤 갱신 누락 (A 보고에서 CC가 발견) |
| `CLAUDE.md` Vault 메모 | "절차: 데몬 3종 stop" | 데몬이 하나 늘었다. `wiki-lan`도 같은 Vault 경로를 읽는다 |

틀린 주소가 로그에 남아 있으면 "가족이 접속이 안 된다"를 진단할 때 로그를 믿고 엉뚱한 주소를 안내하게 된다. 그래서 고친다.

## 2. 사전 확인 (어긋나면 중단하고 보고)

```bash
git log --oneline -1
# 기대: 3618c05 feat(wiki): 집 안 전용 읽기 전용 검색 서버 wiki_lan_server.js (v3.2)

git status --short
# 기대: ?? "Claude outputs/"  와  ?? docs/tasks/2026-10-03-wiki-lan-hostname-fix.md  두 줄뿐

launchctl list | grep irichgreen.wiki-lan
# 기대: <PID>  0  com.irichgreen.wiki-lan

wc -l < wiki_lan_server.js
# 기대: 262
```

## 3. AS-IS → TO-BE

### 3-1. `wiki_lan_server.js` — 3곳

**(a) `require` 1줄 추가**

AS-IS
```js
const net = require('net');
```

TO-BE
```js
const net = require('net');
const { execFileSync } = require('child_process');
```

**(b) `clientIp` 정의 바로 위에 함수 추가**

AS-IS
```js
function clientIp(req) {
```

TO-BE
```js
// 가족이 쓰는 Bonjour(.local) 이름은 LocalHostName 이다. os.hostname() 은 다른 값일 수 있다
// (2026-10-03 실측: os.hostname() 이 준 이름은 .local 로 풀리지 않았다). 기동 로그 표시용.
function bonjourName() {
  try {
    const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (name) return name;
  } catch (e) { /* scutil 실패 → 아래 대체값 */ }
  return os.hostname().replace(/\.local$/i, '');
}

function clientIp(req) {
```

**(c) 기동 로그 1줄 교체**

AS-IS
```js
    console.log(`  가족 접속: http://${os.hostname().replace(/\.local$/i, '')}.local:${PORT}/wiki`);
```

TO-BE
```js
    console.log(`  가족 접속: http://${bonjourName()}.local:${PORT}/wiki`);
```

`/usr/sbin/scutil`은 절대경로로 부른다(launchd의 `PATH`에 기대지 않는다). 기동 때 한 번만 호출되고, 허용 대역이 없을 때(루프백 전용)는 호출되지 않는다. 실패·3초 초과 시 예전 값으로 떨어질 뿐 서버 기동은 막지 않는다.

```bash
node --check wiki_lan_server.js && echo "SYNTAX OK"
# 기대: SYNTAX OK
wc -l < wiki_lan_server.js
# 기대: 273
git diff --stat wiki_lan_server.js
# 기대: 1 file changed, 12 insertions(+), 1 deletion(-)
```

### 3-2. `.gitignore` — 파일 끝에 추가

```
# Cowork 세션 산출물 사본 (앱이 연결 폴더에 만든다 — 개인 환경별 상이, 2026-10-03)
Claude outputs/
```

```bash
git check-ignore -q "Claude outputs/x.md" && echo "ignored OK"
# 기대: ignored OK
git status --short | grep -c "Claude outputs"
# 기대: 0
```

폴더 자체는 지우지 않는다(대표님 판단).

### 3-3. `AGENTS.md:307`

AS-IS
```
- `wiki-ingest`만 **`/usr/bin/python3`(시스템 파이썬)**, Node는 `/opt/homebrew/bin/node`.
```

TO-BE
```
- 인터프리터는 위 표가 원본이다. Node 데몬은 `/opt/homebrew/bin/node`, `wiki-ingest`는 `/opt/homebrew/bin/python3`(2026-09-10부터. 예전의 `/usr/bin/python3`가 아니다).
```

### 3-4. `CLAUDE.md` — 3곳

**(a) Vault 경로 중첩 메모**

AS-IS `절차: 데몬 3종 stop → `
TO-BE `절차: 데몬 전부 stop(`wiki-lan` 포함 — 같은 Vault 경로를 읽는다) → `

**(b) "Wiki 검색" 절의 `<맥이름>` 항목 뒷부분**

AS-IS
```
**기동 로그의 `가족 접속:` 줄은 `os.hostname()`을 쓰므로 `LocalHostName`과 다를 수 있다(2026-10-03 실측: 로그에 찍힌 이름과 `LocalHostName`이 서로 달랐다). 안내할 주소는 로그가 아니라 `scutil`로 확인한다.**
```

TO-BE
```
기동 로그의 `가족 접속:` 줄도 같은 값(`scutil --get LocalHostName`)을 찍는다. `os.hostname()`은 쓰지 않는다 — 2026-10-03 실측에서 `.local`로 풀리지 않는 이름을 줬다.
```

**(c) 변경 이력 `2026-10-03 (v3.2)` 항목 끝에 한 문장 추가**

```
같은 날 보완: 기동 로그의 접속 주소를 `os.hostname()` → `scutil --get LocalHostName` 기준으로 교정(전자는 `.local`로 풀리지 않는 이름을 줬다), `.gitignore`에 `Claude outputs/` 추가, `AGENTS.md`의 낡은 인터프리터 문구 정정. 지시서 `docs/tasks/2026-10-03-wiki-lan-hostname-fix.md`.
```

### 3-5. `README.md` — `[v3.2]` 상세 절의 "안전장치" 목록 끝(plist 항목 다음)에 1줄

```
- 기동 로그의 `가족 접속:` 주소는 `scutil --get LocalHostName` 기준 — `os.hostname()`은 `.local`로 풀리지 않는 이름을 줄 수 있다
```

**버전은 올리지 않는다.** v3.2가 아직 push 전이고 같은 날 보완이다. 머리의 `현재 버전`과 요약 표는 그대로 둔다.

## 4. 데몬 재기동

상주 프로세스라 재기동 전에는 코드가 반영되지 않는다. plist는 바뀌지 않았으므로 복사하지 않는다.

```bash
launchctl unload ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
launchctl load ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
sleep 2
launchctl list | grep irichgreen.wiki-lan
# 기대: <새 PID>  0  com.irichgreen.wiki-lan
```

## 5. 검증 (다르면 §6 롤백 후 보고)

```bash
NAME=$(scutil --get LocalHostName)

tail -8 ~/Library/Logs/irichgreen/wiki-lan.log | grep "가족 접속"
tail -8 ~/Library/Logs/irichgreen/wiki-lan.log | grep -c "http://$NAME.local:3100/wiki"
# 기대: 가족 접속 줄 1개, 그 줄의 이름이 $NAME 과 같다 → 1

curl -s -m 6 -o /dev/null -w "%{http_code}\n" http://$NAME.local:3100/wiki     # 기대: 200 (맥이 집 대역에 있을 때. 밖이면 403 = 생략 보고)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/wiki            # 기대: 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3100/api/master-ingest   # 기대: 404
lsof -nP -iTCP:3100 -sTCP:LISTEN | tail -1    # 기대: ... TCP *:3100 (LISTEN)
lsof -nP -iTCP:3000 -sTCP:LISTEN | tail -1    # 기대: ... TCP 127.0.0.1:3000 (LISTEN)
```

`/api/wiki-ask`는 호출하지 않는다(이번 변경과 무관, Gemini 무료 한도).

## 6. 롤백

```bash
git checkout -- wiki_lan_server.js .gitignore AGENTS.md CLAUDE.md README.md     # 커밋 전
# 커밋 후라면: git revert <이 작업 커밋>
launchctl unload ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
launchctl load ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
```

## 7. 커밋 (push 는 하지 않는다)

```bash
git add wiki_lan_server.js .gitignore AGENTS.md CLAUDE.md README.md docs/tasks/2026-10-03-wiki-lan-hostname-fix.md
git status --short
# 기대: 위 6개만 스테이징, 그 외 줄 없음
git commit -m "fix(wiki): 집 안 전용 서버 기동 로그의 접속 주소를 LocalHostName 기준으로 교정 + Claude outputs/ ignore"
```

보고(한국어): §2 출력, §3 각 확인 출력, §5 검증 출력(로그의 `가족 접속` 줄은 이름을 `<맥이름>`으로 가리지 말고 그대로), 커밋 해시와 `git show --stat HEAD`, 기대와 달랐던 것.

## 8. Cowork 사전 검증 (2026-10-03, 리눅스 스텁 환경 — `scutil`을 흉내 낸 스크립트로 대체)

§3-1의 3곳을 A의 코드에 기계 적용한 결과(273줄)를 실행했다.

| `scutil` 상태 | 로그의 이름 | `/wiki` |
|---|---|---|
| 이름을 돌려줌 | 그 이름 | 200 |
| 없음 | `os.hostname()` 대체값 | 200 |
| `exit 1` | 대체값 | 200 |
| 응답 없음(10초) | 3초 뒤 대체값 | 200 |

실제 맥의 `scutil` 출력으로 로그가 맞게 찍히는지는 §5가 확인한다. A에서 이 부분을 빠뜨린 자리다.

## 9. 범위 밖

- `server.js`, `lib/wiki_search.js`, `wiki_mcp.js`, `scheduler.js`, plist 수정
- 버전 번호 변경, `Claude outputs/` 폴더 삭제
- macOS 방화벽 설정, 가족 PC 실접속 확인, `git push`
