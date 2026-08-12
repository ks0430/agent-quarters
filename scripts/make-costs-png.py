#!/usr/bin/env python3
"""Render the AgentQuarters cost & pricing sheet to a PNG."""
from PIL import Image, ImageDraw, ImageFont

W, H, S = 1680, 1215, 2
img = Image.new("RGB", (W * S, H * S), "#f7f9fc")
d = ImageDraw.Draw(img)

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def f(sz, bold=False): return ImageFont.truetype(FB if bold else F, sz * S)

TITLE, SUB, ZONE, BOX, BIG, SMALL, TINY = f(34, True), f(17), f(19, True), f(16, True), f(26, True), f(14), f(13)
INK, MUTED = "#1b2430", "#5b6b7f"
RED, GREEN, BLUE, ORANGE, PURPLE = "#dc2626", "#18926b", "#2f6fed", "#d97706", "#7c4dcc"

def rr(x, y, w, h, fill, outline, width=2, radius=14):
    d.rounded_rectangle([x*S, y*S, (x+w)*S, (y+h)*S], radius=radius*S, fill=fill, outline=outline, width=width*S)
def txt(x, y, s, font, fill=INK, anchor="la"):
    d.text((x*S, y*S), s, font=font, fill=fill, anchor=anchor)
def line(x1, y1, x2, y2, color, w=1):
    d.line([x1*S, y1*S, x2*S, y2*S], fill=color, width=w*S)

txt(60, 44, "AgentQuarters — What it costs, what we charge", TITLE)
txt(60, 90, "Per customer server, per month. AWS bills us by the hour; we bill customers by the hour too.", SUB, MUTED)

# ---------- A: what AWS charges us ----------
rr(60, 145, 500, 455, "#ffffff", "#f0c4c4")
txt(82, 165, "WHAT WE PAY AWS", ZONE, RED)
txt(82, 192, "per customer server", SMALL, MUTED)

rows_cost = [
    ("Server running (2 GB Lightsail)", "$12.00", "/mo", "$0.39/day · billed hourly"),
    ("Server paused → snapshot only", "$0.30", "/mo", "~6 GB used × $0.05/GB"),
    ("Static IP — while attached", "$0.00", "", "free on a running server"),
    ("Static IP — while parked (paused)", "$3.60", "/mo", "$0.005/hr for a reserved IP"),
    ("Database backups (S3)", "< $0.05", "/mo", "48 × ~40 KB snapshots"),
]
y = 225
for name, amt, unit, note in rows_cost:
    txt(82, y, name, BOX)
    txt(534, y, amt, BOX, RED, anchor="ra")
    txt(536, y + 3, unit, TINY, MUTED)
    txt(82, y + 22, note, TINY, MUTED)
    y += 56
    if y < 500: line(82, y - 12, 538, y - 12, "#eef2f7")

rr(82, 535, 456, 46, "#fff5f5", "#f0c4c4")
txt(100, 549, "Typical: one always-on server costs us", SMALL)
txt(520, 548, "$12/mo", BOX, RED, anchor="ra")

# ---------- B: what we charge ----------
rr(590, 145, 500, 455, "#ffffff", "#c9e5d8")
txt(612, 165, "WHAT WE CHARGE", ZONE, GREEN)
txt(612, 192, "prepaid credits, metered hourly", SMALL, MUTED)

rows_price = [
    ("Server running", "$18.25", "/mo", "2.5¢/hour = $0.60/day"),
    ("Server paused", "$1.02", "/mo", "0.14¢/hour — keeps everything"),
    ("Static IP add-on", "$2.04", "/mo", "0.28¢/hour, running or paused"),
    ("Multi plan (optional)", "$9.00", "/mo", "subscription: up to 5 servers"),
    ("The AI itself", "$0.00", "", "customer's own Claude/ChatGPT plan"),
]
y = 225
for name, amt, unit, note in rows_price:
    txt(612, y, name, BOX)
    txt(1064, y, amt, BOX, GREEN, anchor="ra")
    txt(1066, y + 3, unit, TINY, MUTED)
    txt(612, y + 22, note, TINY, MUTED)
    y += 56
    if y < 500: line(612, y - 12, 1068, y - 12, "#eef2f7")

rr(612, 535, 456, 46, "#f2fbf7", "#c9e5d8")
txt(630, 549, "Typical: one always-on server earns", SMALL)
txt(1050, 548, "$18.25/mo", BOX, GREEN, anchor="ra")

# ---------- C: margin ----------
rr(1120, 145, 500, 455, "#ffffff", "#d6dfeb")
txt(1142, 165, "WHAT WE KEEP", ZONE, BLUE)
txt(1142, 192, "gross margin per server", SMALL, MUTED)

def bar(y, label, revenue, cost, profit, color):
    """Bar spans the larger of revenue/cost; red = our cost, green = what we keep."""
    txt(1142, y, label, BOX)
    x0, wfull = 1142, 440
    span = max(revenue, cost)
    px = lambda v: x0 + wfull * v / span
    if profit >= 0:
        d.rectangle([x0*S, (y+26)*S, px(cost)*S, (y+50)*S], fill="#f4b4b4")
        d.rectangle([px(cost)*S, (y+26)*S, px(revenue)*S, (y+50)*S], fill=color)
        txt(1142, y + 56, f"cost ${cost:.2f}", TINY, "#8a2b2b")
        txt(x0 + wfull, y + 56, f"we keep ${profit:.2f}", TINY, GREEN, anchor="ra")
    else:
        d.rectangle([x0*S, (y+26)*S, px(revenue)*S, (y+50)*S], fill="#f4b4b4")
        d.rectangle([px(revenue)*S, (y+26)*S, px(cost)*S, (y+50)*S], fill=color)
        txt(1142, y + 56, f"they pay ${revenue:.2f}", TINY, "#8a2b2b")
        txt(x0 + wfull, y + 56, f"we lose ${abs(profit):.2f}", TINY, RED, anchor="ra")

bar(228, "Server running all month", 18.25, 12.00, 6.25, GREEN)
bar(330, "Server paused all month", 1.02, 0.30, 0.72, GREEN)
bar(432, "Paused + static IP (we lose)", 3.06, 3.90, -0.84, "#f0a3a3")
txt(1142, 512, "Rare case: a long-paused server keeping a static IP.", TINY, MUTED)

rr(1142, 535, 456, 46, "#eef4ff", "#c9d9f7")
txt(1160, 549, "Margin on a normal running server", SMALL)
txt(1580, 548, "~34%", BOX, BLUE, anchor="ra")

# ---------- D: real examples ----------
rr(60, 630, 1560, 250, "#ffffff", "#d6dfeb")
txt(82, 650, "Real examples", ZONE, INK)

examples = [
    ("Heavy user", "Runs one agent 24/7 all month",
     [("They pay", "$18.25", GREEN), ("AWS costs us", "$12.00", RED), ("We keep", "$6.25", BLUE)]),
    ("Typical user", "Works 10 days, pauses the other 20",
     [("They pay", "$6.68", GREEN), ("AWS costs us", "$4.15", RED), ("We keep", "$2.53", BLUE)]),
    ("Trying it out", "Deploys, plays for 2 hours, deletes",
     [("They pay", "$0.05", GREEN), ("AWS costs us", "$0.03", RED), ("We keep", "$0.02", BLUE)]),
    ("50 customers", "Mostly always-on servers",
     [("They pay", "$912", GREEN), ("AWS + hosting", "$607", RED), ("We keep", "$305", BLUE)]),
]
x = 88
for name, desc, lines in examples:
    rr(x, 680, 360, 180, "#fbfcfe", "#e3e9f2")
    txt(x + 20, 696, name, BOX)
    txt(x + 20, 720, desc, TINY, MUTED)
    yy = 752
    for lbl, val, col in lines:
        txt(x + 20, yy, lbl, SMALL, MUTED)
        txt(x + 340, yy, val, BOX, col, anchor="ra")
        yy += 30
    x += 383

# ---------- E: fixed costs + notes ----------
rr(60, 910, 760, 250, "#ffffff", "#d6dfeb")
txt(82, 930, "Fixed costs (regardless of customers)", ZONE, PURPLE)
fixed = [
    ("Control plane hosting (Render Starter + disk)", "$7.25/mo"),
    ("Database backups to S3", "< $0.05/mo"),
    ("Stripe fees", "2.9% + 30¢ per top-up"),
    ("Domain (when you add one)", "~$1/mo"),
]
y = 965
for name, amt in fixed:
    txt(100, y, name, SMALL)
    txt(795, y, amt, BOX, PURPLE, anchor="ra")
    y += 38
rr(100, 1105, 690, 40, "#f5f0ff", "#ddd0f5")
txt(118, 1117, "Break-even: about 2 always-on customers covers all fixed costs.", SMALL)

rr(850, 910, 770, 250, "#ffffff", "#d6dfeb")
txt(872, 930, "Worth knowing", ZONE, ORANGE)
notes = [
    "We never pay for the AI. Customers bring their own Claude or ChatGPT plan,",
    "so our cost per server is fixed and predictable — no token surprises.",
    "",
    "Pausing helps both sides: the customer pays ~$1 instead of ~$18, and our",
    "cost drops from $12 to $0.30. Margin stays positive either way.",
    "",
    "Biggest future lever: the same product on Hetzner costs ~$3–4/server",
    "instead of $12 — margin would jump from ~34% to ~80% at the same price.",
]
y = 963
for n in notes:
    txt(872, y, n, SMALL, MUTED if n else MUTED)
    y += 24

txt(60, 1180, "Figures from the live billing configuration · AWS Lightsail small_3_0, us-east-1", SMALL, MUTED)

img.resize((W, H), Image.LANCZOS).save("/home/ubuntu/code/agentdeploy/docs/costs.png")
print("saved docs/costs.png")
