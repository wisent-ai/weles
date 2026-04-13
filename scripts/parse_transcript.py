import json

src = '/Users/lukaszbartoszcze/.claude/projects/-Users-lukaszbartoszcze-Documents-CodingProjects-Wisent-content-platform/37cb61b7-06ed-4322-a08a-aaefc3df83df.jsonl'
dst = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/conversation_clean.txt'

out = open(dst, 'w')
count = 0
for line in open(src):
    try:
        obj = json.loads(line)
    except Exception:
        continue
    msg = obj.get('message', {})
    role = msg.get('role', '')
    if not role:
        continue
    content = msg.get('content', '')
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                if c.get('type') == 'text':
                    parts.append(c.get('text', ''))
                elif c.get('type') == 'tool_result':
                    t = c.get('content', '')
                    if isinstance(t, str) and len(t) < 500:
                        parts.append('[tool_result: ' + t + ']')
                    elif isinstance(t, str):
                        parts.append('[tool_result: ' + t[:200] + '...]')
                elif c.get('type') == 'tool_use':
                    name = c.get('name', '')
                    inp = json.dumps(c.get('input', {}))
                    if len(inp) > 300:
                        inp = inp[:300] + '...'
                    parts.append('[' + name + ': ' + inp + ']')
            elif isinstance(c, str):
                parts.append(c)
        content = '\n'.join(parts)
    if isinstance(content, str) and len(content) > 1000:
        content = content[:1000] + '...'
    if not content or not content.strip():
        continue
    ts = obj.get('timestamp', '')[:19]
    out.write('=== ' + ts + ' [' + role + '] ===\n' + content + '\n\n')
    count += 1

out.close()
print('Wrote', count, 'messages to', dst)
