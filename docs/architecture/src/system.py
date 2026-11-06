import html
from pathlib import Path
HERE = Path(__file__).resolve().parent

e = html.escape
S = []
def a(s): S.append(s)

def rect(x, y, w, h, cls='node', rx=10):
    a(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>')
def text(x, y, s, cls='t-sub', anchor=None):
    an = f' text-anchor="{anchor}"' if anchor else ''
    a(f'<text class="{cls}" x="{x}" y="{y}"{an}>{e(s)}</text>')
def card(x, y, w, h, title, lines, cls='node'):
    rect(x, y, w, h, cls)
    text(x + 16, y + 28, title, 't-title')
    yy = y + 50
    for ln in lines:
        c = 't-sub'
        if isinstance(ln, tuple):
            ln, c = ln
        text(x + 16, yy, ln, c)
        yy += 19
def edge(d, labels=(), both=False, cls='', marker='ah'):
    ms = f' marker-start="url(#{marker})"' if both else ''
    a(f'<g class="edge {cls}"><path d="{d}" marker-end="url(#{marker})"{ms}/>')
    for (x, y, s, anc) in labels:
        a(f'<text x="{x}" y="{y}" text-anchor="{anc}">{e(s)}</text>')
    a('</g>')

COUNTS = {'eps': 0, 'groups': 0}
def group(x, y, w, title, base, eps):
    COUNTS['eps'] += len(eps); COUNTS['groups'] += 1
    h = 30 + len(eps) * 18 + 8
    rect(x, y, w, h, 'inner', 7)
    text(x + 12, y + 21, title, 't-inner')
    text(x + w - 12, y + 21, base, 't-base', 'end')
    yy = y + 41
    for m, p in eps:
        a(f'<text class="t-ep" x="{x+12}" y="{yy}"><tspan class="m m-{m.lower()}">{m}</tspan><tspan x="{x+68}">{e(p)}</tspan></text>')
        yy += 18
    return y + h

# ---------- geometry ----------
W, H = 1640, 1378
LX, LW = 560, 520            # lambda
C4X, C4W = 1150, 220         # aws services nodes
C5X, C5W = 1435, 185         # external nodes

# Edges first (under nodes) are collected separately, so build node SVG into S then edges into E.
nodes_start = len(S)

# Zones
a(f'<rect class="zone" x="20" y="20" width="220" height="1308" rx="14"/>')
a('<text class="zone-label" x="38" y="48">Clients</text>')
a(f'<rect class="zone" x="270" y="20" width="240" height="1308" rx="14"/>')
a('<text class="zone-label" x="288" y="48">Frontend · apps/web</text>')
a(f'<rect class="zone aws" x="530" y="20" width="870" height="1308" rx="14"/>')
a('<text class="zone-label" x="548" y="48">AWS · eu-west-2 · CDK stack gdp-{env}</text>')
a(f'<rect class="zone" x="1420" y="20" width="200" height="1308" rx="14"/>')
a('<text class="zone-label" x="1435" y="48">Third parties</text>')
zones = S[nodes_start:]; del S[nodes_start:]

# ---- Column 4: AWS services, sequential with gaps for external lines
c4 = [
    ('ddb', 395), ('ses', 88), ('sec', 90),
    ('cw', 100), ('sns', 60), ('gap', 'stripe'), ('bedrock', 84), ('location', 60), ('s3', 96),
]
y = 70; pos = {}; gaps = {}; prev = None
for k, v in c4:
    if k == 'gap':
        gaps[v] = y + 18; y += 36
    else:
        if prev == 'node': y += 14
        pos[k] = (y, v); y += v
    prev = 'gap' if k == 'gap' else 'node'
# adjust: sns follows cw with 20 gap (already)
# The routes list sets the height: room for it plus the providers strip.
LAMBDA_TOP, LAMBDA_BOTTOM = 160, max(pos['s3'][0] + pos['s3'][1], 1254) + 44

edges = []
def E(*args, **kw):
    mark = len(S); edge(*args, **kw); edges.extend(S[mark:]); del S[mark:]

# ---- Clients
card(40, 70, 180, 118, 'Lead diner', ['Mobile browser', 'Photographs the bill', 'Bank details kept on', 'device (ADR-0002)'], 'node key')
card(40, 300, 180, 100, 'Guests', ['Mobile browser', 'Join by QR or code', 'Up to ~10 people'])
card(40, 520, 180, 100, 'Guest’s bank app', ['Pays the lead by', 'bank transfer'], 'node ext')

# ---- Frontend
rect(290, 70, 200, 400, 'node key')
text(306, 98, 'Web app', 't-title')
text(306, 118, 'Next.js 16 · React 19')
text(306, 137, 'Vercel · paymeback.dev')
for i, (t, l1, l2) in enumerate([
    ('Pages + UI', 'App Router, Option D', 'components/ui.tsx'),
    ('Server state', 'TanStack Query', 'cache + refetch'),
]):
    yy = 156 + i * 80
    rect(306, yy, 168, 68, 'inner', 7)
    text(318, yy + 22, t, 't-inner'); text(318, yy + 42, l1); text(318, yy + 59, l2)
rect(306, 316, 168, 138, 'inner', 7)
text(318, 338, 'API client', 't-inner')
text(318, 358, 'packages/core', 't-mono')
text(318, 378, 'Types from openapi.yaml')
text(318, 397, 'Hooks, owed.ts maths')
text(318, 416, 'Image re-encode, sha256')
text(318, 435, 'QR + quick-pay links')

# ---- API Gateway
rect(LX, 70, LW, 64, 'node key')
text(LX + 16, 98, 'API Gateway · HTTP API', 't-title')
text(LX + 16, 120, 'api.paymeback.dev · api.test.paymeback.dev · every route → one Lambda')

# ---- Lambda
rect(LX, LAMBDA_TOP, LW, LAMBDA_BOTTOM - LAMBDA_TOP, 'node key')
text(LX + 16, LAMBDA_TOP + 28, 'Lambda · ApiHandler', 't-title')
text(LX + LW - 16, LAMBDA_TOP + 28, 'Node 22 · Hono · apps/api', 't-sub', 'end')
rect(LX + 16, 206, LW - 32, 64, 'inner', 7)
text(LX + 28, 228, 'Middleware', 't-inner')
text(LX + 28, 248, 'requestId → requestLogger → CORS (allow-list) → errorHandler', 't-mono')
text(LX + 28, 264, 'per route: session JWT auth · Idempotency-Key', 't-mono')
text(LX + 16, 296, 'ROUTES · openapi.yaml', 'zone-label')

AX, AW = LX + 16, 246
BX, BW = LX + 16 + 246 + 12, LW - 32 - 246 - 12
y = 308
y = group(AX, y, AW, 'Ops', '/', [('GET', '/healthz'), ('GET', '/readyz'), ('GET', '/docs'), ('GET', '/swagger'), ('GET', '/openapi.yaml')]) + 10
y = group(AX, y, AW, 'Auth', '/v1/auth/email', [('POST', '/start'), ('POST', '/verify'), ('POST', '/test-sign-in')]) + 10
y = group(AX, y, AW, 'Me', '/v1/me', [('GET', '/'), ('POST', '/sign-out'), ('PUT', '/payout-account'), ('GET', '/sessions')]) + 10
y = group(AX, y, AW, 'Bills', '/v1/bills', [('POST', '/uploads'), ('POST', '/parse'), ('POST', '/reads'), ('GET', '/reads/{readId}'), ('GET', '/{billId}'), ('GET', '/{billId}/image-url'), ('POST', '/{billId}/amend'), ('POST', '/{billId}/fork')]) + 10
y = group(AX, y, AW, 'Payments', '/v1/payments', [('GET', '/{paymentId}'), ('POST', '/{paymentId}/confirm'), ('POST', '/{paymentId}/mark-paid')]) + 10
y = group(AX, y, AW, 'Billing', '/v1/billing', [('POST', '/table-fee'), ('GET', '/table-fee/{billId}'), ('GET', '/me')]) + 10
y = group(AX, y, AW, 'Webhooks', '/webhooks', [('POST', '/stripe')]) + 10
colA_end = y

y = 308
y = group(BX, y, BW, 'Sessions', '/v1/sessions', [
    ('POST', '/'), ('POST', '/preview'), ('POST', '/guest-join'), ('POST', '/by-code'), ('GET', '/{id}'), ('PATCH', '/{id}'), ('PUT', '/{id}/payout-check'), ('POST', '/{id}/share'), ('POST', '/{id}/join'),
    ('POST', '/{id}/claims'), ('POST', '/{id}/shares'), ('PUT', '/{id}/shares/{itemId}'), ('DELETE', '/{id}/shares/{itemId}'),
    ('POST', '/{id}/ready'), ('POST', '/{id}/lock-claims'), ('POST', '/{id}/close'), ('POST', '/{id}/report'),
    ('POST', '/{id}/abandon'), ('POST', '/{id}/open-payments'), ('POST', '/{id}/payments'), ('GET', '/{id}/comments'), ('POST', '/{id}/comments'), ('POST', '/{id}/proofs'), ('GET', '/{id}/proofs'), ('POST', '/{id}/proofs/{pid}/sent'), ('DELETE', '/{id}/proofs/{pid}')]) + 10
svc_top = y
svc = [
    ('auth', 'emailOtp, sessionToken (JWT)'),
    ('bills', 'upload, parse, amend, fork, image'),
    ('bills', 'parser, venueResolver'),
    ('sessions', 'allocation, joinCode, report'),
    ('payments', 'paymentService, ledger'),
    ('billing', 'tableFee'),
    ('email', 'sender (SES or console)'),
    ('storage', 'one store per entity'),
]
# The services list sets the floor for both columns, so it never runs into the providers strip.
colA_end = max(colA_end, svc_top + 34 + 40 * len(svc))
svc_h = colA_end - 10 - svc_top
rect(BX, svc_top, BW, svc_h, 'inner', 7)
text(BX + 12, svc_top + 21, 'Services', 't-inner')
text(BX + BW - 12, svc_top + 21, 'src/services', 't-base', 'end')
yy = svc_top + 44
for mod, desc in svc:
    text(BX + 12, yy, mod, 't-mono'); text(BX + 12, yy + 17, desc); yy += 40

# providers strip
py = colA_end
rect(AX, py, LW - 32, LAMBDA_BOTTOM - 16 - py, 'inner', 7)
text(AX + 12, py + 22, 'Swappable providers (env)', 't-inner')
text(AX + 12, py + 44, 'Parser: Bedrock · fixture', 't-mono')
text(AX + 12, py + 62, 'Email: SES · console     Venue: Location · none', 't-mono')

# ---- Column 4 nodes
def c4card(k, title, lines, cls='node'):
    yy, h = pos[k]; card(C4X, yy, C4W, h, title, lines, cls)
ddb_y, ddb_h = pos['ddb']
rect(C4X, ddb_y, C4W, ddb_h)
text(C4X + 16, ddb_y + 28, 'DynamoDB', 't-title')
text(C4X + 16, ddb_y + 50, 'Table gdp-{env} · on-demand')
text(C4X + 16, ddb_y + 69, 'pk/sk · GSI1 · TTL')
yy = ddb_y + 98
for keys, desc in [('USER# AUTH# SIGNIN#', 'Accounts, sign-in codes'), ('BILL# IMGHASH# READ# ANALYSIS#', 'Bills, photo dedupe, reads, read cache'),
                   ('BILLLOCK#', 'Bill held by a session'), ('SESS# PART# SHARE#', 'Sessions, diners, splits'), ('COMMENT# PROOF#', 'Comments, payment screenshots'),
                   ('JCODE# PAY#', 'Join codes, guest payments to the lead'),
                   ('FEE# CREDIT# HOLDQ#', 'Platform fee holds, free credits'), ('IDMP# KEY#  VENUEQ#', 'Idempotency, venue lookups')]:
    text(C4X + 16, yy, keys, 't-mono'); text(C4X + 16, yy + 17, desc); yy += 36
c4card('ses', 'Amazon SES', ['Sign-in codes, bill reports', 'Daily cost email (GdpCostReport)'])
c4card('sec', 'Secrets Manager + SSM', ['JWT and Stripe secrets', 'read at cold start'])
c4card('cw', 'CloudWatch', ['Logs, dashboard, alarms', 'EventBridge: daily hold', 'sweep invokes the Lambda'])
c4card('sns', 'SNS', ['Alert topic'])
c4card('bedrock', 'Bedrock', ['Claude Sonnet 4.6 reads the bill,', 'venue name and address'])
c4card('location', 'Amazon Location', ['Venue lookup'])
c4card('s3', 'S3', ['gdp-bills-raw-{env}', 'Private · Glacier IR at 30 d', 'Deleted at 365 d · proofs/ at 30 d'])

# ---- Column 5 externals at gap y's
def ext(key, title, lines, h=72):
    cy = gaps[key]; card(C5X, cy - h // 2, C5W, h, title, lines, 'node ext')
ext('stripe', 'Stripe', ['£1 hold Checkout', 'Capture or cancel'], 82)
s3y = pos['s3'][0]
card(C5X, s3y - 10, C5W, 92, 'GitHub Actions', ['CI, e2e, typecheck', 'Deploys dev from main'], 'node ext')

nodes = S[:]; S.clear()

# ---- Edges
E('M220,120 L288,120', [(254, 112, 'HTTPS', 'middle')])
E('M220,350 C256,350 252,260 288,260', [(254, 312, 'HTTPS', 'middle')])
E('M130,400 L130,518', [(140, 466, 'Pay the lead', 'start')])
E(f'M490,102 L{LX-2},102', [(525, 94, 'REST /v1', 'middle')])
E(f'M820,134 L820,{LAMBDA_TOP-2}')
E(f'M1080,{ddb_y+140} L{C4X-2},{ddb_y+140}', [(1115, ddb_y+132, 'SDK', 'middle')], both=True)
E(f'M1080,{pos["ses"][0]+35} L{C4X-2},{pos["ses"][0]+35}', [(1115, pos["ses"][0]+27, 'send', 'middle')])
E(f'M{C4X-2},{pos["sec"][0]+45} L1082,{pos["sec"][0]+45}', [(1115, pos["sec"][0]+37, 'read', 'middle')])
E(f'M1080,{pos["cw"][0]+40} L{C4X-2},{pos["cw"][0]+40}', [(1115, pos["cw"][0]+32, 'logs', 'middle')])
E(f'M1260,{pos["cw"][0]+pos["cw"][1]} L1260,{pos["sns"][0]-2}')
E(f'M1080,{pos["bedrock"][0]+35} L{C4X-2},{pos["bedrock"][0]+35}', [(1115, pos["bedrock"][0]+27, 'parse', 'middle')])
E(f'M1080,{pos["location"][0]+35} L{C4X-2},{pos["location"][0]+35}', [(1115, pos["location"][0]+27, 'look up', 'middle')])
E(f'M1080,{pos["s3"][0]+55} L{C4X-2},{pos["s3"][0]+55}', [(1115, pos["s3"][0]+47, 'SDK', 'middle')], both=True)
for key, lab, both in [('stripe', 'Checkout · webhooks', True)]:
    gy = gaps[key]
    E(f'M1080,{gy} L{C5X-2},{gy}', [(1260, gy - 7, lab, 'middle')], both=both)
E(f'M{C5X},{s3y+45} L1402,{s3y+45}', [(1418, s3y+37, 'OIDC', 'middle')], cls='dashed')
E(f'M390,470 L390,1353 L1260,1353 L1260,{s3y+pos["s3"][1]+2}', [(760, 1347, 'Presigned PUT / GET · bill photo', 'middle')])

svg = '\n'.join(zones + edges + nodes)
VB_H = 1373

page = (HERE / 'system.template.html').read_text()
page = page.replace('%%SVG%%', svg).replace('%%VBH%%', str(VB_H)).replace('%%EPS%%', str(COUNTS['eps'])).replace('%%GROUPS%%', str(COUNTS['groups']))
HEAD = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n')
page = HEAD + page.replace('<div class="wrap">', '</head>\n<body>\n<div class="wrap">', 1) + '</body>\n</html>\n'
(HERE.parent / 'system.html').write_text(page)
