# Extracts every shell command run for the Hezar Nafar Poshteshe research from the session transcript, with UTC
# timestamps and the start of its output, redacting anything that looks like a credential.
import json, sys, re
lines = [json.loads(l) for l in open(sys.argv[1])]
uses, results = [], {}
for l in lines:
    msg = l.get('message') or {}
    content = msg.get('content')
    if not isinstance(content, list): continue
    for c in content:
        if c.get('type') == 'tool_use' and c.get('name') == 'Bash':
            uses.append((l.get('timestamp'), c['id'], c['input'].get('command', ''), c['input'].get('description', '')))
        elif c.get('type') == 'tool_result':
            out = c.get('content')
            if isinstance(out, list): out = '\n'.join(x.get('text', '') for x in out if isinstance(x, dict))
            results[c['tool_use_id']] = (l.get('timestamp'), out or '', c.get('is_error', False))
KEY = re.compile(r'(?i)(hezar|/hn/|\bhn/|tools/|shohada|official\.xls|xls_rows|parse_shq|exact_match|search-keys|brave|customsearch|googleapis)')
SECRET = [re.compile(p) for p in [r'BSA[A-Za-z0-9_-]{10,}', r'AIza[0-9A-Za-z_-]{20,}', r'sk-ant-[A-Za-z0-9_-]+', r'(?i)(password|secret|token|api[_-]?key)(["\']?\s*[:=]\s*["\']?)([^\s"\',}]{6,})', r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+', r'npg_[A-Za-z0-9]+', r'postgres(ql)?://[^\s"\']+']]
def clean(s):
    for p in SECRET:
        s = p.sub(lambda m: (m.group(1) + m.group(2) + '[REDACTED]') if p.groups >= 3 and m.lastindex and m.lastindex >= 3 else '[REDACTED]', s)
    return s
runs = []
for ts, tid, cmd, desc in uses:
    if not KEY.search(cmd): continue
    rts, out, err = results.get(tid, (None, '', False))
    out = '\n'.join(l for l in out.splitlines() if 'ExperimentalWarning' not in l and 'UNDICI-EHPA' not in l and 'trace-warnings' not in l)
    runs.append({'started': ts, 'finished': rts, 'description': desc, 'command': clean(cmd), 'failed': bool(err), 'output': clean(out[:3000])})
json.dump(runs, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(len(runs), 'runs, first', runs[0]['started'], 'last', runs[-1]['started'])
