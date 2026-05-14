"""Debug tools: parse a macOS .ips crash report OR a Chromium netlog JSON.

Usage:
  parse_ips.py ips <path.ips>
  parse_ips.py netlog <path.json> [filter_keyword]
"""
import json
import sys


def parse_ips(path):
    with open(path) as f:
        f.readline()
        data = json.load(f)
    faulting = data.get('faultingThread', 0)
    threads = data.get('threads', [])
    images = data.get('usedImages', [])
    print(f"exception: {data.get('exception')}")
    print(f"termination: {data.get('termination')}")
    print(f"procName: {data.get('procName')}  pid: {data.get('pid')}  parentProc: {data.get('parentProc')}")
    print()
    if threads and faulting < len(threads):
        t = threads[faulting]
        frames = t.get('frames', [])
        print(f"faulting thread {faulting} (name={t.get('name', '')}, queue={t.get('queue', '')}):")
        for i, fr in enumerate(frames[:40]):
            idx = fr.get('imageIndex')
            img = images[idx] if idx is not None and idx < len(images) else {}
            sym = fr.get('symbol', '?')
            off = fr.get('symbolLocation', 0)
            print(f"  {i:2d}  {img.get('name', '?'):30s}  {sym}+{off}")


def parse_netlog(path, filt):
    with open(path) as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[warn] truncated netlog ({e}); attempting recovery")
        last_brace = raw.rfind('},\n', 0, len(raw))
        if last_brace < 0:
            last_brace = raw.rfind('},', 0, len(raw))
        if last_brace < 0:
            raise
        fixed = raw[:last_brace + 1] + ']}'
        data = json.loads(fixed)
    consts = data.get('constants', {})
    type_names = {v: k for k, v in consts.get('logEventTypes', {}).items()}
    source_types = {v: k for k, v in consts.get('logSourceType', {}).items()}
    phases = {0: '.', 1: '+', 2: '-'}
    events = data.get('events', [])
    print(f"total events: {len(events)}")
    rows = []
    for e in events:
        tn = type_names.get(e.get('type', -1), f"type_{e.get('type')}")
        sn = source_types.get(e.get('source', {}).get('type', -1), '')
        params = e.get('params', {})
        blob = (tn + ' ' + sn + ' ' + json.dumps(params)).lower()
        if filt.lower() in blob:
            rows.append((e.get('time', ''), phases.get(e.get('phase', 0), '?'), sn, tn, params))
    print(f"matched: {len(rows)}")
    for t, ph, sn, tn, params in rows[:300]:
        p = json.dumps(params) if params else ''
        if len(p) > 300:
            p = p[:300] + '...'
        print(f"  {t} {ph} {sn:30s} {tn:45s} {p}")


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'ips':
        parse_ips(sys.argv[2])
    elif mode == 'netlog':
        parse_netlog(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'proxy')
    else:
        print(__doc__)
        sys.exit(1)
