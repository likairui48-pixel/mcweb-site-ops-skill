#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 APK 上传到 GitHub Release（流式 + 自动重试 + 幂等）。

为什么不用现成的 gh.py release？
  - gh.py 会把整个文件读进内存，且一次失败就整包重传；
  - 47MB 的 universal 包在抖动网络上几乎必然失败。
本脚本：流式发送（内存占用恒定）、失败重试、已存在同名资产先删再传、
同名同大小则跳过（可反复重跑）。

用法：
  python3 gh_release_upload.py --repo OWNER/REPO --tag v1.0.0 \
      --name "同禾境 v1.0.0" --notes-file notes.md \
      --asset a.apk --asset b.apk [--retries 6]
"""
import argparse, hashlib, json, os, sys, time, urllib.request, urllib.error

API = 'https://api.github.com'
UPLOADS = 'https://uploads.github.com'


def token():
    t = os.environ.get('GITHUB_TOKEN', '').strip()
    if not t:
        p = '/workspace/.secrets/github.env'
        if os.path.exists(p):
            for ln in open(p, encoding='utf-8'):
                if ln.startswith('GITHUB_TOKEN='):
                    t = ln.split('=', 1)[1].strip()
    if not t:
        sys.exit('缺少 GITHUB_TOKEN')
    return t


TOK = token()


def api(method, path, body=None, timeout=60):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOK)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'raw': raw[:300].decode('utf-8', 'replace')}


def ensure_release(repo, tag, name, notes):
    st, rel = api('POST', f'/repos/{repo}/releases',
                  {'tag_name': tag, 'name': name or tag, 'body': notes or '',
                   'draft': False, 'prerelease': False})
    if st in (200, 201):
        print(f"✓ 已创建 release {tag}: {rel.get('html_url')}")
        return rel
    if st == 422:
        st2, rel2 = api('GET', f'/repos/{repo}/releases/tags/{tag}')
        if st2 == 200:
            print(f"✓ release {tag} 已存在，复用它: {rel2.get('html_url')}")
            return rel2
    sys.exit(f'✗ 创建 release 失败 HTTP {st}: {str(rel)[:200]}')


def asset_list(repo, rid):
    st, arr = api('GET', f'/repos/{repo}/releases/{rid}/assets?per_page=100')
    return arr if isinstance(arr, list) else []


def delete_asset(repo, aid):
    st, _ = api('DELETE', f'/repos/{repo}/releases/assets/{aid}')
    return st in (204, 200)


def upload(repo, rid, path, tries):
    """流式上传；返回 (ok, info)"""
    name = os.path.basename(path)
    size = os.path.getsize(path)
    ctype = ('application/vnd.android.package-archive' if name.endswith('.apk')
             else 'text/plain; charset=utf-8')
    for attempt in range(1, tries + 1):
        # 每次重试前清掉可能残留的同名资产（半截上传会留下 0 字节资产）
        for a in asset_list(repo, rid):
            if a['name'] == name:
                if a.get('size') == size:
                    print(f"  ⏭  {name} 已存在且大小一致，跳过")
                    return True, a
                print(f"  ♻️  删除残留资产 {name}({a.get('size')}B)")
                delete_asset(repo, a['id'])
        try:
            with open(path, 'rb') as fh:
                req = urllib.request.Request(
                    f'{UPLOADS}/repos/{repo}/releases/{rid}/assets?name={name}',
                    data=fh, method='POST')
                req.add_header('Authorization', 'Bearer ' + TOK)
                req.add_header('Content-Type', ctype)
                req.add_header('Content-Length', str(size))   # 必须显式给，否则会走 chunked
                t0 = time.time()
                with urllib.request.urlopen(req, timeout=1800) as r:
                    a = json.loads(r.read())
                print(f"  ✅ {name}  {a.get('size')}B  {time.time()-t0:.0f}s")
                return True, a
        except urllib.error.HTTPError as e:
            body = e.read()[:200].decode('utf-8', 'replace')
            print(f"  ⚠️  第{attempt}/{tries}次 {name} HTTP {e.code}: {body}")
            if e.code == 400 and 'already_exists' in body:
                continue
        except Exception as e:
            print(f"  ⚠️  第{attempt}/{tries}次 {name} 断线: {type(e).__name__} {str(e)[:80]}")
        time.sleep(min(5 * attempt, 30))
    return False, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--name')
    ap.add_argument('--notes-file')
    ap.add_argument('--asset', action='append', required=True)
    ap.add_argument('--retries', type=int, default=6)
    a = ap.parse_args()

    notes = open(a.notes_file, encoding='utf-8').read() if a.notes_file and os.path.exists(a.notes_file) else ''
    rel = ensure_release(a.repo, a.tag, a.name, notes)
    rid = rel['id']
    ok = fail = 0
    for p in a.asset:
        if not os.path.exists(p):
            print(f"  ❌ 文件不存在 {p}"); fail += 1; continue
        good, info = upload(a.repo, rid, p, a.retries)
        if good:
            ok += 1
            print(f"     {info.get('browser_download_url')}")
        else:
            print(f"  ❌ {os.path.basename(p)} 最终失败"); fail += 1
    print(f"\n结果：成功 {ok} / 失败 {fail}")
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
