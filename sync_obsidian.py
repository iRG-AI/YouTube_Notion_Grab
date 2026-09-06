#!/usr/bin/env python3
# ===== Obsidian 증분 동기화 스크립트 =====
# 노션 저장 완료 후 자동 실행:
#   1. 노션 DB에서 신규 영상만 .md 추가
#   2. MOC + 키워드 링크 전체 재구성
# 실행: python3 sync_obsidian.py

import os, re, json, ssl, shutil, subprocess, sys, time, unicodedata
from datetime import datetime
from urllib.request import urlopen, Request
from collections import defaultdict

VAULT    = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
MOC_DIR  = os.path.join(VAULT, '_MOC')
TRASH_DIR = os.path.join(VAULT, '_trash')
LOG_FILE = os.path.join(VAULT, 'log.md')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TIPS_FOLDER = 'AI 꿀팁'   # v2.8 카톡 링크 노트 폴더. YouTube 로직(고아 격리·tags 동기화)에서 제외된다.

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
NOTION_TIPS_DB_ID = ENV.get('NOTION_TIPS_DB_ID', '')   # v2.8 「AI 꿀팁」. 비어 있으면 꿀팁 동기화 건너뜀

def log(msg): print(msg, flush=True)

# ── Notion API 호출 ──
def notion_call(method, path, body=None):
    data = json.dumps(body).encode('utf-8') if body else None
    for attempt in range(5):
        try:
            ctx = ssl.create_default_context()
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
        except Exception as e:
            if attempt == 4:
                raise e
            time.sleep(1)

# ── 파일명 안전 변환 ──
def safe_filename(s):
    return re.sub(r'[\/\\:*?"<>|#]', '_', s or 'untitled').strip()[:120]

# ── 기존 Vault 파일 정보 수집 (notion_id, relpath, video_url) ──
def get_existing_vault_info():
    """
    id_to_path: notion_id -> fpath
    relpath_set: Vault 상대 파일 경로 집합
    url_to_path: video_url -> fpath
    """
    id_to_path = {}
    relpath_set = set()
    url_to_path = {}

    for root, dirs, files in os.walk(VAULT):
        # 꿀팁 폴더는 YouTube 영상 로직(고아 격리 분모·tags 동기화)에 섞이지 않게 제외 (v2.8)
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('_MOC', '_trash') and nfc(d) != TIPS_FOLDER]
        for f in files:
            if not f.endswith('.md'): continue
            fpath = os.path.join(root, f)
            relpath = nfc(os.path.relpath(fpath, VAULT))
            relpath_set.add(relpath)
            try:
                content = nfc(open(fpath, encoding='utf-8', errors='ignore').read())
                m_id = re.search(r'^notion_id:\s*(.+)$', content, re.MULTILINE)
                if m_id:
                    id_to_path[m_id.group(1).strip()] = fpath
                m_url = re.search(r'^video_url:\s*(.+)$', content, re.MULTILINE)
                if m_url and m_url.group(1).strip() != 'null':
                    url_to_path[m_url.group(1).strip()] = fpath
            except Exception:
                pass
    return id_to_path, relpath_set, url_to_path

def get_existing_notion_ids():
    id_to_path, _, _ = get_existing_vault_info()
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

def get_target_relpath(page):
    props   = page.get('properties', {})
    title   = ''.join(t.get('text', {}).get('content', '') for t in props.get('영상 제목', {}).get('title', []))
    channel = ''.join(t.get('text', {}).get('content', '') for t in props.get('유튜브 채널', {}).get('rich_text', []))
    topics  = [t.get('name', '') for t in props.get('주제', {}).get('multi_select', [])]
    folder  = topics[0] if topics else '기타'
    upload_date = props.get('업로드 일자', {}).get('date', {}).get('start', '') or ''
    date_part   = (upload_date[:10].replace('-', '') if upload_date else '00000000')

    filename = nfc(safe_filename(f'{channel}_{title}_{date_part}') + '.md')
    folder_name = nfc(safe_filename(folder))
    return nfc(os.path.join(folder_name, filename))

def sync_new_pages(pages=None):
    log('📦 기존 Vault 파일 및 notion_id 정보 수집 중...')
    id_to_path, relpath_set, url_to_path = get_existing_vault_info()
    existing_ids = set(id_to_path.keys())
    log(f'  기존 notion_id 등록 파일: {len(existing_ids)}개, Vault md 문서: {len(relpath_set)}개\n')

    if pages is None:
        pages = load_all_notion_pages()

    new_pages = []
    seen_targets = set()

    for page in pages:
        pid = page['id']
        if pid in existing_ids:
            continue

        target_relpath = get_target_relpath(page)
        props = page.get('properties', {})
        video_url = props.get('영상 URL', {}).get('url', '') or ''

        # 이미 Vault에 동일 상대 경로 문서가 존재하거나 동일 video_url 문서가 존재하는 경우 스킵 (중복 노션 페이지 무한 덮어쓰기 방지)
        if target_relpath in relpath_set or (video_url and video_url in url_to_path) or target_relpath in seen_targets:
            continue

        seen_targets.add(target_relpath)
        new_pages.append(page)

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

# ── v2.8: Notion「AI 꿀팁」→ VAULT/AI 꿀팁/*.md (신규만, 평면 폴더) ──
# 설계 제약 (docs/tasks/2026-09-06-kakao-tips-ingest.md §4-1):
#   · 프론트매터 키는 link_url — video_url 절대 금지 (고아 격리 오탐 방지)
#   · 폴더는 TIPS_FOLDER 평면 구조 — wiki_ingest/build_obsidian_wiki 가 최상위 폴더만 순회하므로 하위 폴더 금지
#   · tags 키를 쓰지 않는다 — build_obsidian_wiki 가 tags 없으면 폴더명으로 MOC 를 만든다 (_MOC/AI 꿀팁.md)
#   · 카테고리 '모델/LLM' 의 슬래시는 파일명에 못 쓴다 → safe_filename 이 '_' 로 치환
def sync_tips():
    if not NOTION_TIPS_DB_ID:
        log('ℹ️  NOTION_TIPS_DB_ID 없음 — 꿀팁 동기화 건너뜀\n')
        return 0
    sys.path.insert(0, os.path.join(SCRIPT_DIR, 'lib'))
    import tips_notion as tn

    log('🔗 Notion「AI 꿀팁」조회 중...')
    try:
        pages = tn.load_all_tips(NOTION_TIPS_DB_ID)
    except tn.NotionAuthError as e:
        log(f'🛑 {e} — 꿀팁 동기화 중단'); return 0
    log(f'  총 {len(pages)}건')

    tips_dir = os.path.join(VAULT, TIPS_FOLDER)
    os.makedirs(tips_dir, exist_ok=True)

    existing_ids = set()
    for f in os.listdir(tips_dir):
        if not f.endswith('.md'): continue
        try:
            head = open(os.path.join(tips_dir, f), encoding='utf-8', errors='ignore').read(1500)
            m = re.search(r'^notion_id:\s*(.+)$', head, re.MULTILINE)
            if m: existing_ids.add(m.group(1).strip())
        except Exception:
            pass

    new_pages = [p for p in pages if p['id'] not in existing_ids]
    log(f'✨ 신규 꿀팁: {len(new_pages)}개 (기존 {len(existing_ids)}개)\n')

    added = 0
    for i, page in enumerate(new_pages):
        try:
            r = tn.page_to_row(page)
            date_part = (r['saved_date'][:10].replace('-', '') if r['saved_date'] else '00000000')
            fname = nfc(safe_filename(f"{date_part}_{r['title']}") + '.md')
            # 같은 날 같은 추정 제목("노션 자료 (제목 미확인)" 등)이 여럿이면 덮어쓰기 → notion_id 유실 → 매 실행 재생성.
            # 파일이 이미 있으면(=다른 notion_id) id 끝 6자리를 붙여 유일하게 만든다.
            # (앞자리는 워크스페이스 공통 접두 '3bca3c…'라 구분이 안 된다)
            if os.path.exists(os.path.join(tips_dir, fname)):
                fname = nfc(safe_filename(f"{date_part}_{r['title']}_{page['id'][-6:]}") + '.md')
            # 본문: Notion 페이지에 사용자가 블록을 붙였으면 포함 (보통 비어 있음)
            try:
                body_md = '\n'.join(block_to_md(b) for b in tn.get_blocks(page['id']))
            except Exception:
                body_md = ''
            q = lambda s: (s or '').replace('"', "'")
            lines = [
                '---',
                f'title: "{q(r["title"])}"',
                f'channel: "{q(r["source"])}"',
                'source_type: tip',
                f'category: "{q(r["category"])}"',
                f'keywords: [{", ".join(chr(34) + q(t) + chr(34) for t in r["tags"])}]',
                f'importance: {r["importance"] or "null"}',
                f'status: {r["status"] or "null"}',
                f'upload_date: {r["saved_date"][:10] if r["saved_date"] else "null"}',
                f'link_url: {r["url"] or "null"}',
                f'memo: "{q(r["memo"])}"',
                f'notion_id: {page["id"]}',
                '---',
                '',
                f'# {r["title"]}',
                '',
                f'- 🔗 링크: {r["url"]}',
                f'- 📂 카테고리: {r["category"]}  ·  중요도: {r["importance"]}  ·  상태: {r["status"]}',
                f'- 🏷 태그: {", ".join(r["tags"]) if r["tags"] else "(없음)"}',
                f'- 🗓 저장일: {r["saved_date"]}  ·  출처: {r["source"]}',
            ]
            if r['memo']:
                lines.append(f'- 📝 메모: {r["memo"]}')
            if body_md.strip():
                lines += ['', '## 본문', '', body_md]
            open(os.path.join(tips_dir, fname), 'w', encoding='utf-8').write(nfc('\n'.join(lines)) + '\n')
            log(f'  [{i+1}/{len(new_pages)}] {TIPS_FOLDER}/{fname}')
            added += 1
        except Exception as e:
            log(f'  ❌ 꿀팁 오류: {e}')

    log(f'\n✅ 꿀팁 {added}개 신규 파일 추가 완료\n')
    return added

# ── 고아 파일 격리 (Notion에서 삭제된 페이지의 .md) ──
def quarantine_orphans(pages, dry_run=False):
    """
    Notion 활성 페이지에 없는 notion_id를 가진 .md를 _trash/로 이동. 이동 건수 반환.
    삭제가 아니라 이동인 이유: Notion API 일시 장애로 페이지 목록이 비면 대량 소실이 되므로
    되돌릴 수 있어야 한다. 아래 3중 안전장치가 모두 통과할 때만 실행한다.
    """
    log('🧹 고아 파일 점검 중 (Notion에서 삭제된 페이지)...')
    id_to_path, _, _ = get_existing_vault_info()

    # 안전장치 1: Notion 페이지 로드 실패 시 아무것도 하지 않는다
    if not pages:
        log('  ⚠️  Notion 페이지 0건 — 고아 정리를 건너뜁니다 (API 오류 의심)\n')
        return 0
    # 안전장치 2: 로드된 페이지가 기존 파일의 절반도 안 되면 부분 로드로 간주
    if len(pages) < len(id_to_path) * 0.5:
        log(f'  ⚠️  Notion {len(pages)}건 < Vault {len(id_to_path)}건의 50% — 부분 로드 의심, 건너뜁니다\n')
        return 0

    live_ids = {p['id'] for p in pages}

    def is_video_note(fpath):
        """영상 노트만 격리 대상. schema.md 등 Vault 시스템 문서 오탐 방지."""
        relpath = os.path.relpath(fpath, VAULT)
        if os.path.dirname(relpath) == '':      # 영상 노트는 항상 토픽 폴더 안에 있다
            return False
        try:
            head = nfc(open(fpath, encoding='utf-8', errors='ignore').read(1500))
        except Exception:
            return False
        m = re.search(r'^video_url:\s*(.+)$', head, re.MULTILINE)
        return bool(m and m.group(1).strip() not in ('', 'null'))

    orphans = [(nid, fp) for nid, fp in id_to_path.items()
               if nid not in live_ids and is_video_note(fp)]

    if not orphans:
        log('  ✅ 고아 파일 없음\n')
        return 0

    # 안전장치 3: 고아 비율이 40%를 넘으면 정상 상황이 아니다
    ratio = len(orphans) / max(len(id_to_path), 1)
    if ratio > 0.4:
        log(f'  🚨 고아가 {len(orphans)}개({ratio:.0%})로 과다 — 안전을 위해 중단합니다. 수동 확인 필요\n')
        return 0

    log(f'  대상: {len(orphans)}개 ({ratio:.1%})')
    if dry_run:
        for nid, fp in orphans[:20]:
            log(f'    [dry-run] {nfc(os.path.relpath(fp, VAULT))}')
        if len(orphans) > 20:
            log(f'    ... 외 {len(orphans) - 20}개')
        log('  ℹ️  dry-run 모드 — 실제 이동 없음\n')
        return 0

    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    moved = 0
    for nid, fpath in orphans:
        try:
            relpath = os.path.relpath(fpath, VAULT)
            dest = os.path.join(TRASH_DIR, stamp, relpath)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(fpath, dest)
            moved += 1
        except Exception as e:
            log(f'  ❌ 이동 실패 {os.path.basename(fpath)}: {e}')

    log(f'  ✅ {moved}개를 _trash/{stamp}/ 로 이동 (내용 보존)\n')
    return moved

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

    # 1.5단계: Notion에서 삭제된 페이지의 고아 .md 격리
    # (--orphans-dry-run: 대상만 출력하고 이동하지 않음)
    orphans_removed = quarantine_orphans(pages, dry_run='--orphans-dry-run' in sys.argv)

    # 1.8단계 (v2.8): 「AI 꿀팁」DB → AI 꿀팁/ 노트 (신규만). 고아 격리 이후에 실행해 격리 분모에 섞이지 않게 한다.
    tips_added = 0 if '--no-tips' in sys.argv else sync_tips()
    added += tips_added

    # 2단계: 신규/갱신이 있거나 강제 재구성 옵션일 때 Wiki 재구성
    force = '--rebuild' in sys.argv
    rebuilt = False
    rebuild_err = ''
    if added > 0 or tags_updated > 0 or orphans_removed > 0 or force:
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

    # 3단계: Karpathy Wiki Ingest (신규 소스가 있을 때만)
    wiki_ingested = False
    wiki_err = ''
    if added > 0 or force:
        log('\n🧠 Karpathy Wiki Ingest 실행 중...')
        wiki_script = os.path.join(SCRIPT_DIR, 'wiki_ingest.py')
        if os.path.exists(wiki_script):
            wiki_result = subprocess.run(
                [sys.executable, wiki_script],
                capture_output=True, text=True
            )
            if wiki_result.returncode != 0:
                wiki_err = wiki_result.stderr[:200]
                log(f'❌ Wiki Ingest 오류:\n{wiki_err}')
            else:
                wiki_ingested = True
                log('✅ Wiki Ingest 완료!')
        else:
            log('ℹ️  wiki_ingest.py 없음 — 건너뜀')

    # 4단계: 검색 인덱스 증분 갱신 (신규/변경이 있을 때만)
    if added > 0 or tags_updated > 0 or orphans_removed > 0 or force:
        log('\n🔍 검색 인덱스 갱신 중...')
        idx_script = os.path.join(SCRIPT_DIR, 'build_search_index.py')
        if os.path.exists(idx_script):
            idx_result = subprocess.run([sys.executable, idx_script], capture_output=True, text=True)
            if idx_result.returncode != 0:
                log(f'❌ 검색 인덱스 갱신 오류:\n{idx_result.stderr[:200]}')
            else:
                log('✅ 검색 인덱스 갱신 완료!')

    elapsed = round(time.time() - start)
    log('\n🎉 Obsidian 동기화 완료!')

    # ── log.md 기록 ──
    if tags_updated > 0:
        write_wiki_log('tags-sync', f'기존 파일 tags {tags_updated}개 갱신', {
            '갱신 파일': f'{tags_updated}개',
            '소요시간': f'{elapsed}초',
        })
    if added > 0:
        write_wiki_log('ingest', f'신규 영상 {added - tips_added}개 · 꿀팁 {tips_added}개 추가', {
            '추가된 파일': f'{added}개 (영상 {added - tips_added} / 꿀팁 {tips_added})',
            'Wiki 재구성': '완료' if rebuilt else '생략',
            '소요시간': f'{elapsed}초',
        })
    if orphans_removed > 0:
        write_wiki_log('cleanup', f'고아 파일 {orphans_removed}개 격리', {
            '격리 위치': '_trash/ (내용 보존)',
            '사유': 'Notion에서 삭제된 페이지의 잔여 .md',
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
        'tips_added': tips_added,
        'tags_updated': tags_updated,
        'orphans_removed': orphans_removed,
        'rebuilt': rebuilt,
        'elapsed': elapsed,
        'error': rebuild_err,
    }))
