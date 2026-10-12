#!/usr/bin/env python3
"""Reel v7 template loader — port of OpenMontage playbook_loader pattern.

Preset dir + custom/ fallback, jsonschema validation, resolution into a
fully-resolved Render Spec.
LAW (council): downstream MotionEngine/SceneBuilders NEVER read identity/mood
dials — every conditional resolves here into plain values."""
import copy
import functools
import glob
import json
import os

import jsonschema
import yaml

TPL_DIR = os.environ.get("REEL_TPL_DIR", "/opt/whatsapp/reel_templates")
FONT_DIRS = ["/opt/whatsapp/assets/fonts", "/opt/whatsapp/fonts",
             "/usr/share/fonts/truetype/dejavu"]
FALLBACK_FONT = "DejaVuSans-Bold.ttf"
_RR_PATH = "/tmp/reel_tpl_rr.json"


class TemplateError(Exception):
    pass


SCHEMA = {
    "type": "object",
    "required": ["id", "version", "palette", "fonts", "motion", "scenes",
                 "audio", "effects", "pacing"],
    "properties": {
        "id": {"type": "string", "pattern": "^[a-z0-9-]+$"},
        "version": {"type": "integer", "minimum": 1},
        "identity": {"type": "object"},
        "palette": {"type": "object",
            "required": ["bg0", "bg1", "accent", "white", "dim"],
            "properties": {
                "bg0": {"type": "string"}, "bg1": {"type": "string"},
                "accent": {"type": "string"}, "white": {"type": "string"},
                "dim": {"type": "string"}, "dim2": {"type": "string"},
                "card": {"type": "string"}, "red": {"type": "string"},
                "grain": {"type": "integer", "minimum": 0, "maximum": 8},
                "vignette": {"type": "number", "minimum": 0, "maximum": 1}}},
        "fonts": {"type": "object", "required": ["display", "heavy", "body"],
            "properties": {
                "display": {"type": "string"}, "heavy": {"type": "string"},
                "body": {"type": "string"}, "med": {"type": "string"},
                "mono": {"type": "string"}}},
        "motion": {"type": "object", "required": ["springs", "transition"],
            "properties": {
                "springs": {"type": "object", "required": ["soft", "bouncy"],
                    "properties": {
                        "soft": {"type": "array", "items": {"type": "number"},
                                 "minItems": 2, "maxItems": 2},
                        "bouncy": {"type": "array", "items": {"type": "number"},
                                   "minItems": 2, "maxItems": 2}}},
                "entrance": {"enum": ["slide", "blur_fade", "pop"]},
                "stagger_s": {"type": "number", "minimum": 0.02, "maximum": 0.2},
                "transition": {"type": "object", "required": ["type", "frames"],
                    "properties": {
                        "type": {"enum": ["whip", "fade"]},
                        "frames": {"type": "integer", "minimum": 4, "maximum": 30}}},
                "shimmer": {"type": "object",
                    "properties": {"target": {"enum": ["logo", "none"]},
                                   "dur": {"type": "number", "minimum": 0.5, "maximum": 6}}},
                "counter": {"enum": ["spring_soft", "spring_bouncy"]}}},
        "scenes": {"type": "object"},
        "audio": {"type": "object", "required": ["bed", "loudness"],
            "properties": {
                "bed": {"type": "object", "required": ["bpm", "gain"],
                    "properties": {"bpm": {"type": "number", "minimum": 60, "maximum": 160},
                                   "gain": {"type": "number", "minimum": 0, "maximum": 0.6}}},
                "loudness": {"type": "object", "required": ["i", "tp"],
                    "properties": {"i": {"type": "number"}, "tp": {"type": "number"},
                                   "lra": {"type": "number"}}}}},
        "effects": {"type": "object", "required": ["grade"],
            "properties": {"grade": {"type": "object", "required": ["contrast", "saturation"],
                "properties": {"contrast": {"type": "number", "minimum": 0.8, "maximum": 1.4},
                               "saturation": {"type": "number", "minimum": 0.5, "maximum": 1.6}}}}},
        "pacing": {"type": "object", "required": ["captions"],
            "properties": {
                "hook_window_s": {"type": "number"},
                "min_hold_s": {"type": "number"},
                "captions": {"type": "object", "required": ["max_words", "y_off"],
                    "properties": {
                        "max_words": {"type": "integer", "minimum": 2, "maximum": 6},
                        "max_chars": {"type": "integer", "minimum": 12, "maximum": 40},
                        "min_display_s": {"type": "number", "minimum": 0.2, "maximum": 2},
                        "tail_s": {"type": "number", "minimum": 0, "maximum": 0.6},
                        "y_off": {"type": "integer", "minimum": 200, "maximum": 600}}},
                "safe": {"type": "object",
                    "properties": {"y_max": {"type": "number", "minimum": 0.5, "maximum": 1.0}}}}},
        "overrides": {"type": "object",
            "properties": {
                "max_deviation_ratio": {"type": "number", "minimum": 0, "maximum": 1},
                "scene_overrides": {"type": "array",
                    "items": {"type": "object",
                        "required": ["match", "patch"],
                        "properties": {"match": {"type": "object"},
                                       "patch": {"type": "object"}}}}}},
    },
}


def _rgb(v):
    """'#05060A' or '5,6,10' or [5,6,10] -> (5, 6, 10)"""
    if isinstance(v, (list, tuple)):
        return tuple(int(x) for x in list(v)[:3])
    s = str(v).lstrip("#").strip()
    if "," in s:
        return tuple(int(x) for x in s.split(",")[:3])
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def _find_font(name):
    """Asset registry (council #4): resolve role -> file path, fallback chain."""
    n = name if str(name).endswith(".ttf") else str(name) + ".ttf"
    for d in FONT_DIRS:
        p = os.path.join(d, n)
        if os.path.exists(p) and os.path.getsize(p) > 10000:
            return p
    for d in FONT_DIRS:
        p = os.path.join(d, FALLBACK_FONT)
        if os.path.exists(p):
            print(f"[tpl] font '{name}' not found -> fallback {p}")
            return p
    raise TemplateError(f"no usable font for '{name}' anywhere in {FONT_DIRS}")


def list_templates():
    names = [os.path.splitext(os.path.basename(p))[0]
             for p in sorted(glob.glob(os.path.join(TPL_DIR, "*.yaml")))]
    for p in sorted(glob.glob(os.path.join(TPL_DIR, "custom", "*.yaml"))):
        n = os.path.splitext(os.path.basename(p))[0]
        if n not in names:
            names.append(n)
    return names


def _read(name):
    p = os.path.join(TPL_DIR, name + ".yaml")
    if not os.path.exists(p):
        p2 = os.path.join(TPL_DIR, "custom", name + ".yaml")
        if os.path.exists(p2):
            p = p2
        else:
            raise TemplateError(
                f"template '{name}' not found (searched {TPL_DIR} and {TPL_DIR}/custom)")
    with open(p, encoding="utf-8") as f:
        tpl = yaml.safe_load(f)
    try:
        jsonschema.validate(tpl, SCHEMA)
    except jsonschema.ValidationError as e:
        raise TemplateError(f"template '{name}' invalid at "
                            f"{list(e.absolute_path)}: {e.message}")
    return tpl


def resolve(tpl):
    """Fully-resolved Render Spec (council #1): no dials survive resolution."""
    S = copy.deepcopy(tpl)
    pal = S["palette"]
    for k in list(pal):
        if k not in ("grain", "vignette"):
            pal[k] = _rgb(pal[k])
    pal.setdefault("grain", 3)
    pal.setdefault("vignette", 0.35)
    pal.setdefault("dim2", pal["dim"])
    pal.setdefault("card", pal["bg1"])
    pal.setdefault("red", (255, 90, 90))
    S["persona_accents"] = tuple(_rgb(x) for x in S.get(
        "persona_accents", [pal["accent"]] * 3))

    f = S["fonts"]
    for role in ("display", "heavy", "body"):
        f[role] = _find_font(f[role])
    f.setdefault("med", f["body"])
    f["med"] = _find_font(f["med"])
    f.setdefault("mono", _find_font("DejaVuSansMono"))

    m = S["motion"]
    m.setdefault("entrance", "slide")
    m.setdefault("stagger_s", 0.06)
    m.setdefault("counter", "spring_soft")
    m["springs"]["soft"] = tuple(float(x) for x in m["springs"]["soft"])
    m["springs"]["bouncy"] = tuple(float(x) for x in m["springs"]["bouncy"])
    m.setdefault("shimmer", {"target": "none", "dur": 2.0})
    m["shimmer"].setdefault("target", "none")
    m["shimmer"].setdefault("dur", 2.0)
    m["transition"].setdefault("type", "whip")

    a = S["audio"]
    a["bed"].setdefault("bpm", 88)
    a.setdefault("loudness", {"i": -14, "tp": -1.5, "lra": 11})
    a["loudness"].setdefault("lra", 11)

    S.setdefault("overrides", {})
    S["overrides"].setdefault("max_deviation_ratio", 0.25)
    S["overrides"].setdefault("scene_overrides", [])

    pc = S["pacing"]
    pc.setdefault("hook_window_s", 1.5)
    pc.setdefault("min_hold_s", 2.75)
    pc.setdefault("safe", {"y_max": 0.81})
    cc = pc.setdefault("captions", {})
    cc.setdefault("max_words", 4)
    cc.setdefault("max_chars", 21)
    cc.setdefault("min_display_s", 0.5)
    cc.setdefault("tail_s", 0.2)
    cc.setdefault("y_off", 344)

    S.setdefault("identity", {})
    S["_file_id"] = S["id"]
    return S


@functools.lru_cache(maxsize=8)
def load(name):
    return resolve(_read(name))


def pick():
    """Pinned signature look (vault brand law: one identity, no round-robin chameleoning).
    /tmp/reel_tpl_force.json {"name": "..."} overrides for one render."""
    try:
        with open("/tmp/reel_tpl_force.json") as fh:
            _f = (json.load(fh) or {}).get("name")
        if _f and _f in list_templates():
            return _f
    except Exception:
        pass
    _names = list_templates()
    if not _names:
        raise TemplateError("no templates installed in " + TPL_DIR)
    return "vault-editor" if "vault-editor" in _names else _names[0]

def _merge(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def scene_coords(S, kind, beat_idx=0):
    """defaults < template scenes < overrides (mistral #5 + groq/mistral #2)."""
    coords = _merge({}, S["scenes"].get("defaults", {}))
    _merge(coords, S["scenes"].get(kind, {}))
    ratio = float(S["overrides"]["max_deviation_ratio"])
    for ov in S["overrides"]["scene_overrides"]:
        mt = ov.get("match", {})
        if "kind" in mt and mt["kind"] != kind:
            continue
        if "index" in mt and mt["index"] not in (None, beat_idx):
            continue
        for path, val in (ov.get("patch") or {}).items():
            keys = path.split(".")
            d = coords
            for k in keys[:-1]:
                d = d.setdefault(k, {})
            old = d.get(keys[-1])
            if (isinstance(old, (int, float)) and isinstance(val, (int, float))
                    and old and abs(val - old) / abs(old) > ratio):
                val = old + (val - old) * (ratio / (abs(val - old) / abs(old)))
            d[keys[-1]] = val
    return coords


if __name__ == "__main__":
    import sys
    for n in (sys.argv[1:] or list_templates()):
        s = load(n)
        print(f"{s['id']} v{s['version']}: entrance={s['motion']['entrance']} "
              f"transition={s['motion']['transition']['type']}/{s['motion']['transition']['frames']}f "
              f"bed={s['audio']['bed']['bpm']}bpm/{s['audio']['bed']['gain']} "
              f"grade={s['effects']['grade']} OK")
