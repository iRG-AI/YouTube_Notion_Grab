#!/usr/bin/env python3
# ===== Obsidian 증분 동기화 스크립트 =====
# 노션 저장 완료 후 자동 실행:
#   1. 노션 DB에서 신규 영상만 .md 추가
#   2. MOC + 키워드 링크 전체 재구성
# 실행: python3 sync_obsidian.py

import os, re, json, ssl, subprocess, sys, time, unicodedata
from datetime import datetime
from urllib.request import urlopen, Request
from collections import defaultdict

VAULT    = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
MOC_DIR  = os.path.join(VAULT, '_MOC')
LOG_FILE = os.path.join(VAULT, 'log.md')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def nfc(s):
    """macOS NFD 파일명을 NFC로 정규화 (한글 깨짐 방지)"""
    return unicodedata.normalize('NFC', s) if s else s

# ── Wiki log.md에 항목 추가 ──
def write_wiki_log(event_type, summary, details=None):
    """
    event_type: 'ingest' | 'rebuild' | 'error'
    summary: 한 줄 요약
    details: 추가 정보 dict (선택)
    """
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    today = datetime.now().strftime('%Y-%m-%d')

    # log.md 없으면 헤더와 함께 새로 생성
    if not os.path.exists(LOG_FILE):
        header = '# 📋 AI LLM Wiki 변경 이력\n\n> Wiki에 일어난 모든 변경사항을 시간순으로 기록합니다.\n> 파싱 팁: `grep "^## \\[" log.md | tail -10` 으로 최근 10개 확인\n\n'
        open(LOG_FILE, 'w', encoding='utf-8').write(nfc(header))

    # 아이콘 매핑
    icon = {'ingest': '📥', 'rebuild': '🔧', 'error': '❌', 'cleanup': '🧹'}.get(event_type, '📌')

    # 항목 작성
    entry = f'## [{today}] {event_type} | {summary}\n'
    entry += f'> {icon} {now}\n\n'
    if details:
        for k, v in details.items():
            entry += f'- **{k}**: {v}\n'
    entry += '\n'

    # 파일 앞에 추가 (최신이 위로)
    existing = open(LOG_FILE, encoding='utf-8').read()
    # 헤더 이후에 삽입
    insert_pos = existing.find('\n\n', existing.find('파싱 팁')) + 2
    new_content = existing[:insert_pos] + entry + existing[insert_pos:]
    open(LOG_FILE, 'w', encoding='utf-8').write(nfc(new_content))

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
    """notion_id → 파일 경로 dict 반환 (ids 집합도 .keys()로 추출 가능)"""
    id_to_path = {}
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '_MOC']
        for f in files:
            if not f.endswith('.md'): continue
            fpath = os.path.join(root, f)
            content = nfc(open(fpath, encoding='utf-8', errors='ignore').read())
            m = re.search(r'^notion_id:\s*(.+)$', content, re.MULTILINE)
            if m:
                id_to_path[m.group(1).strip()] = fpath
    return id_to_path

# ── 기존 .md 파일의 frontmatter tags 업데이트 ──
def update_tags_in_file(fpath, new_topics):
    """파일 frontmatter의 tags: 라인만 교체. 변경 시 True 반환."""
    try:
        content = nfc(open(fpath, encoding='utf-8', errors='ignore').read())
    except Exception:
        return False
    new_tags_line = f'tags: [{", ".join(chr(34) + t + chr(34) for t in new_topics)}]'
    # 현재 tags 라인 추출해서 비교
    m = re.search(r'^tags:.*$', content, re.MULTILINE)
    if m and m.group(0) == new_tags_line:
        return False  # 변경 없음
    if m:
        updated = content[:m.start()] + new_tags_line + content[m.end():]
    else:
        return False  # tags 라인 없으면 스킵
    open(fpath, 'w', encoding='utf-8').write(nfc(updated))
    return True

# ── 기존 파일 tags Notion과 동기화 (--sync-tags 전용) ──
def sync_existing_tags(pages):
    """Notion의 현재 주제와 Obsidian .md tags를 맞춤. 변경된 파일 수 반환."""
    log('🏷  기존 파일 tags 동기화 중...')
    id_to_path = get_existing_notion_ids()

    updated = 0
    for page in pages:
        pid = page['id']
        if pid not in id_to_path:
            continue
        topics = [nfc(t.get('name', '')) for t in page.get('properties', {}).get('주제', {}).get('multi_select', [])]
        if update_tags_in_file(id_to_path[pid], topics):
            updated += 1

    if updated > 0:
        log(f'  ✅ {updated}개 파일 tags 갱신\n')
    else:
        log(f'  ✅ 변경 없음 (모두 최신 상태)\n')
    return updated

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
    filename  = nfc(safe_filename(f'{channel}_{title}_{date_part}') + '.md')

    dir_path = os.path.join(VAULT, nfc(safe_filename(folder)))
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
    md = nfc(md)  # NFD→NFC 정규화

    open(os.path.join(dir_path, filename), 'w', encoding='utf-8').write(md)
    return folder, filename

# ── 노션 DB 전체 로드 및 신규 파일 추가 ──
def load_all_notion_pages():
    """Notion DB 전체 페이지 로드. pages 리스트 반환."""
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
    return pages

def sync_new_pages(pages=None):
    log('📦 기존 Vault notion_id 수집 중...')
    id_to_path = get_existing_notion_ids()
    existing_ids = set(id_to_path.keys())
    log(f'  기존 파일: {len(existing_ids)}개\n')

    if pages is None:
        pages = load_all_notion_pages()

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
    start = time.time()

    # Notion 페이지 1회 로드 (신규 추가 + tags 동기화 양쪽에서 재사용)
    pages = load_all_notion_pages()

    # 기존 파일 tags를 Notion 현재 주제로 항상 동기화
    # (주제 변경이 없으면 update_tags_in_file이 False 반환 → 실질적 파일 쓰기 0건, 오버헤드 미미)
    tags_updated = sync_existing_tags(pages)

    # 1단계: 신규 파일 추가
    added = sync_new_pages(pages)

    # 2단계: 신규/갱신이 있거나 강제 재구성 옵션일 때 Wiki 재구성
    force = '--rebuild' in sys.argv
    rebuilt = False
    rebuild_err = ''
    if added > 0 or tags_updated > 0 or force:
        log('🔧 Wiki 재구성 중 (MOC + 키워드 링크)...')
        build_script = os.path.join(SCRIPT_DIR, 'build_obsidian_wiki.py')
        result = subprocess.run(
            [sys.executable, build_script],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            rebuild_err = result.stderr
            log(f'❌ Wiki 재구성 오류:\n{rebuild_err}')
        else:
            rebuilt = True
            log('✅ Wiki 재구성 완료!')
    else:
        log('ℹ️  신규 영상 없음 — Wiki 재구성 생략')

    elapsed = round(time.time() - start)
    log('\n🎉 Obsidian 동기화 완료!')

    # ── log.md 기록 ──
    if tags_updated > 0:
        write_wiki_log('tags-sync', f'기존 파일 tags {tags_updated}개 갱신', {
            '갱신 파일': f'{tags_updated}개',
            '소요시간': f'{elapsed}초',
        })
    if added > 0:
        write_wiki_log('ingest', f'신규 영상 {added}개 추가', {
            '추가된 파일': f'{added}개',
            'Wiki 재구성': '완료' if rebuilt else '생략',
            '소요시간': f'{elapsed}초',
        })
    if rebuilt:
        write_wiki_log('rebuild', 'MOC + 키워드 링크 재구성', {
            '처리': 'MOC 전체 재생성, 키워드 링크 삽입',
        })
    if rebuild_err:
        write_wiki_log('error', 'Wiki 재구성 실패', {'오류': rebuild_err[:200]})

    # 결과를 JSON으로 출력 (scheduler.js에서 파싱)
    print('RESULT_JSON:' + json.dumps({
        'added': added,
        'tags_updated': tags_updated,
        'rebuilt': rebuilt,
        'elapsed': elapsed,
        'error': rebuild_err,
    }))
