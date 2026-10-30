import html
from pathlib import Path
HERE = Path(__file__).resolve().parent

e = html.escape
S = []
def a(s): S.append(s)
def text(x, y, s, cls, anchor=None):
    an = f' text-anchor="{anchor}"' if anchor else ''
    a(f'<text class="{cls}" x="{x}" y="{y}"{an}>{e(s)}</text>')

COLS = [30, 410, 790, 1170]
CW = 320
LH = 18

def entity(x, y, name, area, ttl, keys, attrs, kind='node'):
    """keys: list of (label, value). attrs: list of strings."""
    h = 44 + len(keys) * 22 + 10 + (len(attrs) * LH + 8 if attrs else 0)
    a(f'<rect class="{kind}" x="{x}" y="{y}" width="{CW}" height="{h}" rx="10"/>')
    a(f'<rect class="band band-{area}" x="{x}" y="{y}" width="6" height="{h}" rx="3"/>')
    text(x + 18, y + 27, name, 't-title')
    chip(x + CW - 14, y + 13, ttl)
    yy = y + 52
    for lab, val in keys:
        text(x + 18, yy, lab, 't-keylab')
        text(x + 74, yy, val, 't-key')
        yy += 22
    if attrs:
        a(f'<line class="rule" x1="{x+18}" y1="{yy-8}" x2="{x+CW-18}" y2="{yy-8}"/>')
        yy += 10
        for at in attrs:
            text(x + 18, yy, at, 't-attr'); yy += LH
    return h

def chip(xr, y, ttl):
    cls = 'chip-none' if ttl == 'No TTL' else 'chip-ttl'
    w = 10 + len(ttl) * 6.6
    a(f'<rect class="{cls}" x="{xr-w}" y="{y}" width="{w}" height="20" rx="10"/>')
    text(xr - w / 2, y + 14, ttl, 't-chip', 'middle')

P = {}  # name -> (x, y, w, h)
def place(col, y, name, *args, **kw):
    x = COLS[col]
    h = entity(x, y, name, *args, **kw)
    P[name] = (x, y, CW, h)
    return y + h

GAP = 44
# ---- Column 1: identity
y = 80
y = place(0, y, 'Auth identity', 'id', 'No TTL', [('pk', 'AUTH#email:{email}'), ('sk', 'same as pk')], ['userId', 'email (lower-cased)']) + GAP
y = place(0, y, 'User', 'id', 'No TTL', [('pk', 'USER#{userId}'), ('sk', 'same as pk')],
          ['displayName, email, avatarUrl', 'createdAt, updatedAt', 'payoutAccount: legacy, no longer written', '  (bank details stay on device, ADR-0002)']) + GAP
y = place(0, y, 'Sign-in code', 'id', '10 min', [('pk', 'OTP#email:{email}'), ('sk', 'same as pk')], ['codeHash', 'attempts (conditional increment)', 'ttlAt, also checked on read']) + GAP
y = place(0, y, 'Idempotency record', 'id', '24 h', [('pk', 'IDMP#{userId}#{endpoint}'), ('sk', 'KEY#{Idempotency-Key}')], ['stored status + response body']) + GAP
col1_end = y

# ---- Column 2: bills
y = 80
y = place(1, y, 'Image hash index', 'bill', 'No TTL', [('pk', 'IMGHASH#{userId}#{sha256}'), ('sk', 'same as pk')], ['billId', 'dedupes a repeat photo per user']) + GAP
y = place(1, y, 'Bill', 'bill', 'No TTL', [('pk', 'BILL#{billId}'), ('sk', 'V#001, V#002 … (immutable)'), ('sk', 'LATEST (mirror of newest)')],
          ['versionNumber, creatorUserId, currency GBP', 'items[] { itemId, name, unitPricePence,', '  quantity, category, course }',
           'subtotalPence, taxPence,', '  serviceChargePence, totalPence', 'venue { name, address, placeId, lat, lng }',
           'parsedFrom { imageHash, parser,', '  parserVersion, parsedAt, uploadId }']) + GAP
y = place(1, y, 'Table fee', 'bill', 'No TTL', [('pk', 'FEE#{billId}'), ('sk', 'FEE')], ['Stripe checkout state, amount', 'kept as a tax record']) + GAP
y = place(1, y, 'Venue lookup', 'bill', 'No TTL', [('pk', 'VENUEQ#{name+address key}'), ('sk', 'same as pk')], ['Amazon Location answer, or no match', 'source = amazon-location']) + GAP
col2_end = y

# ---- Column 3: sessions
y = 80
y = place(2, y, 'Bill lock', 'sess', '30 days', [('pk', 'BILLLOCK#{billId}'), ('sk', 'same as pk')], ['sessionId, lockedAt', 'create-if-absent; deleted on close or abandon']) + GAP
# Session item collection (custom)
sx, sy = COLS[2], y
rows = [
    ('META', 'META', ['status, creatorUserId, collectorUserId', 'billId, pinnedBillVersion', 'joinCode, venue']),
    ('PART', 'PART#{userId}', ['displayName, claimedItemIds[]', 'sharedItemIds[], owedPence, readyToLock', 'payment { status, paymentId, paidAt }', 'GSI1PK USER#{userId} · GSI1SK sessionId']),
    ('SHARE', 'SHARE#{itemId}', ['ways, version (optimistic lock)', 'activity[] { kind, byUserId, at }']),
    ('CLAIMS', 'CLAIMS', ['version: bumped by claims, splits, amends', 'claim and split writes conditional on it']),
]
ih = [26 + len(r[2]) * LH + 8 for r in rows]
sh = 44 + 22 + 10 + sum(ih) + 10 * len(rows) + 4
a(f'<rect class="node key" x="{sx}" y="{sy}" width="{CW}" height="{sh}" rx="10"/>')
a(f'<rect class="band band-sess" x="{sx}" y="{sy}" width="6" height="{sh}" rx="3"/>')
text(sx + 18, sy + 27, 'Session', 't-title')
chip(sx + CW - 14, sy + 13, '30 days')
text(sx + 18, sy + 52, 'pk', 't-keylab'); text(sx + 74, sy + 52, 'SESS#{sessionId}', 't-key')
text(sx + 18, sy + 70, 'One item collection, read with one Query', 't-attr')
yy = sy + 84
rowpos = {}
for (nm, sk, lines), h in zip(rows, ih):
    a(f'<rect class="inner" x="{sx+14}" y="{yy}" width="{CW-28}" height="{h}" rx="7"/>')
    text(sx + 26, yy + 19, 'sk', 't-keylab'); text(sx + 52, yy + 19, sk, 't-key')
    ly = yy + 38
    for ln in lines:
        text(sx + 26, ly, ln, 't-attr' if not ln.startswith('GSI1') else 't-gsi'); ly += LH
    rowpos[nm] = (yy, h)
    yy += h + 10
P['Session'] = (sx, sy, CW, sh)
y = sy + sh + GAP
y = place(2, y, 'Join code', 'sess', '30 days', [('pk', 'JCODE#{code}'), ('sk', 'same as pk')], ['sessionId', 'create-if-absent (collision check)']) + GAP
col3_end = y

# ---- Column 4: payments + indexes
y = 80
gx, gy = COLS[3], y
gh = 250
a(f'<rect class="node gsi" x="{gx}" y="{gy}" width="{CW}" height="{gh}" rx="10"/>')
text(gx + 18, gy + 27, 'Table gdp-{env}', 't-title')
text(gx + 18, gy + 50, 'On-demand · pk (S) / sk (S) · TTL ttlAt', 't-attr')
text(gx + 18, gy + 80, 'GSI1', 't-inner'); text(gx + 74, gy + 80, 'GSI1PK / GSI1SK', 't-key')
text(gx + 18, gy + 99, 'Only on participant rows: USER#{userId}', 't-attr')
text(gx + 18, gy + 117, '→ sessionId. UUIDv7 ids sort by time,', 't-attr')
text(gx + 18, gy + 135, 'so reverse order = newest first.', 't-attr')
text(gx + 18, gy + 165, 'GSI2', 't-inner'); text(gx + 74, gy + 165, 'GSI2PK', 't-key')
text(gx + 18, gy + 184, 'Only on payment rows:', 't-attr')
text(gx + 18, gy + 202, 'PROVPAY#{providerPaymentId}', 't-attr')
text(gx + 18, gy + 220, 'finds a payment from a webhook.', 't-attr')
P['Table'] = (gx, gy, CW, gh)
y = gy + gh + GAP
pay_y = max(y, P['Session'][1] + rowpos['PART'][0] - P['Session'][1] - 40)
y = place(3, pay_y, 'Payment', 'pay', 'No TTL', [('pk', 'PAY#{paymentId}'), ('sk', 'same as pk'), ('GSI2', 'PROVPAY#{providerPaymentId}')],
          ['sessionId, payerUserId, collectorUserId', 'amountPence, currency GBP', 'provider (truelayer · mock · manual)',
           'status, idempotencyKey', 'events[] { at, from, to, source }', 'createdAt, payerClaimedPaidAt']) + GAP
col4_end = y

H = max(col1_end, col2_end, col3_end, col4_end) + 10
nodes = S[:]; S.clear()

# ---- Edges
def edge(d, labels=(), cls='', both=False):
    ms = ' marker-start="url(#ah)"' if both else ''
    a(f'<g class="edge {cls}"><path d="{d}" marker-end="url(#ah)"{ms}/>')
    for x, y, s, anc in labels:
        a(f'<text x="{x}" y="{y}" text-anchor="{anc}">{e(s)}</text>')
    a('</g>')

def bottom(n): x, y, w, h = P[n]; return x + w / 2, y + h
def top(n): x, y, w, h = P[n]; return x + w / 2, y

# Auth → User
bx, by = bottom('Auth identity'); tx, ty = top('User')
edge(f'M{bx},{by} L{tx},{ty-2}', [(bx + 10, by + 27, 'userId', 'start')])
# Image hash → Bill
bx, by = bottom('Image hash index'); tx, ty = top('Bill')
edge(f'M{bx},{by} L{tx},{ty-2}', [(bx + 10, by + 27, 'billId', 'start')])
# Table fee → Bill (up)
fx = COLS[1] + 50; ty = P['Table fee'][1]; by = P['Bill'][1] + P['Bill'][3]
edge(f'M{fx},{ty} L{fx},{by+2}')
# Bill lock → Bill (left) and → Session (down)
lx, ly, lw, lh = P['Bill lock']
bxr = P['Bill'][0] + CW
ymid = ly + lh / 2
edge(f'M{lx},{ymid} L{bxr+2},{ymid}', [((lx + bxr) / 2, ymid - 8, 'billId', 'middle')])
bx, by = bottom('Bill lock'); tx, ty = top('Session')
edge(f'M{bx},{by} L{tx},{ty-2}', [(bx + 10, by + 27, 'sessionId', 'start')])
# Session META → Bill (pinned version)
my = rowpos['META'][0] + 30
edge(f'M{sx+14},{my} L{bxr+2},{my}', [((sx + bxr) / 2, my - 8, 'billId', 'middle')])
# Join code → Session (up)
tx, ty = top('Join code'); bx, by = bottom('Session')
edge(f'M{tx},{ty} L{bx},{by+2}', [(tx + 10, ty - 17, 'sessionId', 'start')])
# PART → User via GSI1 (route below col2 middle channel)
py_ = rowpos['PART'][0] + rowpos['PART'][1] - 14
ux, uy, uw, uh = P['User']
chan = COLS[1] - 30
route_y = P['Table fee'][1] - 22  # gap between Bill and Table fee
edge(f'M{sx+14},{py_} L{COLS[1]+CW+30},{py_} L{COLS[1]+CW+30},{route_y} L{chan},{route_y} L{chan},{uy+uh/2} L{ux+uw+2},{uy+uh/2}',
     [(COLS[1] + CW / 2 + 40, route_y - 7, 'GSI1: USER#{userId} → my sessions', 'middle')], cls='dashed')
# PART ↔ Payment
pr = rowpos['PART'][0] + 54
pay_x, pay_y2, _, pay_h = P['Payment']
edge(f'M{sx+CW+2},{pr} L{pay_x-2},{pr}', [((sx + CW + pay_x) / 2, pr - 8, 'ids', 'middle')], both=True)

edges = S[:]; S.clear()

# zones / area labels
zones = []
for i, lab in enumerate(['Identity & request safety', 'Bills', 'Sessions', 'Table & payments']):
    zones.append(f'<text class="zone-label" x="{COLS[i]}" y="52">{e(lab)}</text>')

svg = '\n'.join(zones + edges + nodes)
page = (HERE / 'data_model.template.html').read_text().replace('%%SVG%%', svg).replace('%%VBH%%', str(int(H)))
HEAD = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n')
page = HEAD + page.replace('<div class="wrap">', '</head>\n<body>\n<div class="wrap">', 1) + '</body>\n</html>\n'
(HERE.parent / 'data-model.html').write_text(page)
