#!/usr/bin/env python3
"""Wiki 엔티티/개념 정의 + Gemini API 유틸리티"""

import os, json, re, ssl, time, unicodedata, sys, urllib.error
from urllib.request import urlopen, Request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VAULT = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
WIKI_DIR = os.path.join(VAULT, '_wiki')
ENTITIES_DIR = os.path.join(WIKI_DIR, 'entities')
CONCEPTS_DIR = os.path.join(WIKI_DIR, 'concepts')
SYNTHESIS_DIR = os.path.join(WIKI_DIR, 'synthesis')
STATE_FILE = os.path.join(SCRIPT_DIR, '.wiki_state.json')

def nfc(s):
    return unicodedata.normalize('NFC', s) if s else s

# ── 레벨 2: AI 도구 + 기술 개념 ──
ENTITIES = [
    'Claude', 'Claude Code', 'Gemini', 'Gemma', 'ChatGPT', 'GPT',
    'Grok', 'Perplexity', 'Copilot',
    'Antigravity', 'Lovable', 'Replit', 'Cursor', 'Windsurf',
    'OpenCode', 'Codex', 'Cowork',
    'n8n', 'Make', 'Zapier',
    'Genspark', 'NotebookLM',
    'Google AI Studio', 'Obsidian',
    'Seedance', 'Kling', 'Sora', 'Veo',
    'Midjourney', 'Stable Diffusion',
    'Suno', 'Udio',
]

CONCEPTS = [
    '바이브코딩', 'RAG', 'MCP', 'Agent', 'AI 에이전트',
    '프롬프트 엔지니어링', 'Fine-tuning', 'LoRA',
    'LLM', '멀티모달', 'Function Calling', 'Tool Use',
    'Agentic Workflow', 'A2A', 'Context Window',
    'AI 자동화', 'AI 수익화', 'AI 생산성',
    'Embedding', 'Vector DB', 'Knowledge Graph',
    'Open Source AI', 'On-device AI', 'Edge AI',
]

# ── .env 로드 ──
def load_env():
    env = {}
    env_path = os.path.join(SCRIPT_DIR, '.env')
    if not os.path.exists(env_path): return env
    for line in open(env_path).read().split('\n'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        env[k.strip()] = v.strip()
    return env

ENV = load_env()

# ── Gemini API 키 (2026-09-09: 단일 키 → 4키 로테이션) ──
# scheduler.js 가 GEMINI_API_KEYS 를 로테이션하며 태우는데 여기는 GEMINI_API_KEY(단수)
# 하나만 봤고, 그 키가 하필 목록 #1 과 같아서 wiki-ingest 가 매일 굶었다.
# build_search_index.py 와 동일한 로드 규약을 쓴다.
_keys_str = ENV.get('GEMINI_API_KEYS', '')
KEYS = [k.strip() for k in _keys_str.split(',') if k.strip()] or [ENV.get('GEMINI_API_KEY', '')]
KEYS = [k for k in KEYS if k]
GEMINI_API_KEY = KEYS[0] if KEYS else ''      # 하위 호환 (외부 참조용)

# ── Gemini API 호출 (무료 티어, Rate Limit 준수) ──
_last_call_time = 0
_key_idx = 0
_QUOTA_FILE = os.path.join(SCRIPT_DIR, '.wiki_quota.json')

# ★ gemini-2.5-flash 무료 등급 실측 한도 = 20 RPD (키·프로젝트·모델당).
#   구글 429 응답의 quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier,
#   quotaValue="20" 근거. 이전 값 230 은 옛 250 RPD 가정이라 11배 과다였고,
#   그래서 자체 카운터가 여유롭다고 판단하는 동안 실제로는 429 를 맞았다.
_RPD_LIMIT = 20

_MAX_ATTEMPTS = 8   # 한 호출의 총 시도 상한 (키 교체 + 대기 재시도 합산)
_MAX_WAIT = 65      # RPM 대기 상한(초). 구글 retryDelay 최댓값이 ~57s 였다.
_MAX_TRANSIENT = 3  # 5xx/네트워크 오류 재시도 횟수

def _classify_429(body):
    """429 본문의 quotaId 로 RPD/RPM 을 구분한다.

    구글은 QuotaFailure.violations[].quotaId 에 어느 한도인지 명시한다:
      GenerateRequestsPerDayPerProjectPerModel-FreeTier    → 하루 한도 (오늘 이 키 끝)
      GenerateRequestsPerMinutePerProjectPerModel-FreeTier → 분당 한도 (잠깐 쉬면 풀림)
    RetryInfo.retryDelay 에 권장 대기시간이 함께 온다.
    근거가 없으면 'unknown' 을 돌려주고 호출측이 보수적으로(=RPD 취급) 처리한다.
    """
    try:
        d = json.loads(body)
    except ValueError:
        return 'unknown', 0
    kind, delay = 'unknown', 0
    for det in d.get('error', {}).get('details', []):
        t = det.get('@type', '')
        if t.endswith('QuotaFailure'):
            for v in det.get('violations', []):
                qid = v.get('quotaId', '')
                if 'PerDay' in qid:
                    kind = 'rpd'
                elif 'PerMinute' in qid:
                    kind = 'rpm'
        elif t.endswith('RetryInfo'):
            m = re.match(r'(\d+)', str(det.get('retryDelay', '')))
            if m:
                delay = int(m.group(1))
    return kind, delay

def _quota_msg(body):
    """429 본문에서 한 줄 요약(metric/limit)만 뽑는다 — 로그용."""
    try:
        msg = json.loads(body).get('error', {}).get('message', '')
    except ValueError:
        return body[:200]
    m = re.search(r'Quota exceeded for metric: (\S+), limit: (\d+)', msg)
    return f'{m.group(1)} limit={m.group(2)}' if m else msg[:200]

class DailyQuotaExhausted(Exception):
    """보유한 모든 키의 일일 무료 티어 한도 도달"""
    pass

def _today():
    """구글 무료 티어 RPD 는 태평양시 자정에 리셋된다 (KST 16~17시).
    KST 자정 기준으로 세면 카운터만 리셋되고 구글 쪽 한도는 그대로라
    KST 00시 실행이 매번 '깨끗한 장부'로 시작해 즉시 429 를 맞는다.
    (lib/youtube_oauth.js:todayKey() 와 같은 취지)"""
    return time.strftime('%Y-%m-%d', time.gmtime(time.time() - 8 * 3600))

def _load_quota():
    """오늘의 키별 사용/소진 상태.

    counts: 이 프로세스가 센 키별 호출 수 (하한 추정 — scheduler.js 가 같은 키를
            태워도 여기엔 안 잡힌다. 그래서 카운터만으로 판단하지 않는다)
    dead:   오늘 429 를 실제로 받은 키 인덱스 (확정 신호)
    """
    today = _today()
    if os.path.exists(_QUOTA_FILE):
        try:
            q = json.loads(open(_QUOTA_FILE).read())
            if q.get('date') == today:
                q.setdefault('counts', {})
                q.setdefault('dead', [])
                # 구 포맷(count 단일 정수) 이월
                if 'count' in q and not q['counts']:
                    q['counts'] = {'0': q['count']}
                return q
        except (ValueError, OSError):
            pass
    return {'date': today, 'counts': {}, 'dead': []}

def _save_quota(q):
    try:
        open(_QUOTA_FILE, 'w').write(json.dumps(q))
    except OSError:
        pass    # 쿼터 기록 실패가 본 작업을 죽이지 않는다

def _key_available(q, idx):
    """로컬 판단으로 아직 살아있는 키인가 — 429 를 받았거나 자체 카운터가 한도면 제외."""
    if idx in q['dead']:
        return False
    return q['counts'].get(str(idx), 0) < _RPD_LIMIT

def gemini_call(prompt, temperature=0.2, max_tokens=4000):
    """Gemini 2.5 Flash 호출. 429 를 만나면 다음 키로 교체해 재시도한다.

    ★ 429 는 두 종류다 (2026-09-10). 응답의 quotaId 로 구분한다:
        RPD(하루 한도) → 오늘 이 키는 끝. dead 처리하고 다음 키로.
        RPM(분당 한도) → 잠깐 쉬면 풀린다. retryDelay 만큼 기다렸다 같은 키로 재시도.
      예전에는 둘을 구분하지 않고 무조건 dead 처리해서, 분당 한도 한 번에
      키 하나를 하루치 통째로 버렸다.
    ★ 5xx/네트워크 오류는 일시 오류다 — 지수 백오프로 재시도한다
      (scheduler.js 요약/분류 경로와 대칭. 예전에는 그냥 올려서 영상이 떨어졌다).
    ★ 403/400/401 은 키를 바꿔도 안 풀리는 설정 문제이므로 종전대로 즉시 종료한다.
    """
    global _last_call_time, _key_idx

    if not KEYS:
        raise DailyQuotaExhausted('Gemini API 키가 설정되지 않았습니다 (.env GEMINI_API_KEYS)')

    quota = _load_quota()
    transient = 0   # 5xx/네트워크 연속 실패 횟수

    for _ in range(_MAX_ATTEMPTS):
        # 살아있는 키를 찾는다 — 전부 죽었으면 루프를 빠져나가 DailyQuotaExhausted
        if not any(_key_available(quota, i) for i in range(len(KEYS))):
            break
        if not _key_available(quota, _key_idx):
            _key_idx = (_key_idx + 1) % len(KEYS)
            continue

        # 10 RPM = 6초 간격 (여유 확보)
        elapsed = time.time() - _last_call_time
        if elapsed < 6.0:
            time.sleep(6.0 - elapsed)

        ctx = ssl.create_default_context()
        body = json.dumps({
            'contents': [{'parts': [{'text': prompt}]}],
            'generationConfig': {
                'temperature': temperature,
                'maxOutputTokens': max_tokens,
                'responseMimeType': 'application/json',
                'thinkingConfig': { 'thinkingBudget': 0 }
            },
        }).encode('utf-8')

        req = Request(
            f'https://generativelanguage.googleapis.com/v1beta/models/'
            f'gemini-2.5-flash:generateContent?key={KEYS[_key_idx]}',
            data=body, method='POST',
            headers={'Content-Type': 'application/json'},
        )
        _last_call_time = time.time()
        try:
            with urlopen(req, context=ctx, timeout=60) as res:
                result = json.loads(res.read())
        except urllib.error.HTTPError as e:
            status_code = e.code
            try:
                error_body = e.read().decode('utf-8')
            except Exception:
                error_body = str(e)

            if status_code == 429 or 'RESOURCE_EXHAUSTED' in error_body:
                kind, delay = _classify_429(error_body)
                print(f"  ⚠️  429[{kind}] Key #{_key_idx + 1}: {_quota_msg(error_body)}")

                if kind == 'rpm':
                    # 분당 한도 — 키는 멀쩡하다. 권장 대기 후 같은 키로 재시도.
                    wait = min((delay or 30) + 2, _MAX_WAIT)
                    print(f"  ⏸  분당 한도 — {wait}초 대기 후 같은 키로 재시도")
                    time.sleep(wait)
                    continue

                if kind == 'unknown':
                    # 근거 없이 분기하지 않는다 — 본문을 통째로 남기고 보수적으로 RPD 취급
                    print(f"  ❓ quotaId 없음 — 관측 본문 전체:\n{error_body}")

                if _key_idx not in quota['dead']:
                    quota['dead'].append(_key_idx)
                _save_quota(quota)
                print(f"  ⏳ Key #{_key_idx + 1} 일일 한도(RPD) 소진 → 다음 키로 교체")
                _key_idx = (_key_idx + 1) % len(KEYS)
                continue

            if status_code >= 500:
                # 일시적 서버 오류 — 지수 백오프 재시도 (같은 키 유지)
                transient += 1
                if transient > _MAX_TRANSIENT:
                    raise e
                wait = min(2 ** transient, 15)
                print(f"  ⚠️  HTTP {status_code} 일시 오류 — {wait}초 후 재시도 ({transient}/{_MAX_TRANSIENT})")
                time.sleep(wait)
                continue

            print(f"\n🚨 [Gemini API 에러] HTTP {status_code} 발생!")
            print(f"상세 내용: {error_body}")
            if status_code == 403:
                if 'suspended' in error_body.lower() or 'consumer_suspended' in error_body.lower():
                    print("⚠️  경고: 구글에 의해 해당 API Key 또는 프로젝트가 정지(Suspended)되었습니다.")
                    print("계정 보호 및 추가 연쇄 정지 방지를 위해 작업을 즉시 중단하고 프로세스를 종료합니다.")
                    sys.exit(1)
                else:
                    print("⚠️  권한 부족 오류입니다. 추가 에러 방지를 위해 작업을 중단합니다.")
                    sys.exit(1)
            elif status_code in (400, 401):
                print("잘못된 요청이거나 잘못된 API 키 설정입니다. 프로세스를 종료합니다.")
                sys.exit(1)
            raise e
        except urllib.error.URLError as e:
            # <urlopen error timed out> 류 — 5xx 와 같은 일시 오류로 취급
            transient += 1
            if transient > _MAX_TRANSIENT:
                raise e
            wait = min(2 ** transient, 15)
            print(f"  ⚠️  네트워크 오류({e}) — {wait}초 후 재시도 ({transient}/{_MAX_TRANSIENT})")
            time.sleep(wait)
            continue

        # 성공 — 호출 수 기록
        k = str(_key_idx)
        quota['counts'][k] = quota['counts'].get(k, 0) + 1
        transient = 0
        _save_quota(quota)

        return result.get('candidates', [{}])[0].get('content', {}) \
                     .get('parts', [{}])[0].get('text', '')

    raise DailyQuotaExhausted(
        f"보유한 {len(KEYS)}개 키가 모두 일일 한도({_RPD_LIMIT} RPD) 소진. "
        f"무료 등급 쿼터는 태평양시 자정(KST 16~17시)에 리셋됩니다."
    )

def load_state():
    if os.path.exists(STATE_FILE):
        return json.loads(open(STATE_FILE, encoding='utf-8').read())
    return {'ingested': {}, 'entities': {}, 'concepts': {}}

def save_state(state):
    open(STATE_FILE, 'w', encoding='utf-8').write(json.dumps(state, ensure_ascii=False, indent=2))
