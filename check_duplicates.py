#!/usr/bin/env python3
import json, ssl, re
from urllib.request import urlopen, Request
from collections import defaultdict

env = {}
for line in open('/Users/tycoonan/Documents/Claude/Youtube_Notion_Grap/.env').read().split('\n'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, _, v = line.partition('=')
    env[k.strip()] = v.strip()

TOKEN = env['NOTION_TOKEN']
DB_ID = env['NOTION_DB_ID']
ctx = ssl.create_default_context()

def notion_call(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = Request(f'https://api.notion.com{path}', data=data, method=method,
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28'})
    with urlopen(req, context=ctx, timeout=30) as res:
        return json.loads(res.read())

print('로딩 중...')
pages, cursor = [], None
while True:
    body = {'page_size': 100}
    if cursor: body['start_cursor'] = cursor
    res = notion_call('POST', f'/v1/databases/{DB_ID}/query', body)
    pages.extend(res.get('results', []))
    cursor = res.get('next_cursor')
    if not cursor: break

print(f'총 {len(pages)}개\n')

# 1. 주제 태그 내 중복 (같은 태그가 두 번 있는 것)
topic_dups = []
for page in pages:
    props = page.get('properties', {})
    title = ''.join(t.get('text',{}).get('content','') for t in props.get('영상 제목',{}).get('title',[]))
    topics = [t.get('name','') for t in props.get('주제',{}).get('multi_select',[])]
    unique = list(dict.fromkeys(topics))
    if len(topics) != len(unique):
        topic_dups.append({'id': page['id'], 'title': title, 'topics': topics, 'unique': unique})

print(f'=== 주제 태그 내 중복: {len(topic_dups)}개 ===')
for item in topic_dups:
    print(f'  {item["title"][:50]} | {item["topics"]} → {item["unique"]}')

# 2. URL 기준 중복 영상
url_map = defaultdict(list)
title_map = defaultdict(list)
for page in pages:
    props = page.get('properties', {})
    title = ''.join(t.get('text',{}).get('content','') for t in props.get('영상 제목',{}).get('title',[]))
    video_url = props.get('영상 URL',{}).get('url','') or ''
    m = re.search(r'[?&]v=([a-zA-Z0-9_-]{11})', video_url)
    vid = m.group(1) if m else ''
    topics = [t.get('name','') for t in props.get('주제',{}).get('multi_select',[])]
    if vid:
        url_map[vid].append({'id': page['id'], 'title': title, 'topics': topics, 'url': video_url})
    if title:
        title_map[title].append({'id': page['id'], 'topics': topics, 'url': video_url})

url_dups = {v: items for v, items in url_map.items() if len(items) > 1}
title_dups = {t: items for t, items in title_map.items() if len(items) > 1}
print(f'\n=== URL 기준 중복: {len(url_dups)}개 ===')
for vid, items in url_dups.items():
    print(f'  videoId: {vid}')
    for item in items:
        print(f'    {item["title"][:50]} | {item["topics"]}')

print(f'\n=== 제목 기준 중복: {len(title_dups)}개 ===')
for title, items in title_dups.items():
    print(f'  {title[:60]}')
    for item in items:
        print(f'    주제: {item["topics"]} | URL: {item["url"][:50]}')

print('\nDONE')
