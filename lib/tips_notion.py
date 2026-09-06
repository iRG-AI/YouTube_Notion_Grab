#!/usr/bin/env python3
"""
Notion「AI 꿀팁」DB 전용 조회/생성 래퍼

속성 타입 (2026-09-06 §2-2 검증 출력 — 추측 금지, 바뀌면 이 표부터 갱신):
    제목     title
    URL      url
    출처     url        ← 호스트만 저장 (예: github.com). 기존 행과 형식 통일
    태그     rich_text  ← 쉼표 결합 문자열
    카테고리 select     프롬프트|개발툴|기타|모델/LLM|뉴스/트렌드|지식관리|사업/마케팅
    상태     select     미확인
    중요도   select     상|중|하
    저장일   date
    메모     rich_text

보안 원칙 (CLAUDE.md 1순위):
    401/403 → NotionAuthError 발생, 호출자는 즉시 종료해야 한다. 재시도 금지.
    429/5xx → 지수 백오프(2·4·8·16초), 최대 4회 후 실패.
    생성 루프는 호출 간 350ms 대기 (3 req/s 준수).

실행 인터프리터: /usr/bin/python3 (시스템 파이썬). python.org 3.11은 루트 인증서가 없어 SSL 오류가 난다.
"""
import json, os, re, ssl, sys, time
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTION_VERSION = '2022-06-28'
RATE_SLEEP = 0.35


class NotionAuthError(RuntimeError):
    """401/403 — 즉시 종료 신호"""


def load_env():
    env = {}
    p = os.path.join(SCRIPT_DIR, '.env')
    if not os.path.exists(p):
        return env
    for line in open(p).read().split('\n'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
NOTION_TOKEN = ENV.get('NOTION_TOKEN', '')
TIPS_DB_ID = ENV.get('NOTION_TIPS_DB_ID', '')


def notion_call(method, path, body=None, max_attempts=4):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    ctx = ssl.create_default_context()
    for attempt in range(max_attempts):
        req = Request(f'https://api.notion.com{path}', data=data, method=method, headers={
            'Authorization': f'Bearer {NOTION_TOKEN}',
            'Content-Type': 'application/json',
            'Notion-Version': NOTION_VERSION,
        })
        try:
            with urlopen(req, context=ctx, timeout=30) as res:
                return json.loads(res.read())
        except HTTPError as e:
            payload = e.read().decode('utf-8', 'ignore')
            if e.code in (401, 403):
                raise NotionAuthError(f'HTTP {e.code} — 인증/권한 오류, 연쇄 요청 중단: {payload[:200]}')
            if e.code in (429,) or e.code >= 500:
                if attempt == max_attempts - 1:
                    raise RuntimeError(f'HTTP {e.code} 재시도 초과: {payload[:200]}')
                wait = 2 ** (attempt + 1)
                print(f'  ⏸ HTTP {e.code} — {wait}s 대기 후 재시도', flush=True)
                time.sleep(wait)
                continue
            raise RuntimeError(f'HTTP {e.code}: {payload[:300]}')
        except URLError as e:
            if 'CERTIFICATE_VERIFY_FAILED' in str(e):
                raise RuntimeError('SSL 인증서 오류 — /usr/bin/python3 로 실행하세요') from e
            if attempt == max_attempts - 1:
                raise
            time.sleep(2 ** (attempt + 1))


# ── 조회 ──
def load_all_tips(db_id=None):
    db_id = db_id or TIPS_DB_ID
    if not db_id:
        raise RuntimeError('NOTION_TIPS_DB_ID 가 .env 에 없습니다')
    pages, cursor = [], None
    while True:
        body = {'page_size': 100}
        if cursor:
            body['start_cursor'] = cursor
        res = notion_call('POST', f'/v1/databases/{db_id}/query', body)
        pages.extend(res.get('results', []))
        cursor = res.get('next_cursor')
        if not cursor:
            break
    return pages


def _plain(rt):
    return ''.join(t.get('plain_text', '') for t in (rt or []))


def page_to_row(p):
    pr = p.get('properties', {})
    return {
        'id': p['id'],
        'title': _plain(pr.get('제목', {}).get('title')),
        'url': pr.get('URL', {}).get('url') or '',
        'source': pr.get('출처', {}).get('url') or '',
        'tags': [t.strip() for t in _plain(pr.get('태그', {}).get('rich_text')).split(',') if t.strip()],
        'category': (pr.get('카테고리', {}).get('select') or {}).get('name', ''),
        'status': (pr.get('상태', {}).get('select') or {}).get('name', ''),
        'importance': (pr.get('중요도', {}).get('select') or {}).get('name', ''),
        'saved_date': (pr.get('저장일', {}).get('date') or {}).get('start', ''),
        'memo': _plain(pr.get('메모', {}).get('rich_text')),
        'created_time': p.get('created_time', ''),
        'last_edited_time': p.get('last_edited_time', ''),
    }


# ── 생성 ──
def build_properties(row):
    """row: {title,url,source,tags[],category,status,importance,saved_date,memo}"""
    def rt(s):
        s = (s or '')[:2000]
        return [{'type': 'text', 'text': {'content': s}}] if s else []
    props = {
        '제목': {'title': [{'type': 'text', 'text': {'content': (row['title'] or row['url'])[:200]}}]},
        'URL': {'url': row['url']},
        '출처': {'url': row.get('source') or None},
        '태그': {'rich_text': rt(','.join(row.get('tags') or []))},
        '카테고리': {'select': {'name': row.get('category') or '기타'}},
        '상태': {'select': {'name': row.get('status') or '미확인'}},
        '중요도': {'select': {'name': row.get('importance') or '중'}},
        '메모': {'rich_text': rt(row.get('memo'))},
    }
    if row.get('saved_date'):
        props['저장일'] = {'date': {'start': row['saved_date'][:10]}}
    return props


def create_tip(row, db_id=None):
    db_id = db_id or TIPS_DB_ID
    res = notion_call('POST', '/v1/pages', {
        'parent': {'database_id': db_id},
        'properties': build_properties(row),
    })
    time.sleep(RATE_SLEEP)
    return res


def get_blocks(page_id):
    """페이지 본문 블록 (사용자가 나중에 메모를 붙였을 수 있음)."""
    blocks, cursor = [], None
    while True:
        path = f'/v1/blocks/{page_id}/children?page_size=100' + (f'&start_cursor={cursor}' if cursor else '')
        res = notion_call('GET', path)
        blocks.extend(res.get('results', []))
        cursor = res.get('next_cursor')
        if not cursor:
            break
    return blocks


if __name__ == '__main__':
    pages = load_all_tips()
    rows = [page_to_row(p) for p in pages]
    print(f'✅ 「AI 꿀팁」{len(rows)}건 로드')
    from collections import Counter
    print('카테고리:', dict(Counter(r['category'] for r in rows)))
    print('상태:', dict(Counter(r['status'] for r in rows)))
    print('URL 비어있음:', sum(1 for r in rows if not r['url']))
    for r in rows[:3]:
        print(' ', r['saved_date'], '|', r['category'], '|', r['title'][:40], '|', r['url'][:60])
