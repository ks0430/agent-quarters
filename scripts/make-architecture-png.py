#!/usr/bin/env python3
"""Render the AgentQuarters architecture diagram to a PNG.

No emoji: the bundled fonts have no colour-emoji glyphs, so accents are drawn
as simple shapes instead (they render identically everywhere).
"""
import math
from PIL import Image, ImageDraw, ImageFont

W, H, S = 1680, 1230, 2  # S = supersample for crisp text
img = Image.new("RGB", (W * S, H * S), "#f7f9fc")
d = ImageDraw.Draw(img)

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def f(sz, bold=False): return ImageFont.truetype(FB if bold else F, sz * S)

TITLE, SUB, ZONE, BOX, SMALL, TINY = f(34, True), f(17), f(19, True), f(17, True), f(14), f(13)
INK, MUTED = "#1b2430", "#5b6b7f"
BLUE, GREEN, PURPLE, ORANGE, RED, GREY = "#2f6fed", "#18926b", "#7c4dcc", "#d97706", "#dc2626", "#c3cede"

def rr(x, y, w, h, fill, outline, width=2, radius=14):
    d.rounded_rectangle([x*S, y*S, (x+w)*S, (y+h)*S], radius=radius*S,
                        fill=fill, outline=outline, width=width*S)

def txt(x, y, s, font, fill=INK, anchor="la"):
    d.text((x*S, y*S), s, font=font, fill=fill, anchor=anchor)

def dot(x, y, color, r=6):
    d.ellipse([(x-r)*S, (y-r)*S, (x+r)*S, (y+r)*S], fill=color)

def head(x, y, ang, color, L=13, spread=0.42):
    d.polygon([(x*S, y*S),
               ((x-L*math.cos(ang-spread))*S, (y-L*math.sin(ang-spread))*S),
               ((x-L*math.cos(ang+spread))*S, (y-L*math.sin(ang+spread))*S)], fill=color)

def label(mx, my, text, color):
    bb = d.textbbox((0,0), text, font=TINY); tw, th = bb[2]-bb[0], bb[3]-bb[1]
    d.rectangle([mx*S-tw/2-6*S, my*S-th/2-5*S, mx*S+tw/2+6*S, my*S+th/2+6*S], fill="#f7f9fc")
    d.text((mx*S, my*S), text, font=TINY, fill=color, anchor="mm")

def arrow(x1, y1, x2, y2, color, text=None, lw=3, lx=None, ly=None):
    d.line([x1*S, y1*S, x2*S, y2*S], fill=color, width=lw*S)
    head(x2, y2, math.atan2(y2-y1, x2-x1), color)
    if text: label(lx if lx is not None else (x1+x2)/2, ly if ly is not None else (y1+y2)/2, text, color)

def path(points, color, text=None, lw=3, lx=None, ly=None, dashed=False):
    """Orthogonal multi-point route with an arrowhead at the end."""
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        if dashed:
            dist = math.hypot(bx-ax, by-ay); steps = max(int(dist/11), 1)
            for i in range(steps):
                if i % 2: continue
                t1, t2 = i/steps, min((i+1)/steps, 1)
                d.line([(ax+(bx-ax)*t1)*S, (ay+(by-ay)*t1)*S,
                        (ax+(bx-ax)*t2)*S, (ay+(by-ay)*t2)*S], fill=color, width=lw*S)
        else:
            d.line([ax*S, ay*S, bx*S, by*S], fill=color, width=lw*S)
    (px, py), (qx, qy) = points[-2], points[-1]
    head(qx, qy, math.atan2(qy-py, qx-px), color)
    if text and lx is not None: label(lx, ly, text, color)

# ---------------- header ----------------
txt(60, 44, "AgentQuarters — How it works", TITLE)
txt(60, 90, "Deploy an always-on AI coding agent to your own cloud server, and talk to it from chat or code.", SUB, MUTED)

# ---------------- zone 1: users ----------------
rr(60, 150, 330, 470, "#ffffff", "#d6dfeb")
txt(80, 168, "1 · YOU & YOUR TEAM", ZONE, BLUE)

rr(85, 205, 280, 92, "#eef4ff", BLUE); dot(103, 228, BLUE)
txt(118, 220, "Dashboard (browser)", BOX)
txt(105, 250, "Deploy servers, set up agents,", SMALL, MUTED)
txt(105, 271, "add secrets, view costs", SMALL, MUTED)

rr(85, 315, 280, 92, "#eef4ff", BLUE); dot(103, 338, BLUE)
txt(118, 330, "Slack / Telegram", BOX)
txt(105, 360, "Chat with your agent from", SMALL, MUTED)
txt(105, 381, "your phone or desktop", SMALL, MUTED)

rr(85, 425, 280, 92, "#eef4ff", BLUE); dot(103, 448, BLUE)
txt(118, 440, "Your code / CI", BOX)
txt(105, 470, "POST /v1/agents/…/messages", f(13), MUTED)
txt(105, 491, "with an API key", SMALL, MUTED)

txt(100, 543, "No VPN. No open ports.", SMALL, GREEN)
txt(100, 565, "Your laptop can be closed.", SMALL, GREEN)

# ---------------- zone 2: control plane ----------------
rr(450, 150, 380, 620, "#ffffff", "#d6dfeb")
txt(470, 168, "2 · CONTROL PLANE", ZONE, PURPLE)
txt(470, 194, "(our web app, hosted on Render)", SMALL, MUTED)

rr(472, 225, 336, 78, "#f5f0ff", PURPLE); dot(492, 247, PURPLE)
txt(508, 239, "Web dashboard + APIs", BOX)
txt(492, 270, "Accounts, deploys, agent config", SMALL, MUTED)

rr(472, 315, 336, 92, "#f5f0ff", PURPLE); dot(492, 337, PURPLE)
txt(508, 329, "Database (SQLite)", BOX)
txt(492, 360, "Users, servers, credits, settings —", SMALL, MUTED)
txt(492, 381, "all secrets encrypted", SMALL, MUTED)

rr(472, 419, 336, 78, "#f5f0ff", PURPLE); dot(492, 441, PURPLE)
txt(508, 433, "Billing (Stripe)", BOX)
txt(492, 464, "Prepaid credits, hourly metering", SMALL, MUTED)

rr(472, 509, 336, 78, "#f5f0ff", PURPLE); dot(492, 531, PURPLE)
txt(508, 523, "Job queue", BOX)
txt(492, 554, "Instructions waiting for servers", SMALL, MUTED)

rr(472, 599, 336, 70, "#eefaf4", GREEN); dot(492, 621, GREEN)
txt(508, 613, "Hourly backups → S3", BOX)
txt(492, 644, "Database snapshot, keeps 48", SMALL, MUTED)

rr(472, 681, 336, 70, "#fff7ec", ORANGE); dot(492, 703, ORANGE)
txt(508, 695, "AWS Lightsail API", BOX)
txt(492, 726, "Create / pause / delete servers", SMALL, MUTED)

# ---------------- zone 3: customer server ----------------
rr(890, 150, 500, 620, "#ffffff", "#d6dfeb")
txt(910, 168, "3 · YOUR PRIVATE SERVER", ZONE, ORANGE)
txt(910, 194, "(one AWS Lightsail VM — 2 GB RAM, ~$12/mo)", SMALL, MUTED)

rr(912, 225, 456, 104, "#fff7ec", ORANGE); dot(932, 247, ORANGE)
txt(948, 239, "Host agent", BOX)
txt(932, 270, "Runs the server: starts/stops the agent,", SMALL, MUTED)
txt(932, 291, "reports status, updates itself automatically.", SMALL, MUTED)
txt(932, 310, "Calls out to us every 5s — we never call in.", TINY, GREEN)

rr(912, 350, 456, 300, "#fdfaf5", "#c98f2e", 3)
dot(932, 372, "#a9741f")
txt(948, 364, "Agent container (isolated)", BOX, "#a9741f")
txt(932, 393, "1 GB RAM · 1.5 CPU cap · its own private space", SMALL, MUTED)

rr(934, 420, 412, 74, "#ffffff", "#d6dfeb")
txt(954, 435, "cc-connect", BOX)
txt(954, 461, "Bridges chat + API into the agent", SMALL, MUTED)

rr(934, 508, 412, 74, "#ffffff", "#d6dfeb")
txt(954, 523, "Claude Code  /  Codex CLI", BOX)
txt(954, 549, "The actual AI agent doing the work", SMALL, MUTED)

rr(934, 596, 412, 42, "#ffffff", "#d6dfeb")
txt(954, 608, "Workspace + login + your secrets (persistent)", SMALL)

txt(912, 672, "Everything survives restarts. Pause the server and it", SMALL, MUTED)
txt(912, 694, "snapshots to ~$1/mo — resume with memory intact.", SMALL, MUTED)

# ---------------- zone 4: outside ----------------
rr(1450, 150, 170, 620, "#ffffff", "#d6dfeb")
txt(1468, 168, "4 · OUTSIDE", ZONE, GREEN)

rr(1466, 210, 138, 118, "#eefaf4", GREEN)
txt(1484, 228, "Anthropic", BOX)
txt(1484, 253, "/ OpenAI", BOX)
txt(1484, 285, "Runs on your", TINY, MUTED)
txt(1484, 303, "Claude/ChatGPT plan", TINY, MUTED)

rr(1466, 350, 138, 100, "#eefaf4", GREEN)
txt(1484, 368, "Slack /", BOX)
txt(1484, 393, "Telegram", BOX)
txt(1484, 423, "Message delivery", TINY, MUTED)

rr(1466, 472, 138, 100, "#fff1f1", RED)
txt(1484, 490, "GitHub,", BOX)
txt(1484, 515, "your APIs", BOX)
txt(1484, 545, "The agent's tools", TINY, MUTED)

# ---------------- arrows ----------------
arrow(365, 250, 468, 255, BLUE, "HTTPS", lx=416, ly=236)
path([(365, 470), (420, 470), (420, 262), (468, 262)], BLUE, "API key", lx=420, ly=380)
path([(700, 753), (700, 790), (1140, 790), (1140, 655)], ORANGE, "creates your server", lx=920, ly=772)
arrow(930, 268, 810, 545, GREEN, "polls out for jobs", lx=845, ly=380)
arrow(700, 671, 700, 679, GREEN, None, lw=2)   # queue -> (visual tie)
path([(808, 634), (860, 634), (860, 700)], GREEN, "backup", lx=845, ly=616)
arrow(1370, 455, 1462, 300, PURPLE, "model calls", lx=1432, ly=360)
arrow(1370, 480, 1462, 420, PURPLE, "chat", lx=1400, ly=470)
arrow(1370, 610, 1462, 530, RED, None)
# chat round-trip back to the person
path([(1466, 400), (1430, 400), (1430, 828), (225, 828), (225, 410)], BLUE,
     "your messages travel via Slack / Telegram", lx=800, ly=812, dashed=True)

# ---------------- footer notes ----------------
rr(60, 850, 1560, 130, "#ffffff", "#d6dfeb")
txt(85, 868, "Why it's built this way", BOX, INK)
notes = [
 "Your server never accepts incoming connections — it only calls out to us. Nothing exposed to attack.",
 "The agent keeps its memory, files and login between chats — unlike cloud agents that reset every task.",
 "You pay by the hour (~$0.60/day). Pause it and it drops to ~$1/month with everything preserved.",
 "Secrets are encrypted in our database and injected straight into the agent — never pasted into chat.",
]
y = 900
for note in notes:
    dot(95, y + 7, GREEN, 4)
    txt(112, y, note, SMALL, MUTED)
    y += 21

# ---------------- journey ----------------
rr(60, 1000, 1560, 170, "#ffffff", "#d6dfeb")
txt(85, 1018, "The journey, end to end", BOX, INK)
steps = [
 ("1", "Deploy", "Pick a region.\nWe create your server."),
 ("2", "Set up", "Choose Claude Code\nor Codex."),
 ("3", "Sign in", "Use your Claude /\nChatGPT subscription."),
 ("4", "Connect", "Add Slack or Telegram\n(or use the API)."),
 ("5", "Work", "Message it anytime.\nIt remembers."),
 ("6", "Pause", "Not using it? Pause\nto ~$1/month."),
]
x = 90
for num, hd, body in steps:
    d.ellipse([x*S, 1050*S, (x+30)*S, 1080*S], fill=BLUE)
    txt(x+15, 1065, num, f(15, True), "#ffffff", anchor="mm")
    txt(x+40, 1052, hd, BOX)
    for i, line in enumerate(body.split("\n")):
        txt(x+40, 1078 + i*19, line, TINY, MUTED)
    if num != "6":
        arrow(x+215, 1065, x+245, 1065, GREY, None, lw=2)
    x += 255

txt(60, 1192, "agentdeploy-nino.onrender.com", SMALL, MUTED)

img.resize((W, H), Image.LANCZOS).save("/home/ubuntu/code/agentdeploy/docs/architecture.png")
print("saved docs/architecture.png")
