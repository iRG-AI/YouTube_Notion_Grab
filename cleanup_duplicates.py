#!/usr/bin/env python3
# ===== 노션 중복 정리 + Obsidian 중복 정리 스크립트 =====
# URL 기준으로 중복 페이지를 찾아:
#   1. 주제 태그를 대표 페이지에 병합
#   2. 중복 페이지를 노션에서 아카이브(삭제)
#   3. Obsidian에서도 중복 .md 파일 삭제
# 실행: python3 cleanup_duplicates.py [--dry-run]

import os, re, json, ssl, sys
from urllib.request import urlopen, Request
from collections import defaultdict

DRY_RUN = '--dry-run' in sys.argv
VAULT = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def load_env():
    env = {}
    for line in open(os.path.join(SCRIPT_DIR, '.env')).read().split('\n'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        env[k.strip()] = v.strip()
    return env

ENV = load_env()
NOTION_TOKEN = ENV.get('NOTION_TOKEN', '')
NOTION_DB_ID = ENV.get('NOTION_DB_ID', '')
ctx = ssl.create_default_context()

def notion_call(method, path, body=None):
    data = json.dumps(body).encode('utf-8') if body else None
    req = Request(f'https://api.notion.com{path}', data=data, method=method,
        headers={'Authorization': f'Bearer {NOTION_TOKEN}',
                 'Content-Type': 'application/json',
                 'Notion-Version': '2022-06-28'})
    with urlopen(req, context=ctx, timeout=30) as res:
        return json.loads(res.read())

def log(msg): print(msg, flush=True)

# ── 노션 DB 전체 로드 ──
def load_all_pages():
    pages, cursor = [], None
    log('📦 노션 DB 로딩 중...')
    while True:
        body = {'page_size': 100}
        if cursor: body['start_cursor'] = cursor
        res = notion_call('POST', f'/v1/databases/{NOTION_DB_ID}/query', body)
        pages.extend(res.get('results', []))
        cursor = res.get('next_cursor')
        if not cursor: break
        print(f'  {len(pages)}개 로드 중...', end='\r')
    log(f'\n✅ 총 {len(pages)}개 로드 완료\n')
    return pages

# ── URL에서 videoId 추출 ──
def extract_video_id(url):
    if not url: return ''
    m = re.search(r'[?&]v=([a-zA-Z0-9_-]{11})', url)
    return m.group(1) if m else ''

# ── 노션 중복 분석 ──
def analyze_duplicates(pages):
    # videoId → [page_info, ...] 그룹화
    vid_map = defaultdict(list)
    no_url_pages = []

    for page in pages:
        props = page.get('properties', {})
        title = ''.join(t.get('text', {}).get('content', '') for t in props.get('영상 제목', {}).get('title', []))
        video_url = props.get('영상 URL', {}).get('url', '') or ''
        topics = [t.get('name', '') for t in props.get('주제', {}).get('multi_select', [])]
        upload_date = props.get('업로드 일자', {}).get('date', {}).get('start', '') or ''
        channel = ''.join(t.get('text', {}).get('content', '') for t in props.get('유튜브 채널', {}).get('rich_text', []))
        video_id = extract_video_id(video_url)

        info = {
            'id': page['id'],
            'title': title,
            'url': video_url,
            'video_id': video_id,
            'topics': topics,
            'date': upload_date,
            'channel': channel,
        }

        if video_id:
            vid_map[video_id].append(info)
        else:
            no_url_pages.append(info)

    # 중복만 필터
    duplicates = {vid: items for vid, items in vid_map.items() if len(items) > 1}
    return duplicates, no_url_pages

# ── 노션 주제 태그 병합 ──
def merge_topics(page_id, all_topics):
    unique_topics = list(dict.fromkeys(all_topics))  # 순서 유지하며 중복 제거
    notion_call('PATCH', f'/v1/pages/{page_id}', {
        'properties': {
            '주제': {'multi_select': [{'name': t} for t in unique_topics]}
        }
    })

# ── 노션 페이지 아카이브(삭제) ──
def archive_page(page_id):
    notion_call('PATCH', f'/v1/pages/{page_id}', {'in_trash': True})

# ── Obsidian에서 notion_id로 파일 찾기 ──
def find_obsidian_file(notion_id):
    clean_id = notion_id.replace('-', '')
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if not f.endswith('.md'): continue
            fpath = os.path.join(root, f)
            content = open(fpath, encoding='utf-8', errors='ignore').read()
            # notion_id는 하이픈 있는 형태와 없는 형태 모두 체크
            if notion_id in content or clean_id in content:
                return fpath
    return None

# ── 메인 정리 실행 ──
def cleanup():
    pages = load_all_pages()
    duplicates, no_url = analyze_duplicates(pages)

    log(f'🔍 URL 기준 중복 그룹: {len(duplicates)}개')
    log(f'⚠️  URL 없는 페이지: {len(no_url)}개\n')

    total_archived = 0
    total_obsidian_deleted = 0

    for video_id, items in duplicates.items():
        # 대표 페이지: topics 가장 많은 것 → 없으면 첫 번째
        items_sorted = sorted(items, key=lambda x: len(x['topics']), reverse=True)
        keeper = items_sorted[0]
        dupes = items_sorted[1:]

        # 모든 주제 태그 수집 및 병합
        all_topics = []
        for item in items:
            for t in item['topics']:
                if t not in all_topics:
                    all_topics.append(t)

        log(f'📹 {keeper["title"][:50]}')
        log(f'   URL: https://youtube.com/watch?v={video_id}')
        log(f'   대표: {keeper["id"][:8]}... | 병합 주제: {all_topics}')

        if not DRY_RUN:
            # 1. 대표 페이지에 모든 주제 병합
            merge_topics(keeper['id'], all_topics)

        for dup in dupes:
            log(f'   🗑  삭제: {dup["id"][:8]}... (주제: {dup["topics"]})')
            if not DRY_RUN:
                try:
                    # 2. 중복 페이지 아카이브
                    archive_page(dup['id'])
                    total_archived += 1
                except Exception as e:
                    log(f'   ⚠️  노션 삭제 실패 (이미 삭제됐을 수 있음): {e}')

                # 3. Obsidian에서도 중복 .md 삭제
                obs_file = find_obsidian_file(dup['id'])
                if obs_file:
                    os.remove(obs_file)
                    log(f'   🗑  Obsidian 삭제: {os.path.basename(obs_file)}')
                    total_obsidian_deleted += 1
        log('')

    if DRY_RUN:
        log(f'\n[DRY-RUN] 실제 삭제는 하지 않았습니다.')
        log(f'삭제 예정: 노션 {sum(len(v)-1 for v in duplicates.values())}개, Obsidian은 notion_id 매칭 후 삭제')
    else:
        log(f'\n✅ 정리 완료!')
        log(f'   노션 아카이브: {total_archived}개')
        log(f'   Obsidian 삭제: {total_obsidian_deleted}개')

if __name__ == '__main__':
    if DRY_RUN:
        log('🔍 [DRY-RUN 모드] 실제 삭제 없이 분석만 합니다.\n')
    else:
        log('🧹 중복 정리 시작 (실제 삭제 모드)\n')
    cleanup()
