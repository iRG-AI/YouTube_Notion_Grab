#!/usr/bin/env python3
# ===== Obsidian 증분 동기화 스크립트 =====
# 노션 저장 완료 후 자동 실행:
#   1. 노션 DB에서 신규 영상만 .md 추가
#   2. MOC + 키워드 링크 전체 재구성
# 실행: python3 sync_obsidian.py

import os, re, json, ssl, subprocess, sys
from urllib.request import urlopen, Request
from collections import defaultdict

VAULT    = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
MOC_DIR  = os.path.join(VAULT, '_MOC')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ── .env 로드 ──
def load_env():
    env_path = os.path.join(SCRIPT_DIR, '.env')
    env = {}
    if not os.path.exists(env_path):
        return env
    for line in open(env_path).read().split('\n'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        env[k.strip()] = v.strip()
    return env

ENV = load_env()
NOTION_TOKEN = ENV.get('NOTION_TOKEN', '')
NOTION_DB_ID = ENV.get('NOTION_DB_ID', '')

def log(msg): print(msg, flush=True)

# ── Notion API 호출 ──
def notion_call(method, path, body=None):
    ctx = ssl.create_default_context()
    data = json.dumps(body).encode('utf-8') if body else None
    req = Request(
        f'https://api.notion.com{path}',
        data=data, method=method,
        headers={
            'Authorization': f'Bearer {NOTION_TOKEN}',
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
        }
    )
    with urlopen(req, context=ctx, timeout=30) as res:
        return json.loads(res.read())

# ── 파일명 안전 변환 ──
def safe_filename(s):
    return re.sub(r'[\/\\:*?"<>|#]', '_', s or 'untitled').strip()[:120]

# ── 기존 Vault 파일 notion_id 목록 수집 ──
def get_existing_notion_ids():
    ids = set()
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '_MOC']
        for f in files:
            if not f.endswith('.md'): continue
            content = open(os.path.join(root, f), encoding='utf-8', errors='ignore').read()
            m = re.search(r'^notion_id:\s*(.+)$', content, re.MULTILINE)
            if m:
                ids.add(m.group(1).strip())
    return ids

# ── Notion 블록(본문) 가져오기 ──
def get_blocks(page_id):
    blocks, cursor = [], None
    while True:
        path = f'/v1/blocks/{page_id}/children?page_size=100'
        if cursor: path += f'&start_cursor={cursor}'
        res = notion_call('GET', path)
        blocks.extend(res.get('results', []))
        cursor = res.get('next_cursor')
        if not cursor: break
    return blocks

# ── Rich text → 마크다운 ──
def rich_to_md(rt_list):
    out = ''
    for rt in rt_list or []:
        t = rt.get('text', {}).get('content', '')
        a = rt.get('annotations', {})
        if a.get('bold'):   t = f'**{t}**'
        if a.get('italic'): t = f'*{t}*'
        if a.get('code'):   t = f'`{t}`'
        out += t
    return out

def block_to_md(block):
    btype = block.get('type', '')
    b = block.get(btype, {})
    text = rich_to_md(b.get('rich_text', []))
    mapping = {
        'heading_1': f'# {text}',
        'heading_2': f'## {text}',
        'heading_3': f'### {text}',
        'paragraph': text or '',
        'bulleted_list_item': f'- {text}',
        'numbered_list_item': f'1. {text}',
        'quote': f'> {text}',
        'divider': '---',
    }
    return mapping.get(btype, text)

# ── 신규 페이지 → .md 파일 저장 ──
def save_page_as_md(page):
    props   = page.get('properties', {})
    title   = ''.join(t.get('text', {}).get('content', '') for t in props.get('영상 제목', {}).get('title', []))
    channel = ''.join(t.get('text', {}).get('content', '') for t in props.get('유튜브 채널', {}).get('rich_text', []))
    topics  = [t.get('name', '') for t in props.get('주제', {}).get('multi_select', [])]
    folder  = topics[0] if topics else '기타'
    upload_date   = props.get('업로드 일자', {}).get('date', {}).get('start', '') or ''
    view_count    = props.get('조회수', {}).get('number', 0) or 0
    sub_count     = props.get('구독자수', {}).get('number', 0) or 0
    video_url     = props.get('영상 URL', {}).get('url', '') or ''
    thumb_url     = props.get('썸네일 URL', {}).get('url', '') or ''
    status        = props.get('처리 상태', {}).get('select', {}).get('name', '') or ''

    date_part = (upload_date[:10].replace('-', '') if upload_date else '00000000')
    filename  = safe_filename(f'{channel}_{title}_{date_part}') + '.md'

    dir_path = os.path.join(VAULT, safe_filename(folder))
    os.makedirs(dir_path, exist_ok=True)

    blocks  = get_blocks(page['id'])
    body_md = '\n'.join(block_to_md(b) for b in blocks)

    md = '\n'.join([
        '---',
        f'title: "{title.replace(chr(34), chr(39))}"',
        f'channel: "{channel}"',
        f'tags: [{", ".join(f"{chr(34)}{t}{chr(34)}" for t in topics)}]',
        f'upload_date: {upload_date or "null"}',
        f'view_count: {view_count}',
        f'subscriber_count: {sub_count}',
        f'video_url: {video_url or "null"}',
        f'thumbnail: {thumb_url or "null"}',
        f'status: {status}',
        f'notion_id: {page["id"]}',
        '---',
        '',
        body_md,
    ])

    open(os.path.join(dir_path, filename), 'w', encoding='utf-8').write(md)
    return folder, filename

# ── 노션 DB 전체 로드 및 신규 파일 추가 ──
def sync_new_pages():
    log('📦 기존 Vault notion_id 수집 중...')
    existing_ids = get_existing_notion_ids()
    log(f'  기존 파일: {len(existing_ids)}개\n')

    log('🔄 Notion DB 조회 중...')
    pages, cursor = [], None
    while True:
        body = {'page_size': 100}
        if cursor: body['start_cursor'] = cursor
        res = notion_call('POST', f'/v1/databases/{NOTION_DB_ID}/query', body)
        pages.extend(res.get('results', []))
        cursor = res.get('next_cursor')
        if not cursor: break
    log(f'  총 {len(pages)}개 페이지\n')

    new_pages = [p for p in pages if p['id'] not in existing_ids]
    log(f'✨ 신규 영상: {len(new_pages)}개\n')

    added = 0
    for i, page in enumerate(new_pages):
        try:
            folder, fname = save_page_as_md(page)
            log(f'  [{i+1}/{len(new_pages)}] {folder}/{fname}')
            added += 1
        except Exception as e:
            log(f'  ❌ 오류: {e}')

    log(f'\n✅ {added}개 신규 파일 추가 완료\n')
    return added

# ── 메인 실행 ──
if __name__ == '__main__':
    log('🚀 Obsidian 증분 동기화 시작\n')

    # 1단계: 신규 파일 추가
    added = sync_new_pages()

    # 2단계: 신규 파일이 있거나 강제 재구성 옵션일 때 Wiki 재구성
    force = '--rebuild' in sys.argv
    if added > 0 or force:
        log('🔧 Wiki 재구성 중 (MOC + 키워드 링크)...')
        build_script = os.path.join(SCRIPT_DIR, 'build_obsidian_wiki.py')
        result = subprocess.run(
            [sys.executable, build_script],
            capture_output=True, text=True
        )
        log(result.stdout)
        if result.returncode != 0:
            log(f'❌ Wiki 재구성 오류:\n{result.stderr}')
        else:
            log('✅ Wiki 재구성 완료!')
    else:
        log('ℹ️  신규 영상 없음 — Wiki 재구성 생략')

    log('\n🎉 Obsidian 동기화 완료!')
