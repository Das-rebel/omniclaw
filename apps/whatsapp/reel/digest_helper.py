"""Latest vault saves for digest — called by server.js handleDigest.
v2: source-aware, powers 3-section digests (Twitter / Instagram / DMs).
"""
import sqlite3, json, re

con = sqlite3.connect('/opt/vault-sync/vault.db')
con.row_factory = sqlite3.Row
cur = con.cursor()

def fetch(src, n=3):
    cur.execute(
        "SELECT title, content, url, created_at, source FROM bookmarks "
        "WHERE is_active=1 AND source=? AND title NOT LIKE 'dm%' AND length(content) > 80 "
        "ORDER BY created_at DESC LIMIT ?", (src, n))
    rows = [dict(r) for r in cur.fetchall()]
    if src == 'instagram':
        # v7.3 guard: real posts/reels only — the IG scraper files DM-request spam under
        # source='instagram' with /direct/ URLs; and only feature items that actually have text.
        rows = [r for r in rows if re.search(r'instagram\.(com|co)/(p|reel|tv)/', r.get('url') or '')]
    return rows

twitter, instagram = fetch('twitter'), fetch('instagram')

# DM counts — kind from metadata JSON (same rule as build_brief dm_lines)
inbox, req = 0, 0
cur.execute("SELECT metadata FROM bookmarks WHERE source_id LIKE 'dm:%'")
for (meta_s,) in cur.fetchall():
    try:
        kind = (json.loads(meta_s or "{}") or {}).get("kind")
    except Exception:
        kind = None
    kind = kind or ("inbox" if '"inbox"' in (meta_s or "") else "request")
    if kind == "inbox":
        inbox += 1
    else:
        req += 1

totals = {}
for src in ("twitter", "instagram"):
    cur.execute("SELECT COUNT(*) FROM bookmarks WHERE is_active=1 AND source=? AND title NOT LIKE 'dm%'", (src,))
    totals[src] = cur.fetchone()[0]

print(json.dumps({
    "twitter": twitter, "instagram": instagram,
    "dm_inbox": inbox, "dm_pending": req,
    "totals": totals,
}))
