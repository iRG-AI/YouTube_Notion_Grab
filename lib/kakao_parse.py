#!/usr/bin/env python3
"""
카카오톡 '나와의 채팅' CSV → 링크 후보 추출·정규화 (순수 함수, 네트워크 없음)

CSV 형식 (카카오톡 PC 내보내기, UTF-8 BOM):
    Date,User,Message
    2026-03-08 09:12:33,"안진훈","https://github.com/... 메모"

공개 API:
    read_kakao_csv(path)            -> [{'date','user','message'}]
    extract_urls(text)              -> [url]
    clean_url(url)                  -> 트래킹 파라미터 제거한 저장용 URL
    url_key(url)                    -> 중복 판정용 정규화 키
    parse_links(path, since=None)   -> [{'date','url','key','message'}]  (CSV 내부 중복 제거)
    guess_meta(url, message)        -> {'title','category','tags','memo','source'}

지침서: docs/tasks/2026-09-06-kakao-tips-ingest.md §3
"""
import csv, os, re, unicodedata
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, unquote

# 제거 대상 쿼리 파라미터 (지침서 §3, 검증 완료 — 그대로 이식)
STRIP_PARAMS = {
    'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'pvs', 'si', 'mcp_token', '_phid', '_phsrc', 'source', 'shareKey', 'navType',
    'pli', 'usp', 'gclid', 'igshid',
}

# 카테고리 select 옵션 (§2-2 검증 출력 기준 — Notion에 없는 값을 넣으면 400)
CATEGORIES = ['프롬프트', '개발툴', '기타', '모델/LLM', '뉴스/트렌드', '지식관리', '사업/마케팅']

_URL_RE = re.compile(r'https?://[^\s"<>\)\]\'`]+')
_TRAIL = '.,;:!?)]}\'"'


def nfc(s):
    return unicodedata.normalize('NFC', s or '')


def read_kakao_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        out.append({
            'date': (r.get('Date') or '').strip(),
            'user': nfc((r.get('User') or '').strip()),
            'message': nfc(r.get('Message') or ''),
        })
    return out


def extract_urls(text):
    return [u.rstrip(_TRAIL) for u in _URL_RE.findall(text or '')]


def clean_url(url):
    """저장용: 스킴/호스트는 유지, 트래킹 파라미터만 제거."""
    url = url.strip().rstrip(_TRAIL)
    s = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(s.query, keep_blank_values=True) if k not in STRIP_PARAMS]
    return urlunsplit((s.scheme, s.netloc, s.path, urlencode(q), ''))


def url_key(url):
    """중복 판정용: https 통일, 소문자 호스트, www. 제거, 끝 슬래시 제거, 파라미터 정리, fragment 제거."""
    s = urlsplit(clean_url(url))
    host = s.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]
    path = s.path.rstrip('/') or ''
    q = sorted(parse_qsl(s.query, keep_blank_values=True))
    return urlunsplit(('https', host, path, urlencode(q), ''))


def host_of(url):
    h = urlsplit(url).netloc.lower()
    return h[4:] if h.startswith('www.') else h


def parse_links(path, since=None):
    """CSV → 링크 목록. since('YYYY-MM-DD') 이전 메시지는 제외. CSV 내부 중복은 첫 등장만 유지."""
    seen, out = set(), []
    for m in read_kakao_csv(path):
        if since and m['date'][:10] < since:
            continue
        for u in extract_urls(m['message']):
            k = url_key(u)
            if k in seen:
                continue
            seen.add(k)
            out.append({'date': m['date'], 'url': clean_url(u), 'key': k, 'message': m['message']})
    return out


# ── 제목/카테고리/태그 추정 (규칙 기반, 1차) ──
_KEYWORD_TAGS = [
    (r'claude[-_ ]?code', 'ClaudeCode'), (r'claude', 'Claude'), (r'antigravity', 'Antigravity'),
    (r'gemini', 'Gemini'), (r'gpt|openai|chatgpt', 'GPT'), (r'ollama', 'Ollama'),
    (r'notion', 'Notion'), (r'obsidian', 'Obsidian'), (r'prompt|프롬프트', '프롬프트'),
    (r'mcp', 'MCP'), (r'agent|에이전트', 'Agent'), (r'cursor', 'Cursor'), (r'github\.com', 'GitHub'),
    (r'youtube\.com|youtu\.be', 'YouTube'), (r'huggingface', 'HuggingFace'),
]


def _slug_title(url):
    """URL 마지막 경로 조각에서 제목 추정. notion.site 슬러그는 끝 32자리 hex 제거."""
    s = urlsplit(url)
    seg = [unquote(p) for p in s.path.split('/') if p]
    if not seg:
        return ''
    last = seg[-1]
    last = re.sub(r'-?[0-9a-f]{32}$', '', last)          # notion id
    last = re.sub(r'\.(html?|md|pdf)$', '', last, flags=re.I)
    return last.replace('-', ' ').replace('_', ' ').strip()


def guess_meta(url, message=''):
    host = host_of(url)
    text = f'{url} {message}'.lower()
    tags = []
    for pat, tag in _KEYWORD_TAGS:
        if re.search(pat, text) and tag not in tags:
            tags.append(tag)

    memo = ''
    if 'github.com' in host:
        parts = [p for p in urlsplit(url).path.split('/') if p]
        repo = parts[1] if len(parts) >= 2 else (parts[0] if parts else host)
        title = f'{repo} (GitHub 레포)'
        category = '개발툴'
    elif host.endswith('notion.site') or host in ('notion.so', 'app.notion.com'):
        slug = _slug_title(url)
        if slug and re.search(r'[가-힣]', slug):
            title = slug
        else:
            title = f'노션 자료 ({slug[:40]})' if slug else '노션 자료 (제목 미확인)'
            memo = '슬러그에 한글 제목 없음 — 원문 확인 필요'
        category = '기타'
    elif 'youtube.com' in host or 'youtu.be' in host:
        title = '유튜브 영상 (제목 미확인)'
        category = '기타'
        memo = '원문 확인 필요'
    else:
        slug = _slug_title(url)
        title = slug[:80] if slug else host
        category = '기타'
        if not slug:
            memo = '원문 확인 필요'

    # 카테고리 세부 보정
    if any(t in tags for t in ('프롬프트',)):
        category = '프롬프트'
    elif any(t in tags for t in ('ClaudeCode', 'Antigravity', 'Cursor', 'MCP', 'Ollama')) and category == '기타':
        category = '개발툴'
    elif any(t in tags for t in ('Notion', 'Obsidian')) and category == '기타':
        category = '지식관리'
    elif any(t in tags for t in ('GPT', 'Gemini', 'Claude')) and category == '기타':
        category = '모델/LLM'

    # 메시지에 URL 외 텍스트가 있으면 제목 후보로 우선 (사용자가 직접 붙인 메모)
    extra = re.sub(r'https?://\S+', '', message or '').strip()
    extra = re.sub(r'\s+', ' ', extra)
    if 4 <= len(extra) <= 80:
        title = extra
        memo = ''

    assert category in CATEGORIES
    return {'title': nfc(title), 'category': category, 'tags': tags, 'memo': memo, 'source': host}


if __name__ == '__main__':
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else None
    since = sys.argv[2] if len(sys.argv) > 2 else None
    if not p:
        print('usage: kakao_parse.py <csv> [since YYYY-MM-DD]'); sys.exit(1)
    links = parse_links(p, since)
    print(f'{len(links)} links')
    for l in links[:20]:
        g = guess_meta(l['url'], l['message'])
        print(f"{l['date'][:10]} | {g['category']:6} | {g['title'][:40]:40} | {l['url'][:60]}")
