"""Builds public/native/ircodes.js: infra-red TV code sets for as many brands as possible.

Sources (both free to use):
  * Flipper-IRDB  https://github.com/Lucaslhm/Flipper-IRDB  (CC0)        - TVs/<Brand>/*.ir
  * IRDB          https://github.com/probonopd/irdb                      - codes/<Brand>/<TV type>/*.csv

Usage:
  python scripts/ircodes.py <Flipper-IRDB zip> <irdb zip>
(download https://codeload.github.com/Lucaslhm/Flipper-IRDB/zip/refs/heads/main and
 https://codeload.github.com/probonopd/irdb/zip/refs/heads/master)

Output: window.IR_CODES = { brands: [{ name, sets: [{ src, k: { key: code } }] }] }
A code is [protocol, address, command(, subdevice)] or ['raw', carrierHz, [on, off, on, ...us]].
"""
import csv
import io
import json
import os
import re
import sys
import zipfile

# ---------------------------------------------------------------- key names
KEY_ALIASES = {
    'power': ['power', 'power_toggle', 'pwr', 'on/off', 'power_on_off', 'tv_power', 'power toggle', 'tv power'],
    'power_on': ['power_on', 'power on', 'on'], 'power_off': ['power_off', 'power off', 'off'],
    'mute': ['mute', 'tv_mute', 'volume mute toggle', 'tv mute'],
    'vol_up': ['vol_up', 'volume_up', 'vol+', 'vol_+', 'volume+', 'volume +', 'volume up', 'vol up', 'volume +/cursor rt', 'tv vol ^'],
    'vol_down': ['vol_dn', 'vol_down', 'volume_down', 'vol-', 'vol_-', 'volume-', 'volume -', 'volume down', 'vol down', 'volume -/cursor lt', 'tv vol v'],
    'ch_up': ['ch_next', 'ch_up', 'channel_up', 'ch+', 'chan_up', 'p+', 'prog+', 'channel +', 'channel up', 'channel +/cursor up', 'ch ^'],
    'ch_down': ['ch_prev', 'ch_dn', 'ch_down', 'channel_down', 'ch-', 'chan_down', 'p-', 'prog-', 'channel -', 'channel down', 'channel -/cursor dn', 'ch v'],
    'up': ['up', 'cursor up', 'arrow up', 'nav_up'], 'down': ['down', 'cursor down', 'arrow down', 'nav_down'],
    'left': ['left', 'cursor left', 'arrow left', 'nav_left'], 'right': ['right', 'cursor right', 'arrow right', 'nav_right'],
    'ok': ['ok', 'select', 'cursor enter/select', 'enter_ok', 'ok/enter'],
    'menu': ['menu', 'menu/enter', 'menu / enter', 'setup'],
    'back': ['back', 'return', 'go back', 'back/return'],
    'exit': ['exit'],
    'home': ['home', 'smart', 'smart_hub', 'smart hub', 'my_apps'],
    'input': ['source', 'input', 'input source', 'tv/av', 'av', 'tv/video', 'input_source', 'input select/scroll', 'ext. input', 'input next', 'inputs'],
    'info': ['info', 'display', 'info / recall', 'status'],
    'guide': ['guide', 'epg', 'tv guide'],
    'settings': ['settings', 'options', 'option', 'tools'],
    'play': ['play'], 'pause': ['pause'], 'play_pause': ['play_pause', 'play/pause', 'play pause'], 'stop': ['stop'],
    'rewind': ['rewind', 'rew', 'fast_ba', 'fast_back'], 'forward': ['fast_forward', 'ff', 'fast_fo', 'forward'],
    'red': ['red', 'color button red'], 'green': ['green', 'color button green'], 'yellow': ['yellow', 'color button yellow'], 'blue': ['blue', 'color button blue'],
}
for n in range(10):
    KEY_ALIASES[str(n)] = [str(n), 'digit %d' % n, 'num_%d' % n, 'num%d' % n, '_%d' % n] + (['digit 0/10'] if n == 0 else [])
ALIAS = {a: k for k, al in KEY_ALIASES.items() for a in al}
# Old remotes without arrows use CH/VOL as cursor keys; Exit stands in for Back.
FALLBACK = [('back', 'exit'), ('up', 'ch_up'), ('down', 'ch_down'), ('left', 'vol_down'), ('right', 'vol_up'),
            ('ok', 'menu'), ('settings', 'menu'), ('home', 'menu')]

# Protocols the app can send (see ENCODERS in public/native/drivers.js).
FLIPPER_PROTO = {'NEC': 'nec', 'NECext': 'necext', 'Samsung32': 'samsung32', 'RC5': 'rc5', 'RC5X': 'rc5', 'RC6': 'rc6',
                 'SIRC': 'sirc12', 'SIRC15': 'sirc15', 'SIRC20': 'sirc20', 'Kaseikyo': 'kaseikyo', 'RCA': 'rcaf'}
IRDB_PROTO = {'NEC1': 'nec1', 'NEC': 'nec1', 'NEC2': 'nec1', 'NECx1': 'necx', 'NECx2': 'necx', 'Sharp': 'sharp',
              'Panasonic': 'panasonic', 'RC5': 'rc5', 'RCA-38': 'rca38', 'RCA': 'rca', 'Sony12': 'sony12', 'Sony15': 'sony15',
              'Sony20': 'sony20', 'JVC': 'jvc', 'Mitsubishi': 'mitsubishi', 'Proton': 'proton', 'Pioneer': 'pioneer', 'Emerson': 'emerson'}

TV_CATS = re.compile(r'^(TV|LCD TV|LCD|Plasma|Plasma Displays|Rear Projection DLP TV|HDTV ALL|Unknown_TV|Monitor)$', re.I)
SKIP_BRANDS = {'apple', 'android', 'amazon', 'roku', 'hotels', 'lodgenet', 'enseo', 'guesttek', 'fetch', 'cis box', 'open box', 'telekom'}


def key_of(name):
    n = name.strip().lower().replace('-', '_') if name else ''
    return ALIAS.get(n) or ALIAS.get(n.replace('_', ' '))


def norm_brand(b):
    b = b.replace('_', ' ').strip()
    if b.isupper() and len(b) > 4:
        b = b.title()
    return b


def hexnum(s):
    parts = s.split()
    return sum(int(p, 16) << (8 * i) for i, p in enumerate(parts))


def finish(keys):
    for k, src in FALLBACK:
        if k not in keys and src in keys:
            keys[k] = keys[src]
    keys.pop('exit', None)
    return keys


def flipper_sets(zpath):
    z = zipfile.ZipFile(zpath)
    out = []
    for n in sorted(z.namelist()):
        p = n.split('/')
        if len(p) < 4 or p[1] != 'TVs' or not n.endswith('.ir'):
            continue
        brand = norm_brand(p[2])
        text = z.read(n).decode('utf8', 'replace')
        keys = {}
        for block in re.split(r'^#.*$', text, flags=re.M):
            f = dict(re.findall(r'^(\w+):\s*(.*)$', block, re.M))
            k = key_of(f.get('name', ''))
            if not k or k in keys:
                continue
            if f.get('type') == 'parsed' and f.get('protocol') in FLIPPER_PROTO:
                keys[k] = [FLIPPER_PROTO[f['protocol']], hexnum(f['address']), hexnum(f['command'])]
            elif f.get('type') == 'raw' and f.get('data'):
                d = [abs(int(x)) for x in f['data'].split()]
                if len(d) % 2 == 0:
                    d = d[:-1]
                if 8 <= len(d) <= 300 and sum(d) < 1_500_000:
                    keys[k] = ['raw', int(f.get('frequency', 38000)), d]
        out.append((brand, 'flipper:' + '/'.join(p[2:]), finish(keys)))
    return out


def irdb_sets(zpath):
    z = zipfile.ZipFile(zpath)
    out = []
    for n in sorted(z.namelist()):
        if '/codes/' not in n or not n.endswith('.csv'):
            continue
        rel = n.split('/codes/')[1].split('/')
        if len(rel) < 3 or not TV_CATS.match(rel[1]):
            continue
        brand = norm_brand(rel[0])
        keys = {}
        for r in csv.DictReader(io.TextIOWrapper(z.open(n), encoding='utf8', errors='replace')):
            proto = IRDB_PROTO.get(r.get('protocol', ''))
            k = key_of(r.get('functionname', ''))
            if not proto or not k or k in keys:
                continue
            code = [proto, int(r['device']), int(r['function'])]
            if int(r['subdevice']) >= 0:
                code.append(int(r['subdevice']))
            keys[k] = code
        if '1' not in keys and '2' in keys and keys['2'][0] == 'sharp':  # Sharp's "1" has no name in IRDB
            keys['1'] = keys['2'][:2] + [keys['2'][2] - 1]
        out.append((brand, 'irdb:' + '/'.join(rel), finish(keys)))
    return out


def build(flipper_zip, irdb_zip):
    brands = {}
    for brand, src, keys in irdb_sets(irdb_zip) + flipper_sets(flipper_zip):
        if brand.lower() in SKIP_BRANDS:
            continue
        if not any(k in keys for k in ('power', 'vol_up')) or len(keys) < 4:  # must be testable
            continue
        b = brands.setdefault(brand.lower(), {'name': brand, 'sets': [], 'seen': set()})
        sig = json.dumps([keys.get(k) for k in ('power', 'vol_up', 'mute', 'ch_up')])
        if sig in b['seen']:
            continue
        b['seen'].add(sig)
        b['sets'].append({'src': src, 'k': keys})
    result = []
    for b in sorted(brands.values(), key=lambda x: x['name'].lower()):
        # Most complete code set first; IRDB before Flipper only when equally complete.
        b['sets'].sort(key=lambda s: (-len(s['k']), s['src']))
        result.append({'name': b['name'], 'sets': b['sets']})
    return result


if __name__ == '__main__':
    data = build(sys.argv[1], sys.argv[2])
    js = ("'use strict';\n/* Generated by scripts/ircodes.py from Flipper-IRDB (CC0) and IRDB. Do not edit by hand.\n"
          " * Infra-red TV code sets per brand; see the script for the format. */\n"
          "window.IR_CODES = " + json.dumps({'brands': data}, separators=(',', ':')) + ";\n")
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'native', 'ircodes.js')
    open(out, 'w', encoding='utf8').write(js)
    sets = sum(len(b['sets']) for b in data)
    print(f'{len(data)} brands, {sets} code sets, {len(js) // 1024} KB')
    print(', '.join(f"{b['name']}({len(b['sets'])})" for b in data))
