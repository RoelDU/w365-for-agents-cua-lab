#!/usr/bin/env python
"""Replace every non-ASCII byte in src/ and res/ with ASCII equivalents.

Mapping:
    U+2014 EM DASH     ->  ' - '   (preserves spacing like "X - Y")
    U+2013 EN DASH     ->  '-'
    U+2026 ELLIPSIS    ->  '...'
    U+2022 BULLET      ->  '*'
    U+2018/U+2019      ->  "'"
    U+201C/U+201D      ->  '"'
    U+00A9 COPYRIGHT   ->  '(c)'
    U+2192 RIGHT ARROW ->  '->'
    U+2190 LEFT ARROW  ->  '<-'
    U+2191/2193 UP/DN  ->  '^' / 'v'
    everything else    ->  '?'
"""
import os, sys

REPLACE = {
    '\u2014': ' - ',
    '\u2013': '-',
    '\u2026': '...',
    '\u2022': '*',
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
    '\u00A9': '(c)',
    '\u00AE': '(R)',
    '\u2122': '(TM)',
    '\u2192': '->',
    '\u2190': '<-',
    '\u2191': '^',
    '\u2193': 'v',
    '\u00A0': ' ',
}

def fix_text(s):
    out = []
    for ch in s:
        if ord(ch) < 0x80:
            out.append(ch)
        elif ch in REPLACE:
            out.append(REPLACE[ch])
        else:
            out.append('?')
    s2 = ''.join(out)
    # collapse "X  -  Y" caused by EM_DASH replacement
    while '  -  ' in s2:
        s2 = s2.replace('  -  ', ' - ')
    return s2

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    n_files = n_changed = 0
    for dirpath, _, filenames in os.walk(root):
        if any(p in dirpath for p in ('\\out', '/out', '\\data\\', '/data/', '\\.git', '/.git', '\\dist', '/dist')):
            continue
        for fn in filenames:
            if not (fn.endswith('.c') or fn.endswith('.h') or fn.endswith('.rc')):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, 'rb') as f:
                raw = f.read()
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = raw.decode('cp1252')
            fixed = fix_text(text)
            n_files += 1
            if fixed != text:
                # Write back as ASCII bytes; should be pure ASCII now.
                ascii_bytes = fixed.encode('ascii', errors='replace')
                with open(path, 'wb') as f:
                    f.write(ascii_bytes)
                n_changed += 1
                print('FIXED', path)
    print('Scanned', n_files, 'files, changed', n_changed)

if __name__ == '__main__':
    main()
