#!/usr/bin/env python3
"""
reel_render_v6.py — RETENTION EDITION (council-approved upgrade of v5)
Implements: C2 tiktok captions, B1 pattern interrupts, B2 whip transitions,
B3 numpy SFX, B4 ducked music bed, C1 pro fonts, C3 shadows+gradient numbers,
A1 asymmetric stat layout, A3 media pop+shadow, D1 static bg cache, D2 grain,
E2 counter overshoot + landing flash.
CLI: python3 reel_render_v6.py '<json job>'          (reel.js contract)
     python3 reel_render_v6.py --beats b --stats s --style st --out o [--layout-check]
"""
import argparse, json, math, os, random, re, shutil, subprocess, sys, time, hashlib, urllib.request, wave
import numpy as np
from PIL import ImageChops
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if "__file__" in dir() else ".")
from reel_templates import scene_coords, TemplateError  # noqa: E402

W, H, FPS = 1080, 1920, 30
SR = 44100
# ───── v7: template-driven style globals (resolved by reel_templates.py) ─────
TRANS_FRAMES = 12
TRANS_TYPE = "whip"
BG, BG2   = (10, 12, 20), (16, 19, 32)
WHITE     = (245, 245, 250)
DIM, DIM2 = (120, 125, 140), (85, 90, 108)
RED       = (255, 90, 90)
CARD      = (22, 26, 42)
ACCENT_TUPLE = (76, 220, 156)
MONO_F = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
SPR_SOFT, SPR_BOUNCY = (8.3, 9.0), (14.0, 22.0)
ENTRANCE, STAGGER_S = "slide", 0.06
SHIMMER_TARGET, SHIMMER_DUR = "logo", 2.0
COUNTER_FN = "spring_soft"
BED_BPM, BED_GAIN = 88, 0.26
GRADE_C, GRADE_S = 1.06, 1.12
LN_I, LN_TP, LN_LRA = -14, -1.5, 11
CAP_MAXW, CAP_MAXCHARS, CAP_MINDISP, CAP_TAIL, CAP_YOFF = 4, 21, 0.5, 0.3, 344
SAFE_YMAX, VIG, GRAIN_AMP = 0.81, 1.0, 6
SPEC = None
PERSONA_ACCENTS = None

def apply_spec(S):
    """council law: the ONLY place raw template values enter the engine."""
    global TRANS_FRAMES, TRANS_TYPE, BG, BG2, WHITE, DIM, DIM2, RED, CARD, ACCENT_TUPLE
    global SPR_SOFT, SPR_BOUNCY, ENTRANCE, STAGGER_S, SHIMMER_TARGET, SHIMMER_DUR
    global COUNTER_FN, BED_BPM, BED_GAIN, GRADE_C, GRADE_S, LN_I, LN_TP, LN_LRA
    global CAP_MAXW, CAP_MAXCHARS, CAP_MINDISP, CAP_TAIL, CAP_YOFF, SAFE_YMAX
    global VIG, GRAIN_AMP, SPEC, MONO_F, PERSONA_ACCENTS
    SPEC = S
    p, m = S["palette"], S["motion"]
    BG, BG2 = p["bg0"], p["bg1"]
    WHITE, DIM, DIM2 = p["white"], p["dim"], p["dim2"]
    RED, CARD, ACCENT_TUPLE = p["red"], p["card"], p["accent"]
    TRANS_FRAMES = int(m["transition"]["frames"]); TRANS_TYPE = m["transition"]["type"]
    SPR_SOFT, SPR_BOUNCY = m["springs"]["soft"], m["springs"]["bouncy"]
    ENTRANCE, STAGGER_S = m["entrance"], m["stagger_s"]
    SHIMMER_TARGET, SHIMMER_DUR = m["shimmer"]["target"], m["shimmer"]["dur"]
    COUNTER_FN = m["counter"]
    BED_BPM, BED_GAIN = float(S["audio"]["bed"]["bpm"]), float(S["audio"]["bed"]["gain"])
    GRADE_C = float(S["effects"]["grade"]["contrast"])
    GRADE_S = float(S["effects"]["grade"]["saturation"])
    ln = S["audio"]["loudness"]
    LN_I, LN_TP, LN_LRA = float(ln["i"]), float(ln["tp"]), float(ln["lra"])
    c = S["pacing"]["captions"]
    CAP_MAXW, CAP_MAXCHARS = int(c["max_words"]), int(c["max_chars"])
    CAP_MINDISP, CAP_TAIL, CAP_YOFF = float(c["min_display_s"]), float(c["tail_s"]), int(c["y_off"])
    SAFE_YMAX = float(S["pacing"]["safe"]["y_max"])
    VIG, GRAIN_AMP = float(p.get("vignette", 1.0)), int(p.get("grain", 6))
    MONO_F = S["fonts"]["mono"]
    PERSONA_ACCENTS = S["persona_accents"]
    FONTS["display"] = S["fonts"]["display"]; FONTS["heavy"] = S["fonts"]["heavy"]
    FONTS["bold"] = S["fonts"]["body"]; FONTS["semi"] = S["fonts"]["body"]
    FONTS["med"] = S["fonts"]["med"]

def _mix(a, b, f):
    return tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3))

def _outline(c, d=28):
    return tuple(min(255, v + d) for v in c)

LAYOUT_BAG = []
LAYOUT_CHECK = False

# ───────── fonts (C1) ─────────
FONT_DIR = os.environ.get("REEL_FONT_DIR", "/opt/whatsapp/fonts")
FONT_URLS = {
    "BebasNeue":       "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf",
    "ArchivoBlack":    "https://github.com/google/fonts/raw/main/ofl/archivoblack/ArchivoBlack-Regular.ttf",
    "Poppins-Bold":    "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf",
    "Poppins-SemiBold":"https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf",
    "Poppins-Medium":  "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Medium.ttf",
}
def ensure_fonts():
    os.makedirs(FONT_DIR, exist_ok=True)
    ok = {}
    for name, url in FONT_URLS.items():
        p = os.path.join(FONT_DIR, name + ".ttf")
        if not (os.path.exists(p) and os.path.getsize(p) > 10000):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=15) as r, open(p, "wb") as f:
                    f.write(r.read())
            except Exception as e:
                print("font dl fail:", name, str(e)[:60]); continue
        ok[name] = p
    return ok

FONTS = {}
def _load_fonts():
    got = ensure_fonts()
    FONTS["display"] = got.get("BebasNeue", MONO_F)
    FONTS["heavy"]   = got.get("ArchivoBlack", got.get("BebasNeue", MONO_F))
    FONTS["bold"]    = got.get("Poppins-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    FONTS["semi"]    = got.get("Poppins-SemiBold", FONTS["bold"])
    FONTS["med"]     = got.get("Poppins-Medium", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")

def font(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception: return ImageFont.load_default()

def register(name, x0, y0, x1, y1):
    if LAYOUT_CHECK: LAYOUT_BAG.append((name, x0, y0, x1, y1))

def layout_check_report():
    bad = []
    for i in range(len(LAYOUT_BAG)):
        for j in range(i + 1, len(LAYOUT_BAG)):
            n1, a0, a1, a2, a3 = LAYOUT_BAG[i]
            n2, b0, b1, b2, b3 = LAYOUT_BAG[j]
            if a0 < b2 and b0 < a2 and a1 < b3 and b1 < a3:
                bad.append(f"OVERLAP {n1}({a0},{a1},{a2},{a3}) x {n2}({b0},{b1},{b2},{b3})")
    for n, a0, a1, a2, a3 in LAYOUT_BAG:
        if a0 < 0 or a1 < 0 or a2 > W or a3 > H:
            bad.append(f"OUT-OF-CANVAS {n}({a0},{a1},{a2},{a3})")
    return bad

def ease_out(t): return 1 - (1 - t) ** 3
def ease_in(t): return t * t

def spring(t, damp=None, speed=None):
    damp = SPR_BOUNCY[0] if damp is None else damp
    speed = SPR_BOUNCY[1] if speed is None else speed
    if t <= 0: return 0.0
    if t >= 1: return 1.0
    return 1.0 - math.exp(-speed * t) * math.cos(damp * t)

def spring_soft(t):
    return spring(t, *SPR_SOFT)

def spring_bouncy(t):
    return spring(t, *SPR_BOUNCY)

def counter_spring(t):
    return spring_soft(t) if COUNTER_FN == "spring_soft" else spring_bouncy(t)

def clamp(v, a, b): return max(a, min(b, v))
def text_w(fnt, s): return fnt.getbbox(s)[2] - fnt.getbbox(s)[0]

def cover_crop(img, tw, th):
    iw, ih = img.size
    scale = max(tw / iw, th / ih)
    img = img.resize((max(1, int(iw * scale)), max(1, int(ih * scale))), Image.LANCZOS)
    x = (img.width - tw) // 2; y = (img.height - th) // 2
    return img.crop((x, y, x + tw, y + th))

# ───────── media layer ─────────
MEDIA_CACHE = "/tmp/reel_media_v5"
os.makedirs(MEDIA_CACHE, exist_ok=True)

def fetch_media(url):
    if not url: return None
    if "pbs.twimg.com" in url and "?" not in url: url += "?name=small"
    h = hashlib.md5(url.encode()).hexdigest()[:16]
    p = os.path.join(MEDIA_CACHE, h + ".img")
    if os.path.exists(p) and os.path.getsize(p) > 1000: return p
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://x.com/"})
        with urllib.request.urlopen(req, timeout=10) as r, open(p, "wb") as f:
            f.write(r.read())
        return p if os.path.getsize(p) > 1000 else None
    except Exception as e:
        print("media fetch failed:", str(e)[:80]); return None

def gradient_mesh(seed, w, h):
    rng = random.Random(seed)
    base = Image.new("RGB", (max(1, w // 4), max(1, h // 4)), BG)
    d = ImageDraw.Draw(base)
    for _ in range(5):
        cx, cy = rng.randint(0, base.width - 1), rng.randint(0, base.height - 1)
        r = rng.randint(60, 160)
        col = (BG2[0] + rng.randint(6, 26), BG2[1] + rng.randint(6, 26), BG2[2] + rng.randint(14, 44))
        for rad in range(r, 0, -4):
            a = 8 * (1 - rad / r)
            d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad),
                      fill=tuple(min(255, int(c + a)) for c in col))
    return base.resize((max(1, w), max(1, h)), Image.BICUBIC).filter(ImageFilter.GaussianBlur(10))

def apply_vignette(img):
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((-140, -290, W + 140, H + 290), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(180))
    dark = Image.new("RGB", (W, H), BG)
    floor = 255 - int(100 * clamp(VIG, 0, 1))
    return Image.composite(img, dark, m.point(lambda p: floor + p * (255 - floor) // 255))

# ───────── D1+D2: static background cache, rotating grain ─────────
GRAINS = None
def get_grains(rng_seed):
    global GRAINS
    if GRAINS is None:
        rng = np.random.default_rng(rng_seed)
        GRAINS = [rng.integers(-GRAIN_AMP, GRAIN_AMP + 1, (H, W, 3), dtype=np.int16) for _ in range(3)]
    return GRAINS

def build_static_bgs(sc_idx, sc, style, rng_seed):
    _pf = SPEC.get("palette", {}) if isinstance(SPEC, dict) else {}
    if SPEC.get("flat_bg"):
        _v0 = _pf.get("bg0", "20,20,26")
        _rgb = tuple(_v0) if isinstance(_v0, (tuple, list)) else tuple(int(c) for c in str(_v0).split(","))
        base = Image.new("RGB", (W, H), _rgb)
        _d = ImageDraw.Draw(base)
        _df = font(MONO_F, 30)
        _d.text((64, 56), sc.get("date_label", "VAULT REEL"), font=_df, fill=DIM)
        _d.text((W - 64 - text_w(_df, "OMNICLAW"), 56), "OMNICLAW", font=_df, fill=(60, 66, 86))
        if SPEC.get("collage"):
            _rr = random.Random(97 + sc_idx * 31)
            _ink = tuple(_pf["white"]) if isinstance(_pf.get("white"), (tuple, list)) else tuple(int(c) for c in str(_pf.get("white", "24,22,20")).split(","))
            for _hx, _hy, _hr in ((_rr.randint(60, 200), _rr.randint(1420, 1680), 130),
                                  (_rr.randint(720, 950), _rr.randint(200, 420), 110)):
                for _gy in range(-_hr, _hr, 16):
                    for _gx in range(-_hr, _hr, 16):
                        if _gx * _gx + _gy * _gy <= _hr * _hr and (_gx // 16 + _gy // 16) % 2 == 0:
                            _d.ellipse((_hx + _gx - 3, _hy + _gy - 3, _hx + _gx + 3, _hy + _gy + 3),
                                       fill=_mix(_rgb, _ink, 0.08))
            _acc = _mix(_rgb, (255, 255, 255), 0.6)
            _acc2 = _mix(_rgb, _ink, 0.22)
            _ax, _ay = _rr.randint(80, 900), _rr.randint(120, 1660)
            _d.polygon([(_ax, _ay), (_ax + 54, _ay + 18), (_ax + 16, _ay + 62)], fill=_acc)
            _bx, _by = _rr.randint(80, 900), _rr.randint(120, 1660)
            _d.ellipse((_bx, _by, _bx + 46, _by + 46), outline=_acc2, width=5)
            _zx, _zy = _rr.randint(80, 840), _rr.randint(120, 1640)
            _d.line([(_zx + i * 26, _zy + (0 if i % 2 == 0 else 16)) for i in range(8)], fill=_acc2, width=6)
            _tp = Image.new("RGBA", (150, 44), (250, 240, 205, 105))
            _tp = _tp.rotate(_rr.randint(-24, 24), expand=True)
            base.paste(_tp, (_rr.randint(60, 880), _rr.randint(120, 1660)), _tp)
            try:
                _Lh = scene_coords(SPEC, sc["kind"], sc_idx)["headline"]
                _hy2, _hs2 = _Lh["y"], _Lh["size"]
                _by0, _by1 = _hy2 - 18, _hy2 + int(_hs2 * 1.18)
                _cv = _pf.get("card", "255,253,247")
                _paper = tuple(_cv) if isinstance(_cv, (tuple, list)) else tuple(int(c) for c in str(_cv).split(","))
                _top = [(58, _by0 + _rr.randint(-6, 6))] + [(x, _by0 + _rr.randint(-9, 9)) for x in range(94, W - 58, 60)]
                _bot = [(W - 58, _by1 + _rr.randint(-9, 9))] + [(x, _by1 + _rr.randint(-9, 9)) for x in range(W - 94, 58, -60)]
                _d.polygon([(x + 9, y + 9) for x, y in _top + _bot], fill=_mix(_paper, _ink, 0.35))
                _d.polygon(_top + _bot, fill=_paper)
            except Exception as _be:
                print("banner skip:", _be)
            if sc.get("kind") == "outro":
                _sv = _pf.get("red", "203,60,44")
                _svd = tuple(_sv) if isinstance(_sv, (tuple, list)) else tuple(int(c) for c in str(_sv).split(","))
                _sx, _sy = W - 268, 880
                _d.rounded_rectangle((_sx, _sy, _sx + 148, _sy + 148), 18, outline=_svd, width=7)
                _sf = font(FONTS["heavy"], 40)
                _d.text((_sx + 26, _sy + 26), "OMNI", font=_sf, fill=_svd)
                _d.text((_sx + 26, _sy + 76), "CLAW", font=_sf, fill=_svd)
                _d.ellipse((_sx + 122, _sy + 118, _sx + 138, _sy + 134), fill=_svd)
        _gs = get_grains(rng_seed)
        _arr = np.asarray(base, dtype=np.uint8)
        return [Image.fromarray(_arr.copy()) for _ in _gs]
    base = gradient_mesh(style.get("seed", 1) + sc_idx * 13, W, H)
    d = ImageDraw.Draw(base)
    df = font(MONO_F, 30)
    d.text((64, 56), sc.get("date_label", "VAULT REEL"), font=df, fill=DIM)
    d.text((W - 64 - text_w(df, "OMNICLAW"), 56), "OMNICLAW", font=df, fill=(60, 66, 86))
    base = apply_vignette(base)
    arr = np.asarray(base, dtype=np.int16)
    return [Image.fromarray(np.clip(arr + g, 0, 255).astype(np.uint8)) for g in get_grains(rng_seed)]

# ───────── shared elements ─────────
def _brutal():
    try: return (SPEC.get("cards") or {}).get("style") == "brutal"
    except Exception: return False

def draw_chip(draw, x, y, text, accent, icon=None, drop_t=1.0):
    fnt = font(FONTS["med"], 34)
    e = spring(clamp(drop_t / 0.45, 0, 1)) if drop_t < 1.0 else 1.0
    yy = y + int((1 - e) * 46)
    tw = text_w(fnt, text) + (46 if icon else 0)
    rr_box = (x, yy, x + tw + 44, yy + 58)
    if _brutal():
        draw.rectangle((x + 7, yy + 7, x + tw + 44 + 7, yy + 58 + 7), fill=(12, 12, 14))
        draw.rectangle(rr_box, fill=CARD, outline=(12, 12, 14), width=4)
    else:
        draw.rounded_rectangle(rr_box, 28, fill=CARD, outline=_outline(CARD), width=1)
    register("chip:" + text[:10], *rr_box)
    if icon == "heart":
        heart(draw, x + 42, yy + 30, 13, RED)
    elif icon == "rt":
        rt_arrow(draw, x + 42, yy + 30, 13, (90, 200, 250))
    draw.text((x + (68 if icon else 22), yy + 9), text, font=fnt, fill=WHITE)
    return x + tw + 62

def persona_badge(draw, persona, x=64, y=104):
    fnt = font(FONTS["med"], 30)
    label = persona["badge"]
    tw = text_w(fnt, label)
    box = (x, y, x + tw + 52, y + 52)
    draw.rounded_rectangle(box, 26, fill=BG, outline=persona["accent"], width=3)
    register("badge:" + persona["name"], *box)
    draw.ellipse((x + 16, y + 18, x + 36, y + 38), fill=persona["accent"])
    draw.text((x + 46, y + 9), label, font=fnt, fill=WHITE)

def progress_bar(draw, p, cur, total_ch):
    y = H - 26
    draw.rounded_rectangle((64, y, W - 64, y + 8), 4, fill=CARD)
    draw.rounded_rectangle((64, y, int(64 + (W - 128) * clamp(p, 0, 1)), y + 8), 4, fill=DIM)
    for i in range(total_ch):
        cx = int(64 + (W - 128) * (i + 0.5) / total_ch)
        col = WHITE if i == cur else DIM2
        r = 9 if i == cur else 6
        draw.ellipse((cx - r, y - 24 - r, cx + r, y - 24 + r), fill=col)

# ───────── C2: TikTok captions ─────────
def build_caption_groups(words):
    """OpenMontage subtitle-sync law: <=4 words/cue, >=0.5s display, +200ms tail."""
    groups, cur, last_end = [], [], None
    for w in words:
        gap = (w["start"] - last_end) if last_end is not None else 0.0
        if cur and (gap > 0.30 or len(cur) >= CAP_MAXW):
            groups.append(cur); cur = []
        cur.append(w); last_end = w["end"]
    if cur: groups.append(cur)
    out = [{"words": g, "start": g[0]["start"], "end": g[-1]["end"]} for g in groups]
    merged = []                              # min 0.5s display: merge flash cues
    for g in out:
        if merged and (g["end"] - g["start"]) < CAP_MINDISP and \
           len(merged[-1]["words"]) + len(g["words"]) <= CAP_MAXW + 1:
            merged[-1]["words"].extend(g["words"])
            merged[-1]["end"] = g["end"]
        else:
            merged.append(dict(g))
    return merged

def tiktok_captions(draw, groups, t_glob, accent):
    cg = None
    for g in groups:
        if g["start"] - 0.05 <= t_glob <= g["end"] + CAP_TAIL:
            cg = g; break
    if cg is None: return
    ws = cg["words"]
    line_chars = sum(len(w["word"].strip()) + 1 for w in ws)
    fsize = 62 if line_chars <= CAP_MAXCHARS else 54   # OpenMontage: <=20 chars/line on vertical
    fnt = font(FONTS["semi"], fsize)
    while sum(text_w(fnt, w["word"].strip() + " ") for w in ws) > W - 140 and fsize > 42:
        fsize -= 6; fnt = font(FONTS["semi"], fsize)
    fnt_big = font(FONTS["semi"], fsize + 14)
    widths = [text_w(fnt, w["word"].strip() + " ") for w in ws]
    total = sum(widths[:-1]) + text_w(fnt, ws[-1]["word"].strip())
    x = max(56, (W - total) // 2)
    y = H - CAP_YOFF
    register("tiktok-caption", x, y, x + total, y + fsize + 30)
    for i, w in enumerate(ws):
        word = w["word"].strip() + (" " if i < len(ws) - 1 else "")
        active = w["start"] - 0.02 <= t_glob <= w["end"] + 0.10
        if active:
            draw.text((x, y - 14), word, font=fnt_big, fill=accent,
                      stroke_width=4, stroke_fill=BG)
        else:
            col = WHITE if w["end"] < t_glob else DIM
            draw.text((x, y), word, font=fnt, fill=col, stroke_width=4, stroke_fill=BG)
        x += widths[i]

# ───────── save-scene SUBJECTS ─────────
def ig_post_card(save, seed):
    cw, ch = 860, 1000
    card = Image.new("RGB", (cw, ch), CARD)
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, cw - 1, ch - 1), 34, fill=CARD)
    d.ellipse((36, 36, 100, 100), fill=ACCENT_TUPLE)
    d.text((56, 44), (save.get("author") or "?")[:1].upper(), font=font(FONTS["bold"], 40), fill=BG)
    d.text((120, 42), "@" + (save.get("author") or "vault"), font=font(FONTS["semi"], 34), fill=WHITE)
    d.text((120, 84), "Instagram · saved", font=font(FONTS["med"], 26), fill=DIM)
    d.line((36, 128, cw - 36, 128), fill=_outline(CARD, 16), width=2)
    zone = gradient_mesh(seed + 7, cw - 64, 560)
    card.paste(zone, (32, 152))
    d.rounded_rectangle((32, 152, cw - 32, 712), 20, outline=_outline(CARD, 24), width=2)
    quote = save.get("headline") or save.get("body") or "saved link"
    qf = font(FONTS["semi"], 44)
    words = quote.split(); lines = []; cur = ""
    for w in words:
        if text_w(qf, cur + " " + w) > cw - 160:
            lines.append(cur); cur = w
        else: cur = (cur + " " + w).strip()
    if cur: lines.append(cur)
    lines = lines[:7]
    yy = 460 - 28 * len(lines)
    for ln in lines:
        d.text((64, yy), ln, font=qf, fill=WHITE); yy += 56
    d.text((64, 630), "— full post in vault", font=font(MONO_F, 26), fill=BG)
    ay = 760
    d.ellipse((48, ay, 92, ay + 44), outline=WHITE, width=4)
    d.rounded_rectangle((128, ay + 4, 172, ay + 40), 16, outline=WHITE, width=4)
    d.polygon([(150, ay + 48), (126, ay + 80), (174, ay + 80)], fill=CARD, outline=WHITE)
    d.text((216, ay + 8), "saved to vault", font=font(MONO_F, 28), fill=DIM)
    cap = re.sub(r"\s+", " ", (save.get("body") or ""))[:120]
    d.text((40, 850), cap, font=font(FONTS["med"], 30), fill=DIM)
    return card

def tweet_photo_card(photo_path, save):
    img = Image.open(photo_path).convert("RGB")
    img = cover_crop(img, 860, 1000)
    img = ImageEnhance.Contrast(img).enhance(1.06)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, 859, 999), 34, outline=(60, 64, 82), width=3)
    return img

def fmt_num(n):
    try:
        n = int(str(n).replace(",", ""))
        if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
        if n >= 1_000: return f"{n/1_000:.1f}K"
        return str(n)
    except Exception: return str(n)

def heart(draw, cx, cy, r, col):
    draw.ellipse((cx - r, cy - r, cx, cy), fill=col)
    draw.ellipse((cx, cy - r, cx + r, cy), fill=col)
    draw.polygon([(cx - r, cy - r * 0.35), (cx + r, cy - r * 0.35), (cx, cy + r)], fill=col)

def rt_arrow(draw, cx, cy, r, col):
    draw.arc((cx - r, cy - r, cx + r, cy + r), start=200, end=110, fill=col, width=6)
    draw.polygon([(cx - r - 6, cy - r * 0.5), (cx - r + 10, cy - r * 0.5 - 12), (cx - r + 10, cy - r * 0.5 + 12)], fill=col)

def engagement_chips(draw, save, x, y, accent, t_local):
    cx = x
    if save.get("likes"):
        cx = draw_chip(draw, cx, y, fmt_num(save["likes"]), accent, icon="heart", drop_t=t_local - 0.9)
    if save.get("rts"):
        cx = draw_chip(draw, cx, y, fmt_num(save["rts"]), accent, icon="rt", drop_t=t_local - 1.1)
    if save.get("views"):
        cx = draw_chip(draw, cx, y, fmt_num(save["views"]) + " views", accent, drop_t=t_local - 1.3)
    return cx

# ───────── kinetic elements (C3 shadows) ─────────
def shadow_text(draw, x, y, s, fnt, fill, off=(4, 7), sh_col=None):
    draw.text((x + off[0], y + off[1]), s, font=fnt, fill=sh_col or BG)
    draw.text((x, y), s, font=fnt, fill=fill)

def shimmer_text(img, draw, x, y, s, fnt, t, dur=None):
    """motion-primitives TextShimmer port: white band sweeps base-colored text.
    Sweep starts at t>=1.0 (after logo entrance settles)."""
    dur = dur or SHIMMER_DUR
    draw.text((x + 4, y + 7), s, font=fnt, fill=BG)  # shadow
    tw, th = text_w(fnt, s) + 24, fnt.size + 40
    mask = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(mask).text((12, 12), s, font=fnt, fill=255)
    txt = Image.new("RGB", (tw, th), (208, 212, 226))          # base fill
    band = Image.new("L", (tw, th), 0)
    bw = max(24, int(tw * 0.30))
    bx = int((tw + bw) * clamp((t - 1.0) / dur, 0, 1)) - bw
    if bw < tw:
        ImageDraw.Draw(band).rectangle((bx, 0, bx + bw, th), fill=255)
        band = band.filter(ImageFilter.GaussianBlur(8))
        lit = Image.new("RGB", (tw, th), (255, 255, 255))
        txt = Image.composite(lit, txt, band)
    img.paste(txt, (x - 12, y - 12), mask)

_SPRITE_CACHE = {}
def _word_sprite(word, fnt, fill, blur=0):
    key = (word, id(fnt), fill, blur)
    if key not in _SPRITE_CACHE:
        bb = fnt.getbbox(word)
        tw, th = max(1, bb[2] - bb[0]), max(1, bb[3] - bb[1])
        pad = blur * 3 + 10
        spr = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(spr).text((pad - bb[0], pad - bb[1]), word, font=fnt, fill=fill)
        if blur:
            spr = spr.filter(ImageFilter.GaussianBlur(blur))
        _SPRITE_CACHE[key] = (spr, pad - bb[0], pad - bb[1])
    return _SPRITE_CACHE[key]

def kinetic_headline(draw, headline, y, t, accent, key_word=None, size=80, img=None):
    words = headline.split()
    if not words: return
    if not key_word:
        key_word = max(words, key=lambda s: len(s.strip(".,!?—:"))).strip(".,!?—:")

    def _fit(wlist, sz):
        f = font(FONTS["bold"], sz)
        sw = text_w(f, " ")
        tot = sum(text_w(f, w) for w in wlist) + sw * max(0, len(wlist) - 1)
        return f, sw, tot

    sz = size
    fnt, space_w, total = _fit(words, sz)
    split_at = None
    # v7.1 fix: iterative shrink (v7's single-step 80->62 still overflowed on ~55-char headlines)
    while total > W - 120 and sz > 40:
        sz -= 4
        fnt, space_w, total = _fit(words, sz)
    if total > W - 120 and len(words) >= 4:  # balanced 2-line wrap — text NEVER leaves frame
        if sz > 56: sz = 56  # keep 2-liners compact so they stay above the number zone
        acc, split_at = 0.0, len(words) // 2
        for j in range(1, len(words)):
            acc += text_w(fnt, words[j - 1]) + space_w
            if acc >= total / 2.0:
                split_at = j
                break
    segs = [(words, 0)]
    if split_at:
        segs = [(words[:split_at], 0), (words[split_at:], 116)]
    register("headline", 60, y, W - 60, y + (226 if split_at else 110))
    gi = 0
    for wlist, dy in segs:
        fnt, space_w, total = _fit(wlist, sz)
        x = (W - total) // 2
        for w in wlist:
            ww = text_w(fnt, w)
            delay = gi * STAGGER_S
            st = clamp((t - delay) / 0.5, 0, 1)
            e = spring(st)
            yy = y + dy + int((1 - e) * 120)
            is_key = key_word.lower() in w.lower() if key_word else False
            col = accent if is_key else WHITE
            # v7.3 fix (Oct 11 2026): draw block was OUTSIDE the word loop — only the
            # last word of each line ever rendered (stat headline showed as one word).
            if ENTRANCE in ("blur_fade", "pop") and st < 1 and img is not None:
                sprite, ox, oy = _word_sprite(w.strip(), fnt, col, 0)
                if ENTRANCE == "pop":
                    _sc2 = 0.9 + 0.1 * e
                    sw2, sh2 = max(1, int(sprite.width * _sc2)), max(1, int(sprite.height * _sc2))
                    sprite = sprite.resize((sw2, sh2), Image.BILINEAR)
                    px, py = x + ww // 2 - sw2 // 2, yy + 55 - sh2 // 2
                else:
                    px, py = x - ox, yy - oy
                soft, sox, soy = _word_sprite(w.strip(), fnt, col, 6)
                sa = int(255 * (1 - st))
                if sa:
                    soft = soft.copy()
                    soft.putalpha(soft.getchannel("A").point(lambda q: q * sa // 255))
                    img.paste(soft, (x - sox, yy - soy), soft)
                sprite = sprite.copy()
                sprite.putalpha(sprite.getchannel("A").point(lambda q: q * st))
                img.paste(sprite, (px, py), sprite)
            else:
                shadow_text(draw, x, yy, w, fnt, col)
                if is_key and st > 0.2:
                    _sw2 = ww * clamp((t - delay - 0.2) / 0.5, 0, 1)
                    draw.rounded_rectangle((x, yy + 96, x + int(_sw2), yy + 104), 4, fill=accent)
            x += ww + space_w
            gi += 1

def stat_number(img, x, y, value_str, t, accent, size=300):
    """E2-lite spring overshoot count-up + C3 gradient fill + shadow."""
    fnt = font(FONTS["heavy"], size)
    m = re.match(r"^(\D*)([\d,\.]+)(.*)$", value_str)
    if not m:
        shadow_text(ImageDraw.Draw(img), x, y, value_str, fnt, accent); return
    pre, num, post = m.group(1), m.group(2), m.group(3)
    try:
        if "," in num: target = int(num.replace(",", ""))
        elif "." in num: target = float(num)
        else: target = int(num)
    except ValueError:
        shadow_text(ImageDraw.Draw(img), x, y, value_str, fnt, accent); return
    e = counter_spring(clamp(t / 0.85, 0, 1))
    if "." in num: cur = f"{target * min(e, 1.08):.1f}"
    else: cur = f"{int(target * e):,}"
    txt = pre + cur + post
    d = ImageDraw.Draw(img)
    d.text((x + 7, y + 12), txt, font=fnt, fill=BG)
    bh = size + 90
    mask = Image.new("L", (W, bh), 0)
    ImageDraw.Draw(mask).text((x, 0), txt, font=fnt, fill=255)  # LOCAL y (v6.2 bug: global y clipped mask)
    top = tuple(min(255, int(c * 1.35) + 30) for c in accent)
    grad = Image.new("RGB", (W, bh))
    gd = ImageDraw.Draw(grad)
    for row in range(bh):
        f = row / max(1, bh - 1)
        gd.line((0, row, W, row), fill=tuple(int(top[i] + (accent[i] * 0.72 - top[i]) * f) for i in range(3)))
    img.paste(grad, (0, y), mask)

def bars7(draw, x, cy, w, h, raw, t, accent, labels):
    pairs = []
    for v in raw or []:
        if isinstance(v, dict):
            try: pairs.append((float(v.get("v", 0)), str(v.get("d", ""))))
            except Exception: pass
        elif isinstance(v, (list, tuple)) and len(v) >= 1:
            try: pairs.append((float(v[0]), str(v[1]) if len(v) > 1 else ""))
            except Exception: pass
        else:
            try: pairs.append((float(v), ""))
            except Exception: pass
    if not pairs: return
    vals = [p[0] for p in pairs]
    labels = list(labels or [])
    while len(labels) < len(vals): labels.append("")
    for i, p in enumerate(pairs):
        if not labels[i]: labels[i] = p[1]
    n = len(vals)
    mx = max(vals) or 1
    gap = w / n; bw = int(gap * 0.62)
    lf = font(FONTS["med"], 24)
    for i, v in enumerate(vals):
        bh = int(h * (v / mx) * ease_out(clamp(t * 1.4 - i * 0.08, 0, 1)))
        bx = int(x + i * gap + (gap - bw) / 2)
        draw.rounded_rectangle((bx, cy + h - bh, bx + bw, cy + h), 10,
                               fill=accent if i == n - 1 else DIM2)
        lw = text_w(lf, labels[i])
        draw.text((bx + (bw - lw) // 2, cy + h + 14), labels[i], font=lf, fill=DIM)

# ───────── frame composer (D1: bg passed in, already baked) ─────────
def compose_frame(img, sc_idx, scenes, t_local, personas, stats, style, frame_idx):
    d = ImageDraw.Draw(img)
    sc = scenes[sc_idx]
    persona = personas[sc.get("persona_idx", 0)]
    accent = persona["accent"]
    kind = sc["kind"]

    if kind == "stat":
        L = scene_coords(SPEC, kind, sc_idx)
        kinetic_headline(d, sc["headline"], L["headline"]["y"], t_local, accent,
                         key_word=sc.get("key_word"), size=L["headline"]["size"], img=img)
        stat_number(img, L["number"]["x"], L["number"]["y"], sc.get("stat_display", "0"),
                    t_local, accent, size=L["number"]["size"])
        lf = font(FONTS["med"], L["label"]["size"])
        d.text((L["label"]["x"], L["label"]["y"]), sc.get("stat_label", ""), font=lf, fill=WHITE)
        register("stat-label", L["label"]["x"], L["label"]["y"],
                 L["label"]["x"] + text_w(lf, sc.get("stat_label", "")), L["label"]["y"] + 60)
        bars7(d, L["bars"]["x"], L["bars"]["y"], L["bars"]["w"], 300, stats.get("bars7", []),
              t_local, accent, list(stats.get("bars7_labels", [])))
        d.text((L["bars"]["x"], L["hint"]["y"]), "last 7 days", font=font(MONO_F, 30), fill=DIM)
        if stats.get("streak"):
            draw_chip(d, L["bars"]["x"], L["chips"]["y"], f"streak {stats['streak']}d", accent,
                      drop_t=t_local - 1.6)
        _pv = sc.get("_media_raw")
        if _pv is not None and "pip" in L:
            _P = L["pip"]
            _e = spring(clamp(t_local / 0.55, 0, 1))
            _pw = int(_P["w"] * (0.92 + 0.08 * _e)); _ph = int(_P["h"] * (0.92 + 0.08 * _e))
            _card = cover_crop(_pv, _pw, _ph)
            _px = int(_P["x"] + (_P["w"] - _pw) / 2); _py = int(_P["y"] + (_P["h"] - _ph) / 2)
            if _brutal():
                d.rectangle((_px + 8, _py + 8, _px + _pw + 8, _py + _ph + 8), fill=(12, 12, 14))
                img.paste(_card, (_px, _py))
                d.rectangle((_px, _py, _px + _pw, _py + _ph), outline=(12, 12, 14), width=4)
            if SPEC.get("collage"):
                _tcp = Image.new("RGBA", (96, 32), (250, 240, 205, 125))
                _tcp = _tcp.rotate(-12, expand=True)
                img.paste(_tcp, (_px + 14, _py - 10), _tcp)
            else:
                _sh = Image.new("RGBA", (_pw + 60, _ph + 60), (0, 0, 0, 0))
                _sd = ImageDraw.Draw(_sh)
                _sd.rounded_rectangle((30, 30, _pw + 30, _ph + 30), 26, fill=(0, 0, 0, 170))
                _sh = _sh.filter(ImageFilter.GaussianBlur(20))
                img.paste(_sh, (_px - 30, _py - 30), _sh)
                img.paste(_card, (_px, _py))
                d.rounded_rectangle((_px, _py, _px + _pw, _py + _ph), 24, outline=_mix(CARD, DIM, 0.4), width=3)
            register("stat-pip", _px, _py, _px + _pw, _py + _ph)
    elif kind == "save":
        L = scene_coords(SPEC, kind, sc_idx)
        media = sc.get("_media_img")
        if media:
            mw, mh = L["media"]["w"], L["media"]["h"]
            z = 1.06 + 0.05 * math.sin(t_local * 0.5 + sc_idx)
            zoomed = cover_crop(media, int(mw * z), int(mh * z))
            zx = (zoomed.width - mw) // 2; zy = (zoomed.height - mh) // 2
            layer = zoomed.crop((zx, zy, zx + mw, zy + mh))
            e = spring(clamp(t_local / 0.7, 0, 1))
            pop = 0.94 + 0.06 * e
            pw, ph = int(mw * pop), int(mh * pop)
            layer = layer.resize((pw, ph), Image.BILINEAR)
            lx = int(110 + (1 - e) * 240) - (pw - mw) // 2
            ly = L["media"]["y"] - (ph - mh) // 2
            if _brutal():
                d.rectangle((lx + 10, ly + 10, lx + pw + 10, ly + ph + 10), fill=(12, 12, 14))
                img.paste(layer, (lx, ly))
                d.rectangle((lx, ly, lx + pw, ly + ph), outline=(12, 12, 14), width=4)
            if SPEC.get("collage"):
                for _tcx, _ang in ((lx + 20, -14), (lx + pw - 130, 14)):
                    _tcp = Image.new("RGBA", (120, 38), (250, 240, 205, 125))
                    _tcp = _tcp.rotate(_ang, expand=True)
                    img.paste(_tcp, (_tcx, ly - 12), _tcp)
            else:
                sh = Image.new("RGBA", (mw + 80, mh + 80), (0, 0, 0, 0))
                sd = ImageDraw.Draw(sh)
                sd.rounded_rectangle((40, 40, mw + 40, mh + 40), 36, fill=(0, 0, 0, 170))
                sh = sh.filter(ImageFilter.GaussianBlur(26))
                img.paste(sh, (lx - 40, ly - 40), sh)
                img.paste(layer, (lx, ly))
                d.rounded_rectangle((lx, ly, lx + pw, ly + ph), 34, outline=_mix(CARD, DIM, 0.4), width=3)
            register("media-card", lx, ly, lx + pw, ly + ph)
        hf2 = font(FONTS["semi"], L["headline"]["size"])
        words2 = sc["headline"].split(); lines = []; cur = ""
        for w in words2:
            if text_w(hf2, cur + " " + w) > W - 168:
                lines.append(cur); cur = w
            else: cur = (cur + " " + w).strip()
        if cur: lines.append(cur)
        lines = lines[:2]
        yy = L["headline"]["y"]
        for ln in lines:
            lw = text_w(hf2, ln)
            e = spring(clamp((t_local - 0.3) / 0.6, 0, 1))
            shadow_text(d, (W - lw) // 2 + int((1 - e) * 60), yy + int((1 - e) * 40), ln, hf2,
                        WHITE if media else DIM)
            yy += 70
        engagement_chips(d, sc, 64, L["chips"]["y"], accent, t_local)
        if sc.get("author"):
            tf = font(MONO_F, 32)
            n = int(len("@" + sc["author"]) * clamp((t_local - 0.8) / 1.2, 0, 1))
            shown = ("@" + sc["author"])[:n]
            w_ = text_w(tf, "@" + sc["author"])
            cy0 = L["chips"]["y"]
            box = (W - 64 - w_ - 48, cy0, W - 64, cy0 + 58)
            d.rounded_rectangle(box, 28, fill=CARD, outline=_outline(CARD), width=1)
            register("handle", *box)
            d.text((W - 64 - w_ - 24, cy0 + 8), shown, font=tf, fill=(150, 220, 255))
    elif kind == "outro":
        L = scene_coords(SPEC, kind, sc_idx)
        kinetic_headline(d, sc["headline"], L["headline"]["y"], t_local, accent,
                         size=L["headline"]["size"], img=img)
        bf = font(FONTS["med"], L["body"]["size"])
        yy = L["body"]["y"]
        for k, ln in enumerate(sc.get("body_lines", [])):
            lw = text_w(bf, ln)
            e = spring(clamp((t_local - 0.4 - 0.15 * k) / 0.6, 0, 1))
            shadow_text(d, (W - lw) // 2 - int((1 - e) * 50), yy + int((1 - e) * 60), ln, bf, WHITE)
            yy += 76
        bs = clamp((t_local - 1.0) / 0.6, 0, 1)
        if bs > 0:
            e = spring(bs)
            f2 = font(FONTS["display"], int(L["logo"]["size"] * (1 + (1 - e) * 0.35)))
            lw2 = text_w(f2, "OMNICLAW")
            lx, ly = (W - lw2) // 2, L["logo"]["y"] - int((1 - e) * 40)
            if SHIMMER_TARGET == "logo" and e > 0.99:
                shimmer_text(img, d, lx, ly, "OMNICLAW", f2, t_local)
            else:
                shadow_text(d, lx, ly, "OMNICLAW", f2, WHITE)
            draw_chip(d, (W - 340) // 2, L["chips"]["y"], "your vault, daily", accent,
                      drop_t=t_local - 1.4)
        register("outro-logo", (W - 500) // 2, L["logo"]["y"], (W + 500) // 2, L["logo"]["y"] + 220)

    progress_bar(d, frame_idx / max(1, style.get("total_frames", 1)), sc_idx, len(scenes))
    return img

# ───────── B2: whip-pan transitions ─────────
def whip_frames(img_a_path, img_b_path, out_dir, start_fi, n=None):
    n = n or TRANS_FRAMES
    A = Image.open(img_a_path).convert("RGB")
    B = Image.open(img_b_path).convert("RGB")
    for k in range(1, n + 1):
        p = k / (n + 1)
        if TRANS_TYPE == "fade":
            canvas = Image.blend(A, B, ease_in(p))
        else:
            shift = int(ease_in(p) * W * 1.15)
            canvas = Image.new("RGB", (W, H))
            canvas.paste(A, (shift, 0))
            canvas.paste(B, (shift - W, 0))
            blur = math.sin(p * math.pi) * 13
            if blur > 1:
                canvas = canvas.filter(ImageFilter.GaussianBlur(blur))
        canvas.save(os.path.join(out_dir, f"f{start_fi + k - 1:05d}.jpg"), quality=88)

# ───────── B3+B4: numpy audio ─────────
def load_vo_float(vo_mp3, tmpdir):
    raw = os.path.join(tmpdir, "vo.raw")
    subprocess.run(["ffmpeg", "-y", "-i", vo_mp3, "-f", "s16le", "-ac", "1", "-ar", str(SR), raw],
                   capture_output=True, check=True)
    return np.frombuffer(open(raw, "rb").read(), dtype=np.int16).astype(np.float32) / 32768.0

def duck_envelope(n_samples, words, base=None, duck=None):
    base = BED_GAIN if base is None else base
    duck = base * 0.31 if duck is None else duck
    env = np.full(n_samples, base, dtype=np.float32)
    for w in words:
        i0 = max(0, int(w["start"] * SR)); i1 = min(n_samples, int((w["end"] + 0.06) * SR))
        if i1 > i0: env[i0:i1] = duck
    k = np.ones(1400, dtype=np.float32) / 1400
    return np.convolve(env, k, mode="same")

def music_bed(n_samples, total_dur, env):
    bed = np.zeros(n_samples, dtype=np.float32)
    bpm = BED_BPM; beat = 60.0 / bpm
    L = int(0.30 * SR); tt = np.arange(L, dtype=np.float32) / SR
    f = 58 - 16 * tt / 0.30
    thump = (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.42).astype(np.float32)
    Lh = int(0.03 * SR)
    hat_env = (np.exp(-np.arange(Lh, dtype=np.float32) / SR * 90) * 0.04).astype(np.float32)
    nb = int(total_dur / beat) + 1
    for b in range(nb):
        i0 = int(b * beat * SR)
        if i0 + L < n_samples: bed[i0:i0 + L] += thump
        i1 = i0 + int(beat / 2 * SR)
        if i1 + Lh < n_samples:
            noise = np.diff(np.random.randn(Lh + 1).astype(np.float32))
            bed[i1:i1 + Lh] += noise * hat_env
    return bed * env

def whoosh(dur=0.34):
    n = int(dur * SR)
    x = np.random.randn(n).astype(np.float32)
    for _ in range(3):
        x = np.convolve(x, np.ones(24, dtype=np.float32) / 24, mode="same")
    return x * (np.hanning(n).astype(np.float32) ** 2) * 0.9

def bass_hit():
    L = int(0.4 * SR); tt = np.arange(L, dtype=np.float32) / SR
    s = np.sin(2 * np.pi * 52 * tt) * np.exp(-tt * 8) * 0.65
    Lc = int(0.01 * SR)
    s[:Lc] += np.random.randn(Lc).astype(np.float32) * np.exp(-np.arange(Lc, dtype=np.float32) / SR * 400) * 0.25
    return s.astype(np.float32)

def riser(dur=1.1):
    n = int(dur * SR)
    x = np.random.randn(n).astype(np.float32)
    for _ in range(2):
        x = np.convolve(x, np.ones(16, dtype=np.float32) / 16, mode="same")
    return x * (np.linspace(0, 1, n, dtype=np.float32) ** 2) * 0.22

def tactile_tick():
    """OpenMontage premium audio: 'small tactile ticks' on chip landings (8ms)."""
    L = int(0.008 * SR)
    x = np.random.randn(L).astype(np.float32) * np.exp(-np.arange(L, dtype=np.float32) / SR * 900)
    return x * 0.30

def build_mix(vo_mp3, words, times, total_dur, tmpdir):
    """vo + ducked bed + SFX at boundaries/landings -> mix.wav (same length as vo)."""
    vo = load_vo_float(vo_mp3, tmpdir)
    n = len(vo)
    mix = vo.copy()
    env = duck_envelope(n, words)
    mix += music_bed(n, total_dur, env)
    def add(sig, at):
        i0 = int(at * SR)
        i1 = min(n, i0 + len(sig))
        if i1 > i0: mix[i0:i1] += sig[:i1 - i0]
    for k in range(1, len(times)):                      # whoosh into each new scene
        add(whoosh(), max(0.0, times[k][1] - 0.18))
    for (bi, t0, dur, p) in times:                      # bass hit on landings
        b = beats_kind_cache.get(bi)
        if b == "stat":
            add(bass_hit(), t0 + 0.82)
            add(tactile_tick(), t0 + 1.62)              # streak chip landing
        elif b == "save":
            add(bass_hit(), t0 + 0.68)
            add(tactile_tick(), t0 + 0.92)              # heart chip
            add(tactile_tick(), t0 + 1.12)              # rt chip
    add(riser(), max(0.0, total_dur - 1.25))            # riser into sign-off
    peak = float(np.max(np.abs(mix))) if n else 1.0
    if peak > 0.95: mix *= 0.95 / peak
    wav_path = os.path.join(tmpdir, "mix.wav")
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
        wf.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())
    return wav_path

# ───────── normalization (reel.js beat schema) ─────────
beats_kind_cache = {}
def normalize_beats(beats, stats):
    out = []
    for i, b in enumerate(beats):
        b = dict(b)
        beats_kind_cache[i] = b.get("kind")
        if b.get("kind") == "stat":
            st = b.get("stat") or {}
            b["stat_display"] = str(st.get("big") or stats.get("today") or "0")
            b["stat_label"] = str(st.get("label") or "saves today")
            words = (b.get("headline") or "").split()
            b["key_word"] = max(words, key=len).strip(".,!?—:") if words else ""
        if not (b.get("vo") or "").strip():
            if b.get("kind") == "stat":
                b["vo"] = (b.get("headline") or "").strip()
            elif b.get("kind") == "save":
                b["vo"] = ((b.get("headline") or "") + ". " + (b.get("body") or "")).strip().strip(".") + "."
            else:
                b["vo"] = ((b.get("headline") or "") + ". " + (b.get("body") or "")).strip()
        out.append(b)
    return out

# ───────── audio pipeline ─────────
def _env_key():
    k = os.environ.get("OPENAI_API_KEY")
    if k: return k
    try:
        for ln in open("/opt/whatsapp/.env"):
            if ln.startswith("OPENAI_API_KEY="):
                v = ln.split("=", 1)[1].strip().strip('"').strip("'")
                if v: return v
    except Exception: pass
    return None

_OAI_VOICES = {"stat": "onyx", "save": "nova", "outro": "ash"}

def _openai_tts(text, voice, speed, wav):
    key = _env_key()
    if not key: return False
    try:
        import json as _json
        req = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=_json.dumps({"model": "gpt-4o-mini-tts", "voice": voice,
                              "input": text, "speed": speed,
                              "response_format": "wav"}).encode(),
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r, open(wav, "wb") as f:
            f.write(r.read())
        return os.path.getsize(wav) > 4000
    except Exception as e:
        print("openai tts failed:", str(e)[:90]); return False

def tts_sections(beats, personas, tmpdir):
    out = []
    for i, b in enumerate(beats):
        text = (b.get("vo") or "").strip()
        if not text: continue
        p = personas[{"stat": 0, "save": 1, "outro": 2}.get(b.get("kind"), 0)]
        mp3 = os.path.join(tmpdir, f"sec_{i}.mp3")
        try:
            speed = max(0.8, min(1.3, 1.0 + float(p["rate"].replace("%", "")) / 100.0))
        except Exception:
            speed = 1.0
        # v7.1: OpenAI TTS primary (natural voice), edge-tts fallback when no key/API fail
        if not _openai_tts(text, _OAI_VOICES.get(b.get("kind"), "onyx"), speed, mp3):
            subprocess.run(["edge-tts", f"--voice={p['voice']}", f"--rate={p['rate']}", f"--pitch={p['pitch']}",
                            f"--text={text}", f"--write-media={mp3}"], check=True, capture_output=True, timeout=120)
        out.append((i, mp3, p))
    return out

def whisper_words(mp3):
    import gc
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _ = model.transcribe(mp3, vad_filter=True,
                               vad_parameters=dict(min_silence_duration_ms=400), word_timestamps=True)
    words = []
    for s in segs:
        for w in (s.words or []):
            words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})
    del model
    gc.collect()
    return words

def dur_of(path):
    out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return float(out or 0)

# ───────── main ─────────
def main():
    global LAYOUT_CHECK
    if len(sys.argv) > 1 and sys.argv[1].lstrip().startswith("{"):
        job = json.loads(sys.argv[1])
        beats = job.get("beats") or []
        stats = job.get("stats") or {}
        style = job.get("style") or {}
        out_path = job.get("out_path")
        tmpdir = os.path.dirname(out_path) or "/tmp"
        _load_fonts()
        _run(beats, stats, style, out_path, tmpdir, template=job.get("template"))
        print(f"OK {out_path} {os.path.getsize(out_path)}")
        return
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats")
    ap.add_argument("--stats")
    ap.add_argument("--style")
    ap.add_argument("--out")
    ap.add_argument("--template")
    ap.add_argument("--layout-check", action="store_true")
    args = ap.parse_args()
    LAYOUT_CHECK = args.layout_check
    _load_fonts()
    if LAYOUT_CHECK:
        import reel_templates as TPL
        names = TPL.list_templates()
        if not names:
            print("LAYOUT-CHECK: no templates found in", TPL.TPL_DIR)
        for n in names:
            try:
                s = TPL.load(n)
                missing = [r for r in ("display", "heavy", "body", "med")
                           if not os.path.exists(s["fonts"][r])]
                print(f"LAYOUT-CHECK {n}: OK v{s['version']} fonts_missing={missing or 'none'}")
            except Exception as e:
                print(f"LAYOUT-CHECK {n}: FAIL {e}")
        if not args.beats:
            return
    beats = json.load(open(args.beats)) if args.beats else [
        {"kind": "stat", "vo": "t", "headline": "YOUR VAULT IS COMPOUNDING", "stat_display": "14",
         "stat_label": "saves in the last 24h", "short": "HOOK"},
        {"kind": "save", "vo": "t", "headline": "NVIDIA mapped the reasoning gap",
         "body": "Full thread saved.", "author": "NVIDIAAI", "likes": 1196, "rts": 150, "views": "79574", "short": "SAVE"},
        {"kind": "outro", "vo": "t", "headline": "KEEP SAVING", "body_lines": ["brief · 8:00 AM"], "short": "OUTRO"},
    ]
    stats = json.load(open(args.stats)) if args.stats else {"bars7": [6, 11, 9, 14, 8, 12, 14],
        "bars7_labels": ["S", "M", "T", "W", "T", "F", "S"], "streak": 23}
    style = json.load(open(args.style)) if args.style else {}
    _run(beats, stats, style, args.out, "/tmp/reel_v7_work", template=args.template)

def _run(beats, stats, style, out_path, tmpdir, template=None):
    import reel_templates as TPL
    S = TPL.load(template or TPL.pick())
    apply_spec(S)
    print(f"template: {S['id']} v{S['version']} "
          f"(entrance={S['motion']['entrance']} transition={TRANS_TYPE}/{TRANS_FRAMES}f)")
    if not out_path:
        os.makedirs("/tmp/omniclaw_reels", exist_ok=True)
        out_path = f"/tmp/omniclaw_reels/reel_{S['id']}_v{S['version']}_{int(time.time())}.mp4"
    os.makedirs(tmpdir, exist_ok=True)
    stats = stats or {}
    beats = normalize_beats(beats, stats)
    seed = style.get("seed") or int(time.time())
    random.seed(seed)

    accents = [ACCENT_TUPLE, PERSONA_ACCENTS[1], PERSONA_ACCENTS[2]]
    accent = ACCENT_TUPLE  # council law: template owns accent (v6.2 random-accent hack removed)
    personas = [
        {"name": "ANNOUNCER", "voice": "en-US-GuyNeural", "rate": "+10%", "pitch": "+2Hz", "accent": PERSONA_ACCENTS[0], "badge": "01 · THE HOOK"},
        {"name": "CURATOR", "voice": "en-US-AvaNeural", "rate": "+2%", "pitch": "+0Hz", "accent": PERSONA_ACCENTS[1], "badge": "02 · THE CURATOR"},
        {"name": "SIGNOFF", "voice": "en-US-ChristopherNeural", "rate": "-4%", "pitch": "-2Hz", "accent": PERSONA_ACCENTS[2], "badge": "03 · THE SIGN-OFF"},
    ]

    scenes = []
    for b in beats:
        if not (b.get("vo") or "").strip() and not LAYOUT_CHECK: continue
        sc = dict(b)
        sc["persona_idx"] = {"stat": 0, "save": 1, "outro": 2}.get(b.get("kind"), 0)
        if b.get("kind") == "stat" and (b.get("media_url") or b.get("local_media")):
            # vault law: photo within 2s — stat beat carries the best saved photo
            _lm = b.get("local_media")
            _mp = _lm if _lm and os.path.exists(str(_lm)) else fetch_media(b.get("media_url"))
            if _mp:
                try: sc["_media_raw"] = Image.open(_mp).convert("RGB")
                except Exception: sc["_media_raw"] = None
        if b.get("kind") == "save":
            if LAYOUT_CHECK:
                sc["_media_img"] = ig_post_card(b, seed)
            else:
                lm = b.get("local_media")
                mp = lm if lm and os.path.exists(str(lm)) else fetch_media(b.get("media_url"))
                if mp:
                    try: sc["_media_img"] = tweet_photo_card(mp, b)
                    except Exception as e: print("media card fail:", e); sc["_media_img"] = None
                if not sc.get("_media_img"):
                    sc["_media_img"] = ig_post_card(b, seed + abs(hash(b.get("url", ""))) % 999)
        scenes.append(sc)

    # vox-director beat-layer: anti-monotony camera rhythm + per-beat paper bg
    if SPEC.get("collage"):
        _RHY = ["push_in", "pan", "static", "push_in", "static", "pan", "push_in", "static"]
        _PAPER = [(228, 205, 168), (209, 227, 199), (197, 214, 230),
                  (240, 214, 207), (243, 228, 183), (231, 215, 190)]
        for _ki, _sc2 in enumerate(scenes):
            _sc2["_move"] = _RHY[_ki % len(_RHY)]
            _sc2["bg_color"] = _PAPER[_ki % len(_PAPER)]

    if os.environ.get("REEL_DEBUG"):
        for _di, _ds in enumerate(scenes):
            print(f"DBG scene{_di} kind={_ds.get('kind')} headline={_ds.get('headline')!r} _move={_ds.get('_move')} bg={_ds.get('bg_color')}")

    if LAYOUT_CHECK:
        for i in range(len(scenes)):
            LAYOUT_BAG.clear()
            style["total_frames"] = 1
            bgs = build_static_bgs(i, scenes[i], style, seed)
            img = bgs[0].copy()
            compose_frame(img, i, scenes, 1.5, personas, stats, style, 0)
            dr = ImageDraw.Draw(img)
            tiktok_captions(dr, build_caption_groups([
                {"word": "your vault", "start": 1.0, "end": 1.4},
                {"word": "is compounding", "start": 1.4, "end": 1.9},
                {"word": "daily", "start": 1.9, "end": 2.3}]), 1.5, personas[0]["accent"])
            bad = layout_check_report()
            print(f"scene[{i}] kind={scenes[i]['kind']}: {'OK' if not bad else 'FAIL'}")
            for b in bad: print("   ", b)
        sys.exit(0)

    # 1) TTS
    sections = tts_sections(beats, personas, tmpdir)
    if not sections: sys.exit("no VO sections")
    gap = 0.55
    gaps_mp3 = os.path.join(tmpdir, "gap.mp3")
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(gap),
                    "-c:a", "libmp3lame", gaps_mp3], capture_output=True)
    times = []; t = 0.0
    concat_list = []
    for k, (bi, mp3, p) in enumerate(sections):
        dd = dur_of(mp3)
        times.append((bi, t, dd, p))
        concat_list.append(mp3)
        t += dd + gap
        if k < len(sections) - 1: concat_list.append(gaps_mp3)
    lst = os.path.join(tmpdir, "concat.txt")
    with open(lst, "w") as f:
        for pth in concat_list: f.write(f"file '{pth}'\n")
    vo = os.path.join(tmpdir, "vo.mp3")
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c:a", "libmp3lame", "-q:a", "4", vo],
                   capture_output=True, check=True)
    total_dur = dur_of(vo)

    # 2) whisper + caption groups
    words = whisper_words(vo)
    cgroups = build_caption_groups(words)
    print(f"VO {total_dur:.1f}s, {len(words)} words, {len(cgroups)} caption groups")

    # 3) render frames (scene tails shortened by TRANS_FRAMES -> whip fills the gap)
    frames_dir = os.path.join(tmpdir, "frames"); os.makedirs(frames_dir, exist_ok=True)
    for f_ in os.listdir(frames_dir): os.remove(os.path.join(frames_dir, f_))
    style["total_frames"] = int(total_dur * FPS)
    fi = 0
    scene_ranges = []
    current_bgs = None
    flash_accent = None
    for sc_idx, (bi, t0, dur, p) in enumerate(times):
        bgs = build_static_bgs(sc_idx, scenes[sc_idx], style, seed)
        flash_accent = personas[scenes[sc_idx]["persona_idx"]]["accent"]
        n_frames = int((dur + (gap if sc_idx < len(times) - 1 else 0.15)) * FPS)
        n_render = n_frames - (TRANS_FRAMES if sc_idx < len(times) - 1 else 0)
        start_fi = fi
        for kk in range(n_render):
            t_glob = t0 + kk / FPS
            t_local = t_glob - t0
            img = bgs[kk % 3].copy()
            _mv = scenes[sc_idx].get("_move")
            if _mv and _mv != "static" and not LAYOUT_CHECK:
                _pr = kk / max(n_render, 1)
                if _mv == "push_in":
                    _s = 1.0 + 0.06 * _pr
                elif _mv == "pull_out":
                    _s = 1.06 - 0.06 * _pr
                else:
                    _s = 1.05
                _nw, _nh = int(W * _s), int(H * _s)
                _big = img.resize((_nw, _nh), Image.BILINEAR)
                _ox = ((_nw - W) // 2) + (int(30 * math.sin(_pr * math.pi)) if _mv == "pan" else 0)
                _oy = ((_nh - H) // 2) + (int(40 * math.sin(_pr * math.pi)) if _mv == "tilt" else 0)
                img = _big.crop((_ox, _oy, _ox + W, _oy + H))
            compose_frame(img, sc_idx, scenes, t_local, personas, stats, style, fi)
            if os.environ.get("REEL_DEBUG_ONE") and sc_idx == 0 and kk == 50:
                img.save("/tmp/dbg_frame.jpg")
                print("DBG saved /tmp/dbg_frame.jpg t_local=", t_local)
                raise SystemExit(0)
            dr = ImageDraw.Draw(img)
            tiktok_captions(dr, cgroups, t_glob, flash_accent)
            # E2-lite landing flash on stat scenes
            if scenes[sc_idx]["kind"] == "stat" and 0.88 <= t_local <= 1.02:
                flash_img = Image.new("RGB", (W, H), flash_accent)
                a = 0.5 if t_local < 0.94 else 0.22
                img = Image.blend(img, flash_img, a)
            img.save(os.path.join(frames_dir, f"f{fi:05d}.jpg"), quality=88)
            fi += 1
        scene_ranges.append((start_fi, fi - start_fi))
        print(f"scene[{sc_idx}] {scenes[sc_idx]['kind']}: {n_render} frames")

    # 3b) insert whip transitions into the freed tail slots
    final_dir = frames_dir + "_final"; os.makedirs(final_dir, exist_ok=True)
    for f_ in os.listdir(final_dir): os.remove(os.path.join(final_dir, f_))
    out_fi = 0
    for sc_idx, (start, count) in enumerate(scene_ranges):
        for k in range(count):
            shutil.copy(os.path.join(frames_dir, f"f{start + k:05d}.jpg"),
                        os.path.join(final_dir, f"f{out_fi:05d}.jpg"))
            out_fi += 1
        if sc_idx < len(scene_ranges) - 1:
            nxt = scene_ranges[sc_idx + 1]
            whip_frames(os.path.join(frames_dir, f"f{start + count - 1:05d}.jpg"),
                        os.path.join(frames_dir, f"f{nxt[0]:05d}.jpg"),
                        final_dir, out_fi)
            out_fi += TRANS_FRAMES
    print(f"rendered {out_fi} frames (incl {TRANS_FRAMES * (len(scene_ranges) - 1)} transition)")

    # 4) audio mix (B3 SFX + B4 bed) + mux
    mix_wav = build_mix(vo, words, times, total_dur, tmpdir)
    # v7 FIX: 2-pass loudnorm (fframes audio law: -14 LUFS / <=-1 dBTP; single-pass under-applied)
    ln_base = f"loudnorm=I={LN_I}:TP={LN_TP}:LRA={LN_LRA}"
    p1 = subprocess.run(["ffmpeg", "-y", "-i", mix_wav, "-af",
                         ln_base + ":print_format=json", "-f", "null", "-"],
                        capture_output=True, text=True)
    ln2 = ln_base
    m_ln = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p1.stderr, re.S)
    if m_ln:
        try:
            js = json.loads(m_ln.group(0))
            ln2 = (ln_base +
                   f":measured_I={float(js['input_i']):.2f}"
                   f":measured_TP={float(js['input_tp']):.2f}"
                   f":measured_LRA={float(js['input_lra']):.2f}"
                   f":measured_thresh={float(js['input_thresh']):.2f}"
                   f":offset={float(js['target_offset']):.2f}:linear=true")
            print(f"loudnorm pass1: {js['input_i']} LUFS -> target {LN_I}")
        except Exception as e:
            print("loudnorm pass1 parse fail:", str(e)[:60])
    # vault law: frame-0 flash-cut hook (template-gated)
    try:
        if SPEC.get("effects", {}).get("flash_hook"):
            _fhook = SPEC.get("effects", {}).get("flash_hook")
            _frgb = tuple(int(x) for x in str(_fhook).split(",")) if isinstance(_fhook, str) else (255, 255, 255)
            for _fn, _al in (("f00000.jpg", 0.88), ("f00001.jpg", 0.45)):
                _fp = os.path.join(final_dir, _fn)
                if os.path.exists(_fp):
                    _im = Image.open(_fp).convert("RGB")
                    Image.blend(_im, Image.new("RGB", _im.size, _frgb), _al).save(_fp, quality=92)
            print("flash_hook: applied")
    except Exception as _e:
        print("flash_hook skip:", _e)

    # OpenMontage color-grading: template grade (social punchy on mobile)
    subprocess.run(["ffmpeg", "-y", "-start_number", "0", "-framerate", str(FPS),
                    "-i", os.path.join(final_dir, "f%05d.jpg"), "-i", mix_wav,
                    "-vf", f"eq=contrast={GRADE_C}:saturation={GRADE_S}",
                    "-af", ln2 + ",alimiter=limit=0.70:attack=1:release=20:level=false,aresample=44100",  # fframes: TP<=-1dBTP
                    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out_path],
                   capture_output=True, check=True)
    print("OUT", out_path, os.path.getsize(out_path))

if __name__ == "__main__":
    main()
