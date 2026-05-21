#!/usr/bin/env python3
"""Wiki 엔티티/개념 정의 + Gemini API 유틸리티"""

import os, json, ssl, time, unicodedata, sys, urllib.error
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
GEMINI_API_KEY = ENV.get('GEMINI_API_KEY', '')

# ── Gemini API 호출 (무료 티어, Rate Limit 준수) ──
_last_call_time = 0
_QUOTA_FILE = os.path.join(SCRIPT_DIR, '.wiki_quota.json')
_RPD_LIMIT = 230  # 250 RPD 중 20개 여유분 (다른 기능용)

class DailyQuotaExhausted(Exception):
    """일일 무료 티어 한도(250 RPD) 도달"""
    pass

def _load_quota():
    """오늘 사용한 API 호출 수 로드"""
    today = time.strftime('%Y-%m-%d')
    if os.path.exists(_QUOTA_FILE):
        q = json.loads(open(_QUOTA_FILE).read())
        if q.get('date') == today:
            return q
    return {'date': today, 'count': 0}

def _save_quota(q):
    open(_QUOTA_FILE, 'w').write(json.dumps(q))

def gemini_call(prompt, temperature=0.2, max_tokens=4000):
    """Gemini 2.5 Flash 호출. 무료 티어 Rate Limit (10 RPM, 250 RPD) 준수."""
    global _last_call_time

    # 일일 한도 체크
    quota = _load_quota()
    if quota['count'] >= _RPD_LIMIT:
        raise DailyQuotaExhausted(
            f"일일 한도 {_RPD_LIMIT}회 도달 (오늘 {quota['count']}회 사용). "
            f"내일 다시 실행하거나 유료 전환하세요."
        )

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
        f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}',
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

    # 호출 수 기록
    quota['count'] += 1
    _save_quota(quota)

    text = result.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
    return text

def load_state():
    if os.path.exists(STATE_FILE):
        return json.loads(open(STATE_FILE, encoding='utf-8').read())
    return {'ingested': {}, 'entities': {}, 'concepts': {}}

def save_state(state):
    open(STATE_FILE, 'w', encoding='utf-8').write(json.dumps(state, ensure_ascii=False, indent=2))
