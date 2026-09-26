"""Phase 3: Timing-style rendering of report.json into one self-contained report.html (plan 3.1-3.8).

CSS, body skeleton and every SVG are lifted from /workspace/timing-report-brief/build_mockup.py (cited
per function) and generalised per /workspace/plans/2026-09-25-agent-cost-report-timing-style.md:39-60,
97-128. Dollars everywhere (settled decision 1): one formatter `usd2`, every money figure labeled
ESTIMATE / MEASURED / EXTRAPOLATED with its basis. No <script>, no external fonts or URLs, no jinja2.
"""
import datetime as dt
import html
import math

esc = html.escape

# ---- palette: the six kinds of work (SKILL.md:76), waste, in-progress stripe; defined once (plan 3.3) ----
KINDS = ("Feature", "Bug fix", "Incident", "Maintenance", "Investigation", "Experiment")
COL = {"Feature": "#4FC3F7", "Bug fix": "#FFB14E", "Incident": "#FF8A80", "Maintenance": "#9CCC65", "Investigation": "#A78BFA", "Experiment": "#4DB6AC"}
WASTE, RECOV, GRAY = "#FF6B6B", "#FFD166", "#8e8e93"
STAT = {"shipped": ("Shipped", "ok"), "completed": ("Done", "ok"), "in_progress": ("In progress", "wip"), "abandoned": ("Abandoned", "bad"), "blocked": ("Blocked", "bad")}
TILE_NAMES = {"P1_invented_gates": "Invented gates / asking instead of doing", "tile2": "Made it up, or said done when it wasn't",
              "P2_broke_things": "Broke working things", "P3_wrong_model": "Wrong or expensive model"}
PAT_SHORT = {"P1_invented_gates": "invented gates", "P2_broke_things": "broke things", "P3_wrong_model": "wrong model", "P4_over_engineering": "over-engineering",
             "P5_not_asked": "not asked", "P6_fake_output": "fake output", "P7_false_done": "false done", "P8_wrong_tool": "wrong tool", "P9_bad_outbound": "bad outbound",
             "P10_memory_loss": "rule loss", "P11_jargon": "jargon", "P12_unclear": "unclear", "S1_tool_errors": "tool errors", "S2_hedging": "hedging"}


def usd2(x):
    """The only money formatter in the codebase (plan 3.2): "$1,234.56"."""
    return f"${x:,.2f}"


def tag(kind):
    """ESTIMATE (yellow) | MEASURED (green) | EXTRAPOLATED · low confidence (gray striped) | HEURISTIC | DRAFT."""
    return {"est": '<span class="est">ESTIMATE</span>', "meas": '<span class="est meas">MEASURED</span>',
            "extra": '<span class="est extra">EXTRAPOLATED · low confidence</span>', "heur": '<span class="est heur">heuristic</span>',
            "draft": '<span class="est heur">draft label</span>'}[kind]


def day_label(day, short=False):
    d = dt.date.fromisoformat(day)
    return d.strftime("%b %-d") if short else d.strftime("%a %b %-d")


def date_pill(window, scope):
    """"Sep 18 – 25, 2026 (PT)"; cross-month "Sep 29 – Oct 2, 2026 (PT)"; one day "Sep 12, 2026 (PT)" (mapping #1)."""
    if scope.get("kind") == "session" and not window.get("start_pt"): return "one session"
    a = dt.date.fromisoformat(window["start_pt"]); b = dt.date.fromisoformat(window["end_exclusive_pt"]) - dt.timedelta(days=1)
    if a == b: return a.strftime("%b %-d, %Y (PT)")
    if a.month == b.month: return f"{a.strftime('%b %-d')} – {b.day}, {b.year} (PT)"
    return f"{a.strftime('%b %-d')} – {b.strftime('%b %-d')}, {b.year} (PT)"


def cat_sums(items):
    """Category totals in category order (by attributed dollars desc), all six kinds present."""
    sums = {k: 0.0 for k in KINDS}
    for li in items:
        sums[li["category"] if li["category"] in sums else "Investigation"] = sums.get(li["category"], 0.0) + li["attributed_usd"]
    active = {k: v for k, v in sorted(sums.items(), key=lambda kv: -kv[1]) if v > 0}
    return sums, active


# ---- CSS: build_mockup.py:99-133 plus the additions this report needs; print CSS from timing-style plan:253-263 ----
CSS = """
*{box-sizing:border-box} body{margin:0;background:#e9e9ee;font:14px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Helvetica Neue",Arial,sans-serif;color:#1d1d1f;padding:28px}
.win{width:1384px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 20px 60px #0000002a,0 0 0 1px #0000000f;overflow:hidden;display:grid;grid-template-columns:230px 1fr}
.side{background:linear-gradient(#eef3f6,#e6ecef);border-right:1px solid #dcdfe3;padding:16px 14px}
.lights{display:flex;gap:8px;margin-bottom:22px} .lights i{width:12px;height:12px;border-radius:50%;display:block}
.nav a{display:block;padding:6px 10px;border-radius:7px;color:#333;font-size:13.5px;text-decoration:none} .nav .on{background:#d5dbe0;font-weight:600}
.sh{font-size:11px;color:#8a8f98;font-weight:600;margin:20px 6px 6px;text-transform:uppercase;letter-spacing:.04em}
.srow{display:flex;align-items:center;gap:8px;padding:5px 8px;font-size:13px} .srow .sv{margin-left:auto;background:#dde3e8;border-radius:9px;padding:0 7px;font-size:11.5px;color:#555;white-space:nowrap}
.srow.dim{color:#a3a8b0} .dot{width:11px;height:11px;border-radius:50%;display:inline-block;flex:none} .hollow{border:1.5px solid #c5cad1}
.main{padding:0 0 26px} .bar{display:flex;align-items:center;justify-content:center;gap:14px;height:52px;border-bottom:1px solid #ececf0;color:#555}
.range{background:#f2f2f5;border-radius:7px;padding:5px 60px;font-weight:500} .arrow{color:#b0b0b8;font-size:18px}
.content{padding:22px 28px 0}
.hero{display:grid;grid-template-columns:auto 1fr;gap:36px;align-items:end;margin-bottom:10px}
.big{font-size:64px;font-weight:700;letter-spacing:-.03em;color:#0a84ff;line-height:1}
.est{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;color:#8a5a00;background:#fff3d6;border:1px solid #f3dca0;border-radius:5px;padding:1px 6px;margin-left:8px;vertical-align:middle}
.est.meas{color:#1f7a3a;background:#eefaf1;border-color:#bfe6c8} .est.extra{color:#555;background:repeating-linear-gradient(45deg,#f2f2f5 0 3px,#e3e3e8 3px 6px);border-color:#d5d5da}
.est.heur{color:#555;background:#f2f2f5;border-color:#d5d5da;font-weight:600;letter-spacing:0;text-transform:none}
.herosub{font-size:17px;color:#333;margin-top:8px} .herosub b{color:#1d1d1f}
.meas{font-size:12.5px;color:#6e6e73;margin-top:6px} .basis{font-size:12px;color:#8e8e93;margin-top:4px}
.headline{font-size:21px;font-weight:600;line-height:1.35;color:#1d1d1f;max-width:720px} .headline em{font-style:normal;color:#0a84ff}
.wins-mistakes{border:1px solid #ececf0;border-radius:12px;padding:14px 18px;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
.wins-mistakes h3{margin:0 0 8px;font-size:13.5px;font-weight:600} .wins-mistakes h3 span{font-weight:400;color:#8e8e93}
.mline{font-size:16px;color:#1d1d1f} .mline b{color:#b3261e} .mnote{font-size:12px;color:#8e8e93;margin-top:4px} .mout{font-size:13px;color:#b3261e;margin-top:6px}
.wrow{display:grid;grid-template-columns:22px 1fr 70px 190px;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #f2f2f5;font-size:13px} .wrow .wk{font-size:11px;color:#555;background:#f2f2f5;border-radius:4px;text-align:center}
.wrow .wc{color:#6e6e73;font-size:12px;text-align:right} .wrow a{color:#1d1d1f;text-decoration:none}
.tl{grid-column:1/3} .tlab{font:11px -apple-system,Inter,Arial;fill:#6e6e73} .tnum{font:600 11px -apple-system,Inter,Arial;fill:#1d1d1f} .tred{font:600 11px -apple-system,Inter,Arial;fill:#b3261e}
.ribbonwrap{margin:18px 0 6px} .scale{display:flex;flex-wrap:wrap;font-size:12.5px;color:#444;margin-top:8px;row-gap:4px} .seg{display:flex;align-items:center;gap:6px;padding-right:8px;white-space:nowrap;min-width:max-content}
.muted{color:#8e8e93} .ribbonnote{font-size:12px;color:#6e6e73;margin-top:6px;display:flex;gap:18px} .key{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px}
.grid{display:grid;grid-template-columns:1.05fr 1fr 1fr;gap:18px;margin-top:22px}
.card{border:1px solid #ececf0;border-radius:12px;padding:16px 18px} .card h3{margin:0 0 10px;font-size:13.5px;font-weight:600;color:#1d1d1f} .card h3 span{font-weight:400;color:#8e8e93}
.dn{display:flex;gap:16px;align-items:center} .dnum{font:700 26px -apple-system,Inter,Arial;fill:#1d1d1f} .dsub{font:12px -apple-system,Inter,Arial;fill:#8e8e93}
.lrow{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid #f2f2f5;font-size:13.5px;min-width:170px} .lval{margin-left:auto;color:#555;font-variant-numeric:tabular-nums}
.ctop{font:600 12.5px -apple-system,Inter,Arial;fill:#333} .cnone{font:italic 11.5px -apple-system,Inter,Arial;fill:#a0a0a8} .cax{font:12px -apple-system,Inter,Arial;fill:#6e6e73}
.gwrap{display:flex;gap:14px;align-items:center} .gwrap svg{flex:none} .gnum{font:700 25px -apple-system,Inter,Arial}
.gtext{font-size:13.5px;color:#333} .gtext b{color:#1d1d1f} .chips{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.chip{font-size:12px;background:#eefaf1;color:#1f7a3a;border-radius:20px;padding:3px 10px} .chip.bad{background:#fdeceb;color:#b3261e}
.bstrip{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px} .behavior-tile{border:1px solid #ececf0;border-radius:9px;padding:8px 10px;font-size:12px;color:#333}
.behavior-tile b{display:block;font-size:12.5px;color:#1d1d1f} .behavior-tile .bn{font-size:20px;font-weight:700;color:#b3261e;margin-right:4px} .behavior-tile .bz{color:#1f7a3a;font-weight:600}
.wide{grid-column:1/3} .orow{display:grid;grid-template-columns:14px 14px 1fr 210px 72px 92px;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid #f2f2f5;font-size:13.5px}
.orow summary{display:contents;cursor:pointer} .orow summary::-webkit-details-marker{display:none} .odet{grid-column:1/7;font-size:12.5px;color:#555;padding:4px 0 6px 28px}
.tri{color:#b0b0b8} .obar{height:9px;background:#f4f4f7;border-radius:5px;overflow:hidden} .obar i{display:block;height:100%;border-radius:5px}
.oval{text-align:right;font-variant-numeric:tabular-nums;color:#333;white-space:nowrap} .pill{font-size:11.5px;border-radius:20px;padding:2px 9px;text-align:center} .pill.ok{background:#eefaf1;color:#1f7a3a} .pill.wip{background:#eef4ff;color:#2458c5} .pill.bad{background:#fdeceb;color:#b3261e}
.flag{font-size:11.5px;color:#b3261e;background:#fdeceb;border-radius:5px;padding:1px 6px;margin-left:6px}
.attn ol{margin:0;padding-left:20px} .attn li{margin:0 0 10px;font-size:13.5px} .attn li b{display:block}
.foot{margin-top:18px;display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#6e6e73;border-top:1px solid #ececf0;padding-top:12px;gap:16px}
.disc{border:1px solid #e5e5ea;border-radius:8px;padding:5px 12px;color:#444;text-decoration:none;white-space:nowrap}
#details{margin:22px 28px 0;font-size:12.5px} #details summary{cursor:pointer;font-weight:600;font-size:14px;padding:8px 0} #details h4{margin:18px 0 6px;font-size:13px}
#details table{border-collapse:collapse;width:100%;margin:4px 0 10px} #details th,#details td{text-align:left;padding:4px 6px;border-bottom:1px solid #f2f2f5;vertical-align:top;font-variant-numeric:tabular-nums} #details th{color:#6e6e73;font-weight:600}
#details .ex{color:#555;font-style:italic} #details .id{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#555} #details ul{margin:4px 0;padding-left:18px}
@page { size: 1440px 1300px; margin: 0; }
@media print {
  html, body { background: #fff; padding: 0; }
  body, .win, .side, .card, .chip, .pill, .est, .range, .srow .sv, .behavior-tile { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .win { width: 1384px; margin: 28px auto; box-shadow: none; border: 1px solid #dcdfe3; }
  .card, .orow, details, tr { break-inside: avoid; }
  #details { break-before: page; }
  #details > details > summary { list-style: none; }
  .disc { display: none; }
}
"""


# ---- hero (plan 3.2) ----
def hero(d):
    s, t = d["spend"], d["totals"]
    measured = s.get("agent_measured_usd")
    ref = s.get("measured_reference")
    if isinstance(measured, (int, float)):
        big = f'{usd2(measured)}{tag("meas")}'; basis = esc((ref or {}).get("label") or "measured provider spend") + f' · estimate from tokens {usd2(s["headline_usd"])} for comparison'
        meas = f'Estimate from measured tokens: {usd2(s["headline_usd"])} {tag("est")} · {esc((ref or {}).get("note_taker") or "")}'
    else:
        big = f'{usd2(s["headline_usd"])}{tag("est")}'; basis = esc(s["headline_label"]) + f' · prices fetched {esc((d["pricing"].get("fetched") or "")[:10])} PT'
        if ref and ref.get("usd") is not None:
            meas = f'{esc(ref["label"])}: {usd2(ref["usd"])} {tag("meas")} · {esc(ref.get("note") or "")} · {esc(ref.get("note_taker") or "")}'
        else: meas = "Measured provider spend: unavailable" + (f' ({esc(s["measured_status"])})' if s.get("measured_status") not in (None, "unavailable") else "")
    n = t["finished_outcomes"]; cpo = t.get("cost_per_completed_outcome")
    sub = (f"<b>{n} thing{'s' if n != 1 else ''} finished</b>, about <b>{usd2(cpo)} each</b>" if n and cpo is not None else "<b>Nothing finished yet</b>")
    ex = s.get("extrapolated_unmeasured_usd")
    if ex: extra = f'<div class="meas">+ {usd2(ex)} extrapolated for sessions without transcripts {tag("extra")}</div>'
    elif str(s.get("extrapolation_basis", "")).startswith("all sessions measured"): extra = '<div class="meas">All sessions measured; nothing extrapolated.</div>'
    else: extra = ""
    return (f'<div class="hero" id="overview"><div><div class="big">{big}</div><div class="basis">{basis}</div><div class="herosub">{sub}</div>'
            f'{extra}<div class="meas">{meas}</div></div><div class="headline">{story(d)}</div></div>')


def story(d):
    """Story sentence from data fields only; the useful share is computed here (plan 3.3)."""
    t, s = d["totals"], d["spend"]; w = t.get("waste_rate")
    useful = f"<em>{round((1 - w) * 100, 1)}% of the money went into useful work.</em>" if w is not None else "<em>Useful share: not computed.</em>"
    days = len(d["by_day"]); n = t["finished_outcomes"]; ships = t["ship_events"]; sess = t["real_work_sessions"]
    lead = f"Over {days} day{'s' if days != 1 else ''}, {sess} working session{'s' if sess != 1 else ''} finished {n} thing{'s' if n != 1 else ''}" + (f" and shipped {ships}" if ships else "") + ". "
    m = s.get("mistakes_estimated_usd")
    tail = f" Mistakes cost about {usd2(m)} of that (estimated)." if m else ""
    return lead + useful + tail


# ---- Wins vs mistakes (plan 3.8) ----
def wins_mistakes(d):
    s, w = d["spend"], d["wins"]; b = d.get("behavior") or {}
    m = s.get("mistakes_estimated_usd")
    if m is None:
        line = '<div class="mline">Cost of mistakes: not computed (behavior pass off)</div>'
    else:
        mins = s.get("mistakes_alex_minutes"); known = s.get("mistakes_alex_minutes_known_n", 0); k = s.get("mistakes_unmeasured_n", 0)
        parts = [f'Cost of mistakes: <b>≈{usd2(m)}</b>{tag("est")}', f'{s.get("mistakes_episodes_n", 0)} episode{"s" if s.get("mistakes_episodes_n", 0) != 1 else ""}',
                 (f'{mins:g} min of your time' if known else 'your time: unknown')] + ([f'{k} unmeasured'] if k else [])
        line = f'<div class="mline">{" · ".join(parts)}</div><div class="mnote">{esc(s.get("mistakes_basis", ""))}</div>'
    ob = b.get("outbound") or {}
    if ob.get("incidents"): line += f'<div class="mout">{ob["incidents"]} send{"s" if ob["incidents"] != 1 else ""} to {ob.get("recipients", 0)} recipient{"s" if ob.get("recipients", 0) != 1 else ""} without your approval</div>'
    items = w.get("items", []); measured = w.get("cost_status") == "session_linked"
    order = sorted(items, key=lambda i: -(i.get("usd") or 0)) if measured else sorted(items, key=lambda i: i.get("ts_pt") or "", reverse=True)
    rows = []
    for i in order[:5]:
        if i.get("usd") is None: cost = esc(i.get("cost_label") or "unmeasured")
        else: cost = f'≈{usd2(i["usd"])} {tag("extra") if i.get("cost_basis") == "extrapolated" else tag("est")} · session-linked'
        title = f'<a href="#win-{esc(i["win_id"])}">{esc(i["title"][:80])}</a>'
        rows.append(f'<div class="wrow"><span class="wk">{esc(i["kind"])}</span><span>{title}</span><span class="muted">{esc(day_label(i["day_pt"], True)) if i.get("day_pt") else ""}</span><span class="wc">{cost}</span></div>')
    more = f'<div class="mnote">+{len(items) - 5} more in Details</div>' if len(items) > 5 else ""
    if not items: rows.append('<div class="mnote">No merged PR or published version found in this window.</div>')
    if measured and w.get("unattributed_usd") is not None: rows.append(f'<div class="wrow"><span></span><span>Not tied to a win</span><span></span><span class="wc">≈{usd2(w["unattributed_usd"])} {tag("est")}</span></div>')
    elif items: rows.append('<div class="mnote">win costs unmeasured (G11: no fallback estimate)</div>')
    return (f'<div class="wins-mistakes"><div><h3>Mistakes <span>· low, same-session figure</span></h3>{line}</div>'
            f'<div><h3>Wins shipped <span>· {"most expensive first" if measured else "newest first"}</span></h3>{"".join(rows)}{more}</div>'
            f'<div class="tl">{timelines(d)}</div></div>')


def timelines(d):
    """Two timelines on one PT-day axis (plan 3.8c): wins as dots above, mistakes as red bars below. Links to Details."""
    days = [x["day_pt"] for x in d["by_day"]]; wbd = {x["day_pt"]: x for x in d["timeline"].get("wins_by_day", [])}; mbd = {x["day_pt"]: x for x in d["timeline"].get("mistakes_by_day", [])}
    n = max(len(days), 1); colw = 90 if n <= 10 else max(30, int(900 / n)); W = 40 + n * colw; H = 196; axis = 96
    maxm = max([x.get("usd") or 0 for x in mbd.values()] or [0]); maxw = max([x.get("count") or 0 for x in wbd.values()] or [0])
    out = [f'<line x1="20" x2="{W - 10}" y1="{axis}" y2="{axis}" stroke="#e5e5ea"/>']
    partial = d["window"].get("partial_last_day")
    for i, day in enumerate(days):
        cx = 40 + i * colw + colw / 2; wd = wbd.get(day, {}); md = mbd.get(day, {})
        c = wd.get("count") or 0
        if c:
            r = 6 + (10 * c / maxw if maxw else 0)
            val = usd2(wd["usd"]) if wd.get("usd") is not None else "unmeasured"
            out.append(f'<a href="#win-{esc(wd["win_ids"][0])}"><circle cx="{cx:.1f}" cy="{axis - 30:.1f}" r="{r:.1f}" fill="#34C759"/><text x="{cx:.1f}" y="{axis - 26:.1f}" text-anchor="middle" class="tnum" fill="#fff">{c}</text>'
                       f'<text x="{cx:.1f}" y="{axis - 50:.1f}" text-anchor="middle" class="tlab">{esc(val)}</text></a>')
        else: out.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{axis - 6}" y2="{axis}" stroke="#c5cad1"/>')
        usd = md.get("usd") or 0
        if usd:
            h = max(4, 50 * usd / maxm) if maxm else 4
            out.append(f'<a href="#mistakes-{esc(day)}"><rect x="{cx - 14:.1f}" y="{axis + 2}" width="28" height="{h:.1f}" rx="3" fill="{WASTE}"/><text x="{cx:.1f}" y="{axis + h + 14:.1f}" text-anchor="middle" class="tred">{usd2(usd)}</text></a>')
        elif md.get("unmeasured_n"):
            out.append(f'<a href="#mistakes-{esc(day)}"><rect x="{cx - 14:.1f}" y="{axis + 2}" width="28" height="12" rx="3" fill="none" stroke="{WASTE}" stroke-dasharray="3 2"/><text x="{cx:.1f}" y="{axis + 26}" text-anchor="middle" class="tlab">{md["unmeasured_n"]} unmeasured</text></a>')
        else: out.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{axis}" y2="{axis + 6}" stroke="#c5cad1"/>')
        if md.get("outbound_incidents"): out.append(f'<text x="{cx + 18:.1f}" y="{axis + 12}" class="tred">✉{md["outbound_incidents"]}</text>')
        lab = day_label(day, True) + (" · partial" if (partial and i == n - 1) else "")
        out.append(f'<text x="{cx:.1f}" y="{H - 4}" text-anchor="middle" class="cax">{esc(lab)}</text>')
    out.append(f'<text x="20" y="14" class="tlab">wins above the line (count; cost unmeasured until sessions are linked) · mistakes below (low, estimated, per day)</text>')
    return f'<svg viewBox="0 0 {W} {H}" width="100%" height="{H}" preserveAspectRatio="xMinYMid meet">{"".join(out)}</svg>'


# ---- cost ribbon: build_mockup.py:23-45 generalised (mapping #8-12) ----
def ribbon(d, cats):
    items = [li for li in d["line_items"] if not li.get("trivial") and li["attributed_usd"] > 0]
    total = sum(li["attributed_usd"] for li in items)
    if not items or total <= 0: return '<div class="ribbonwrap"><div class="mnote">No priced work in this window.</div></div>'
    order = list(cats); W = 1000; x = 0; blocks = []; stripes = set()
    for li in sorted(items, key=lambda l: (order.index(l["category"]) if l["category"] in order else 99, -l["attributed_usd"])):
        w = li["attributed_usd"] / total * W; c = COL.get(li["category"], GRAY)
        ip = li["status"] == "in_progress"; key = li["category"].replace(" ", "")
        if ip: stripes.add(key)
        fill = f"url(#stripe-{key})" if ip else c
        blocks.append(f'<rect x="{x + 1:.1f}" y="0" width="{max(w - 2, 0):.1f}" height="56" rx="7" fill="{fill}"><title>{esc(li["title"][:80])} · {usd2(li["attributed_usd"])}</title></rect>')
        if li.get("wasted_cost"):
            ww = min(li["wasted_cost"] / total * W, max(w - 2, 0))
            blocks.append(f'<rect x="{x + w - 1 - ww:.1f}" y="0" width="{ww:.1f}" height="56" fill="url(#hatch)"/>')
        x += w
    defs = [f'<pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="{WASTE}"/><rect width="3" height="7" fill="#ffffff66"/></pattern>']
    for key in sorted(stripes):
        c = COL.get(next(k for k in KINDS if k.replace(" ", "") == key), GRAY)
        defs.append(f'<pattern id="stripe-{key}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="{c}"/><rect width="4" height="8" fill="#ffffff88"/></pattern>')
    waste_total = d["spend"].get("mistakes_estimated_usd", d["totals"].get("wasted_usd", 0.0))
    svg = f'<svg class="ribbon" viewBox="0 0 {W} 56" width="100%" height="56" preserveAspectRatio="none" data-waste-usd="{waste_total:.2f}"><defs>{"".join(defs)}</defs>{"".join(blocks)}</svg>'
    scale = "".join(f'<div style="width:{v / total * 100:.2f}%" class="seg"><span class="dot" style="background:{COL.get(c, GRAY)}"></span><b>{esc(c)}</b> {usd2(v)} <span class="muted">· {v / total * 100:.0f}%</span></div>' for c, v in cats.items())
    keys = ['<span>Each block is one piece of work, sized by estimated cost.</span>']
    if any(li.get("wasted_cost") for li in items): keys.append(f'<span><i class="key" style="background:{WASTE}"></i>wasted turns ({usd2(waste_total)} {tag("est")})</span>')
    if stripes: keys.append('<span><i class="key" style="background:repeating-linear-gradient(45deg,#4FC3F7 0 3px,#d6f1fd 3px 6px)"></i>still in progress</span>')
    return f'<div class="ribbonwrap">{svg}<div class="scale">{scale}</div><div class="ribbonnote">{"".join(keys)}</div></div>'


# ---- sidebar: build_mockup.py:134-145 generalised (mapping #13-17) ----
def sidebar(d, sums, cats):
    t = d["totals"]; total = d["spend"].get("total_estimate_usd") or sum(li["attributed_usd"] for li in d["line_items"])   # the same figure as the hero
    rows = [f'<div class="srow"><span class="dot" style="background:{GRAY}"></span><b>All work</b><span class="sv">{usd2(total)}</span></div>']
    for c, v in cats.items(): rows.append(f'<div class="srow"><span class="dot" style="background:{COL[c]}"></span>{esc(c)}<span class="sv">{usd2(v)}</span></div>')
    for c in KINDS:
        if c not in cats: rows.append(f'<div class="srow dim"><span class="dot hollow"></span>{esc(c)}<span class="sv">—</span></div>')
    top = sorted((li for li in d["line_items"] if not li.get("trivial")), key=lambda l: -l["attributed_usd"])[:6]
    sess = "".join(f'<div class="srow" title="{esc(li["content_session_id"])}">{esc(li["work_item_id"])} · {esc(day_label(li["date_pt"], True))}</div>' for li in top)
    k = t["sessions"] - len(top)
    if k > 0: sess += f'<div class="srow dim">+{k} more in Details</div>'
    models = sorted(d["by_model"], key=lambda m: -m["agent_estimated_usd"])[:4]
    mrows = "".join(f'<div class="srow" style="font-size:12px;color:#555;display:block">{esc(m["model"].split("/")[-1])}<br><span class="muted">{"list price" if m.get("priced") else "unpriced"} · {usd2(m["agent_estimated_usd"])}</span></div>' for m in models)
    return (f'<aside class="side"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>'
            f'<div class="nav"><a class="on" href="#overview">Overview</a><a href="#outcomes">Outcomes</a><a href="#details">Details &amp; evidence</a></div>'
            f'<div class="sh">Kinds of work</div>{"".join(rows)}<div class="sh">Sessions</div>{sess}<div class="sh">Models</div>{mrows}<div class="sh">Other seats</div><div class="srow dim" title="{esc((d["spend"].get("grok_bot_usage") or {}).get("reason") or "")}">Grok Bot usage: unavailable</div></aside>')


# ---- donut: build_mockup.py:47-56 (mapping #18-19) ----
def donut(d, cats):
    total = sum(cats.values())
    if total <= 0: return '<div class="mnote">No priced work.</div>'
    R, SW = 70, 34; C = 2 * math.pi * R; off = 0; arcs = []
    for c, v in cats.items():
        L = v / total * C
        arcs.append(f'<circle r="{R}" cx="100" cy="100" fill="none" stroke="{COL[c]}" stroke-width="{SW}" stroke-dasharray="{max(L - 2, 0):.2f} {C - max(L - 2, 0):.2f}" stroke-dashoffset="{-off:.2f}" transform="rotate(-90 100 100)"/>')
        off += L
    word = "measured" if isinstance(d["spend"].get("agent_measured_usd"), (int, float)) else "estimated"
    svg = f'<svg viewBox="0 0 200 200" width="190" height="190">{"".join(arcs)}<text x="100" y="96" text-anchor="middle" class="dnum">{usd2(total)}</text><text x="100" y="116" text-anchor="middle" class="dsub">{word}</text></svg>'
    rows = "".join(f'<div class="lrow"><span class="dot" style="background:{COL[c]}"></span><span class="lname">{esc(c)}</span><span class="lval">{usd2(v)}</span></div>' for c, v in cats.items())
    return f'<div class="dn">{svg}<div>{rows}</div></div>'


# ---- day columns: build_mockup.py:58-73, column count and viewBox from by_day (mapping #20) ----
def day_chart(d, cats):
    days = d["by_day"]; n = max(len(days), 1); colw = 95 if n <= 3 else max(22, min(60, int(330 / n))); bw = int(colw * 0.62); W = 40 + n * colw; H = 150
    perday = {x["day_pt"]: {} for x in days}
    for li in d["line_items"]:
        if li.get("trivial") or li["date_pt"] not in perday: continue
        perday[li["date_pt"]][li["category"]] = perday[li["date_pt"]].get(li["category"], 0.0) + li["attributed_usd"]
    maxd = max([sum(v.values()) for v in perday.values()] or [0]); cols = [f'<line x1="20" x2="{W - 10}" y1="{H + 10}" y2="{H + 10}" stroke="#e5e5ea"/>']
    partial = d["window"].get("partial_last_day")
    for i, x in enumerate(days):
        day = x["day_pt"]; cx = 30 + i * colw; y = H + 10; s = sum(perday[day].values())
        for c in cats:
            v = perday[day].get(c, 0)
            if v and maxd:
                h = v / maxd * H; y -= h
                cols.append(f'<rect x="{cx}" y="{y:.1f}" width="{bw}" height="{max(h - 1.5, 0):.1f}" rx="3" fill="{COL[c]}"/>')
        lab = usd2(s) if s else "no agent work"
        if partial and i == n - 1: lab += " · partial"
        if n <= 3 or s: cols.append(f'<text x="{cx + bw / 2:.1f}" y="{(y - 7) if s else H + 2:.1f}" text-anchor="middle" class="{"ctop" if s else "cnone"}" font-size="{12.5 if n <= 3 else 9}">{esc(lab if n <= 3 or s else "")}</text>')
        else: cols.append(f'<text x="{cx + bw / 2:.1f}" y="{H + 2}" text-anchor="middle" class="cnone" font-size="7">no agent work</text>')
        if n <= 12 or i % max(1, n // 8) == 0: cols.append(f'<text x="{cx + bw / 2:.1f}" y="{H + 30}" text-anchor="middle" class="cax" font-size="{12 if n <= 3 else 9}">{esc(day_label(day, True))}</text>')
    return f'<svg viewBox="0 0 {W} {H + 40}" width="100%" height="{H + 40}">{"".join(cols)}</svg>'


# ---- useful ring: build_mockup.py:87-92, color bands (mapping #21-23) + behavior strip (plan 2B.5 / 3.3) ----
def ring(d):
    t = d["totals"]; w = t.get("waste_rate"); prod = 1 - w if w is not None else None
    RR = 54; CC = 2 * math.pi * RR; pct = (prod or 0) * 100
    color = "#34C759" if pct >= 90 else "#FFB14E" if pct >= 70 else "#FF6B6B"
    num = f"{pct:.1f}%" if prod is not None else "n/a"
    svg = (f'<svg viewBox="0 0 140 140" width="112" height="112"><circle r="{RR}" cx="70" cy="70" fill="none" stroke="#f0f0f3" stroke-width="14"/>'
           f'<circle r="{RR}" cx="70" cy="70" fill="none" stroke="{color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="{(prod or 0) * CC:.2f} {CC:.2f}" transform="rotate(-90 70 70)"/>'
           f'<text x="70" y="78" text-anchor="middle" class="gnum" fill="{color}">{num}</text></svg>')
    fe = d.get("failure_economics") or []
    if fe:
        top = max(fe, key=lambda f: f["wasted_usd"] + f["recovery_usd"])
        sent = (f'<b>Useful work.</b> {esc(top["failure_type"])} touched {top["sessions"]} session{"s" if top["sessions"] != 1 else ""}: {usd2(top["wasted_usd"])} wasted, {usd2(top["recovery_usd"])} spent recovering {tag("est")}.')
        others = [f["failure_type"] for f in fe if f is not top]
        sent += f'<br><span class="muted">Also seen: {esc(", ".join(others[:4]))}.</span>' if others else '<br><span class="muted">No other failure signals.</span>'
    else: sent = '<b>Useful work.</b> No failure signals in the drafted labels.<br><span class="muted">Labels are keyword drafts until reviewed.</span>'
    blocked = sum(1 for li in d["line_items"] if li["status"] == "blocked"); unauth = sum(1 for f in fe if f["failure_type"] == "Unauthorized action" for _ in range(f["sessions"]))
    chips = (f'<span class="chip{" bad" if blocked else ""}">{"✕" if blocked else "✓"} {blocked} blocked</span>'
             f'<span class="chip{" bad" if unauth else ""}">{"✕" if unauth else "✓"} {unauth} unauthorized attempts</span>')
    return f'<div class="gwrap">{svg}<div class="gtext">{sent}</div></div><div class="chips">{chips}</div>{behavior_strip(d)}'


def behavior_strip(d):
    b = d.get("behavior")
    if not b: return '<div class="mnote" style="margin-top:10px">Behavior pass not run.</div>'
    pats = {p["key"]: p for p in b["patterns"]}
    groups = [("P1_invented_gates", ["P1_invented_gates"]), ("tile2", ["P6_fake_output", "P7_false_done"]), ("P2_broke_things", ["P2_broke_things"]), ("P3_wrong_model", ["P3_wrong_model"])]
    tiles = []
    for key, members in groups:
        ps = [pats[m] for m in members if m in pats and pats[m]["placement"] == "tile"]
        if not ps: continue
        count = sum(p["count"] for p in ps); low = sum(p["low_usd"] or 0 for p in ps); unm = sum(p["unmeasured_n"] for p in ps); mins = sum(p.get("alex_minutes") or 0 for p in ps)
        if count and not low and unm and not (key == "P3_wrong_model" and ps[0].get("delta_usd")): money = "unmeasured"   # never $0 for unmeasured (2B.11)
        elif key == "P3_wrong_model": money = f'≈{usd2(ps[0].get("delta_usd") or 0)} more than the default model {tag("est")}' if count else ""
        else: money = f'≈{usd2(low)} {tag("est")}' if count else ""
        body = (f'<span class="bn">{count}</span>{money}' if count else '<span class="bz">none found</span>')
        extra = (f' · {mins:g} min of your time' if mins else "") + (f' · +{unm} unmeasured' if unm else "")
        tiles.append(f'<div class="behavior-tile"><b>{esc(TILE_NAMES[key])}</b>{body}{esc(extra)} {tag("heur") if count else ""}</div>')
    return f'<div class="bstrip">{"".join(tiles[:4])}</div>'


# ---- outcomes: build_mockup.py:75-85, rows fold as native <details> (mapping #24-26) ----
def outcomes(d):
    items = [li for li in d["line_items"] if not li.get("trivial")]
    if not items: return '<div class="mnote">No work items.</div>'
    maxc = max(li["attributed_usd"] for li in items) or 1; rows = []
    for li in sorted(items, key=lambda l: -l["attributed_usd"]):
        c = COL.get(li["category"], GRAY); st = STAT.get(li["status"], (li["status"], "wip")); bw = li["attributed_usd"] / maxc * 100
        flag = ""
        if li["failure_type"]: flag = '<span class="flag">⟲ recovery</span>' if li["failure_type"] == "Recovery after miss" else f'<span class="flag">⚠ {esc(li["failure_type"])}</span>'
        draft = tag("draft") if li["label_source"] == "keyword" else ""
        basis = tag("extra") if li["cost_basis"] == "extrapolated" else tag("meas") if li["cost_basis"] == "measured_provider" else tag("est")
        if li["attributed_usd"] == 0 and li.get("unpriced_calls"): money = "unpriced (model not in price list)"
        elif not li.get("has_transcript") and li.get("cost_extrapolated") is None: money = "unmeasured"; basis = ""
        else: money = usd2(li["attributed_usd"]) + basis
        bc = sorted(li.get("behavior_counts", {}).items(), key=lambda kv: -kv[1])
        det = (f'{esc(li["notes"])} · evidence {", ".join(map(str, li["evidence_ids"][:12]))}{" …" if len(li["evidence_ids"]) > 12 else ""} · session <span class="id">{esc(li["content_session_id"])}</span>'
               f' · confidence {esc(li["confidence"])} · risk {esc(li["risk_exposure"])}' + (f' · wasted {usd2(li["wasted_cost"])}' if li["wasted_cost"] else "")
               + (f' · behavior: {esc(", ".join(f"{PAT_SHORT.get(k, k)} ×{v}" for k, v in bc[:4]))}' if bc else ""))
        rows.append(f'<details class="orow"><summary><span class="tri">›</span><span class="dot" style="background:{c}"></span><span class="otitle">{esc(li["title"][:90])} {flag}{draft}</span>'
                    f'<span class="obar"><i style="width:{bw:.1f}%;background:{c}{"80" if st[1] == "wip" else ""}"></i></span><span class="oval">{money}</span>'
                    f'<span class="pill {st[1]}">{esc(st[0])}</span></summary><div class="odet">{det}</div></details>')
    return "".join(rows)


def attention(d):
    att = (d.get("attention") or [])[:3]
    if not att: return "<ol><li><b>Nothing flagged.</b><span class=\"muted\">No waste, unfinished work, or unpriced model stood out.</span></li></ol>"
    return "<ol>" + "".join(f'<li><b>{esc(a["text"])}</b></li>' for a in att) + "</ol>"


# ---- Details (plan 3.4, 3.8): everything folded; --print opens it ----
def _table(headers, rows):
    return "<table><tr>" + "".join(f"<th>{h}</th>" for h in headers) + "</tr>" + "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows) + "</table>"


def _unmeasured(li):
    """No transcript and no extrapolation ratio: the spend is unknown, never a measured zero (money-labeling rules)."""
    return not li.get("has_transcript") and li.get("cost_extrapolated") is None


def _li_money(li):
    return "unmeasured" if _unmeasured(li) else usd2(li["attributed_usd"])


def _li_basis(li):
    return "unmeasured (no ratio)" if _unmeasured(li) else esc(li["cost_basis"])


def details(d, open_):
    s, t, b = d["spend"], d["totals"], d.get("behavior") or {}
    out = [f'<details id="details" {"open" if open_ else ""}><summary>Details &amp; evidence</summary>']
    # wins (3.8) and mistakes by day, first so fragment links land near the top
    out.append("<h4>Wins</h4>")
    gs = (d["wins"].get("sources") or {}).get("github_merged_prs")
    if gs:
        rep = "; ".join(f'{esc(r)}: {esc(v["status"])}' + (f' ({v["found"]} found)' if v.get("found") is not None else "") for r, v in (gs.get("repos") or {}).items())
        out.append(f'<div class="muted">GitHub merged PRs (read-only gh pr list): {esc(gs["status"])} · {rep}</div>')
    for w in d["wins"].get("items", []):
        cost = "unmeasured (session not linked to PR)" if w.get("usd") is None else f'≈{usd2(w["usd"])} {tag("extra") if w.get("cost_basis") == "extrapolated" else tag("est")} · {esc(w.get("cost_basis") or "")}'
        tok = w.get("tokens"); tok_s = ", ".join(f"{k} {v:,}" for k, v in tok.items()) if tok else "—"
        out.append(f'<div id="win-{esc(w["win_id"])}"><b>{esc(w["win_id"])}</b> · {esc(w["kind"])} · {esc(w["title"])} · {esc(w.get("ts_pt") or "")}'
                   + (f' · <a href="{esc(w["url"])}">{esc(w["url"])}</a>' if w.get("url") else "")
                   + f'<br><span class="muted">sources {esc(", ".join(w.get("sources") or []))} · cost {cost} · sessions {esc(", ".join(w.get("sessions") or []) or "—")} · tokens {tok_s} · attribution {esc(d["wins"].get("attribution_method") or "none")} · evidence {esc(", ".join(map(str, w.get("evidence_ids") or [])) or "—")}</span></div>')
    if not d["wins"].get("items"): out.append('<div class="muted">No wins found (merged PR, published version, or praise).</div>')
    if d["wins"].get("dropped"): out.append(f'<div class="muted">{len(d["wins"]["dropped"])} candidate(s) dropped: ' + esc("; ".join(str(x.get("reason")) for x in d["wins"]["dropped"][:6])) + "</div>")
    out.append("<h4>Mistakes by day</h4>")
    if s.get("mistakes_high_usd") is not None:
        out.append(f'<div class="muted">Upper bound: ≈{usd2(s["mistakes_high_usd"])} (adds 60-minute redo windows and project-wide fallback; {esc(s.get("mistakes_high_label", ""))}). '
                   f'Low figure in the summary: {usd2(s["mistakes_estimated_usd"])} over {s.get("mistakes_turns_n", 0)} turns' + (f', {usd2(s["mistakes_unmatched_usd"])} of it in transcripts with no claude-mem session' if s.get("mistakes_unmatched_usd") else "") + ".</div>")
    eps = {e["episode_id"]: e for e in b.get("episodes", [])}
    for x in d["timeline"].get("mistakes_by_day", []):
        pats = ", ".join(f"{PAT_SHORT.get(k, k)} {usd2(v)}" for k, v in sorted(x.get("by_pattern", {}).items(), key=lambda kv: -kv[1]))
        top = x.get("top_examples", []); shown = {e.get("episode_id") for e in top if e.get("episode_id") in eps}
        ex = "".join(f'<li>{esc(PAT_SHORT.get(e["pattern"], e["pattern"]))} · {esc(eps[e["episode_id"]]["cost_status"]) if e.get("episode_id") in eps else "top example"} · <span class="id">{esc(e["content_session_id"])}</span> · {esc(e["ts_pt"])}'
                     + (f' · <span class="ex">{esc(eps[e["episode_id"]]["excerpt"])}</span>' if e.get("episode_id") in eps else "") + "</li>" for e in top)
        day_eps = [e for e in b.get("episodes", []) if e["day_pt"] == x["day_pt"] and e["episode_id"] not in shown]   # each episode once
        ex += "".join(f'<li>{esc(PAT_SHORT.get(e["pattern"], e["pattern"]))} · {esc(e["cost_status"])} · <span class="id">{esc(e["session"])}</span> · {esc(e["ts_pt"])} · <span class="ex">{esc(e["excerpt"])}</span></li>' for e in day_eps)
        out.append(f'<div id="mistakes-{esc(x["day_pt"])}"><b>{esc(day_label(x["day_pt"]))}</b> · low {usd2(x["usd"])} · high {usd2(x["high_usd"])} · {x["turns_n"]} turns · {x["unmeasured_n"]} unmeasured episode(s) · {x["alex_minutes"]:g} Alex-min · {x["outbound_incidents"]} outbound'
                   + (f'<br><span class="muted">{esc(pats)}</span>' if pats else "") + (f"<ul>{ex}</ul>" if ex else "") + "</div>")
    # behavior pattern table (2B.5)
    if b:
        rows = [(esc(p["key"]), esc(p["name"]), p["count"], ("incidents × recipients: %s × %s" % (p.get("incidents", 0), p.get("recipients", 0))) if p["key"] == "P9_bad_outbound" else usd2(p["low_usd"] or 0),
                 "—" if p["high_usd"] is None else usd2(p["high_usd"]), f'{p.get("alex_minutes") or 0:g}', p["unmeasured_n"], esc(p.get("detection", "H")), esc(p["failure_type"] or "—"), esc(p["placement"]), esc(p["count_basis"])) for p in b["patterns"]]
        out.append("<h4>Behavior patterns</h4>" + _table(["key", "pattern", "count", "low (est.)", f"high ({esc(b['patterns'][0].get('high_label', ''))})", "Alex-min", "unmeasured", "basis", "failure type", "place", "count basis"], rows))
        for p in b["patterns"]:
            if p.get("examples"): out.append(f'<div><b>{esc(p["name"])}</b> examples<ul>' + "".join(f'<li><span class="id">{esc(e["content_session_id"] or "")}</span> {esc(e.get("ts_pt") or "")} · {esc(e["basis"])} · <span class="ex">{esc(e["excerpt"])}</span> · {esc(e["label_source"])}</li>' for e in p["examples"][:10]) + "</ul></div>")
        out.append("<h4>Rule effectiveness</h4>")
        rr = b.get("rule_effectiveness") or []
        if rr: out.append(_table(["rule", "landed", "pattern", "before (eps / prompts / per 100)", "after", "verdict", "episodes after"],
                                [(esc(r.get("name") or r["rule_key"]), r["landed_pt"], esc(r.get("pattern") or "—"), _side(r.get("before")), _side(r.get("after")), esc(r["verdict"].replace("_", " ")), esc(", ".join(r.get("episode_ids_after") or []) or "—")) for r in rr]))
        else: out.append('<div class="muted">No HARD rule landed inside or within 7 days before this window.</div>')
        pd = b.get("permission_denials") or {}
        at = b.get("author_tags"); at_s = esc(str(at)) if isinstance(at, str) else f'human {at.get("human", 0)}, bot {at.get("bot", 0)}, unknown {at.get("unknown", 0)}'
        out.append(f'<div>Permission denials (blocked by a rule, not priced): {pd.get("count", 0)} · user turns tagged: {at_s} · label sources: {esc(str(dict(b.get("label_sources") or {})))} · '
                   f'classifier: {"ran, " + usd2(b["classifier"].get("spend_usd") or 0) + " (separate)" if b.get("classifier", {}).get("ran") else "off"} · coverage: {esc(str(b.get("coverage")))}</div>')
    # money and pricing
    out.append("<h4>Spend</h4>" + _table(["field", "value"], [
        ("agent, estimated from measured tokens", f'{usd2(s["agent_estimated_usd"])} {tag("est")}'), ("agent, measured by provider", esc(str(s.get("agent_measured_usd") if s.get("agent_measured_usd") is not None else s.get("measured_status")))),
        ("extrapolated (sessions without transcripts)", (f'{usd2(s["extrapolated_unmeasured_usd"])} {tag("extra")}' if s.get("extrapolated_unmeasured_usd") is not None else "unavailable (no measured session to derive a ratio from)") + f' · {esc(s.get("extrapolation_basis") or "")}'),
        ("total estimate", f'{usd2(s["total_estimate_usd"])} = {usd2(s["agent_estimated_usd"])} + ' + (usd2(s["extrapolated_unmeasured_usd"]) if s.get("extrapolated_unmeasured_usd") is not None else "unavailable")),
        ("Note-taker (observer) cost, separate", f'{usd2(s["observer_note_taker_est_usd"])} {tag("est")} · never added to the agent figures'),
        ("Grok Bot usage", "unavailable (Cursor exposes seat usage only on the plan screen) · sources checked: " + esc(", ".join((s.get("grok_bot_usage") or {}).get("checked_sources") or []))), ("pricing", f'{esc(d["pricing"].get("source") or "")} fetched {esc(d["pricing"].get("fetched") or "")} · 1h rule: {esc(d["pricing"].get("rule_1h") or "")}')]))
    out.append("<h4>Models</h4>" + _table(["source", "model", "calls", "input", "output", "cache write 5m", "cache write 1h", "cache read", "est. $", "$/MTok in/out/read/write/write1h"],
                                       [(esc(m["source"]), esc(m["model"]), m["calls"], f'{m["input"]:,}', f'{m["output"]:,}', f'{m["cache_write_5m"]:,}', f'{m["cache_write_1h"]:,}', f'{m["cache_read"]:,}', usd2(m["agent_estimated_usd"]),
                                         esc("/".join(str(m["prices_usd_per_mtok"].get(k)) for k in ("input", "output", "cache_read", "cache_write", "cache_write_1h")) if m.get("prices_usd_per_mtok") else "unpriced")) for m in d["by_model"]]))
    out.append("<h4>Failure accounting</h4>" + (_table(["failure type", "sessions", "attributed", "wasted", "recovery", "items"], [(esc(f["failure_type"]), f["sessions"], usd2(f["attributed_usd"]), usd2(f["wasted_usd"]), usd2(f["recovery_usd"]), esc(", ".join(f["work_item_ids"][:12]))) for f in d.get("failure_economics") or []]) if d.get("failure_economics") else '<div class="muted">none</div>'))
    out.append("<h4>Line items</h4>" + _table(["id", "title", "status", "category", "label", "attributed", "basis", "wasted", "tokens in/out/cw5/cw1h/read", "model", "device", "sessions", "evidence ids"],
                                           [(esc(li["work_item_id"]), esc(li["title"][:70]), esc(li["status"]), esc(li["category"]), esc(li["label_source"]), _li_money(li), _li_basis(li), usd2(li["wasted_cost"]),
                                             "/".join(f'{li["agent_tokens"][k]:,}' for k in ("input", "output", "cache_write_5m", "cache_write_1h", "cache_read")), esc(li["model"] or "—"), esc(", ".join(li["device"])),
                                             f'<span class="id">{esc(li["content_session_id"])}<br>{esc(li["session_ids"][0])}</span>', esc(", ".join(map(str, li["evidence_ids"][:10])) + (" …" if len(li["evidence_ids"]) > 10 else ""))) for li in d["line_items"]]))
    out.append("<h4>Devices</h4>" + _table(["device", "id (short hash)", "sessions", "est. $", "extrapolated $"], [(esc(x["device"]), esc(x["id_hash"]), x["sessions"], usd2(x["agent_estimated_usd"]), usd2(x["extrapolated_usd"])) for x in d["by_device"]]))
    um = d["unmatched_transcripts"]
    out.append(f'<h4>Unmatched transcripts</h4><div class="muted">{um["count"]} transcript session(s) on this box matched no claude-mem session: {usd2(um["usd"])} {tag("est")}, {um["tokens"]:,} tokens, counted in the totals. {esc(um.get("note") or "")}</div>')
    out.append("<h4>Unpriced models</h4>" + (_table(["model", "role", "calls", "tokens", "reason"], [(esc(x["model"]), esc(x["role"]), x["calls"], f'{x["tokens"]:,}', esc(x["reason"])) for x in d["unpriced_models"]]) if d["unpriced_models"] else '<div class="muted">none</div>'))
    out.append(f'<h4>Labels</h4><div>{d["labels"]["reviewed"]} of {d["labels"]["total"]} labels reviewed; the rest are keyword drafts marked "draft label". Trivial sessions (no observations, no transcript, under a minute): {t.get("trivial_sessions", 0)}.</div>')
    out.append("<h4>Honesty rules</h4><ul><li>Every dollar figure is labeled ESTIMATE, MEASURED, or EXTRAPOLATED with its basis.</li><li>Measured provider spend is never shown as zero when it is unavailable.</li>"
               "<li>Completed outcomes are the unit of work; Rework is a failure type, never a work kind.</li><li>The note-taker's own tokens are priced separately and never added to the agent headline.</li>"
               "<li>Keyword labels are drafts until reviewed; behavior counts are heuristic until reviewed or classified.</li><li>Grok Bot usage and Mac transcripts show unavailable or extrapolated (low confidence), never zero.</li>"
               "<li>The mistakes headline is the low, same-session figure; the upper bound stays in this section.</li></ul>")
    out.append('<div class="muted">Files: <a href="line-items.csv">line-items.csv</a> · <a href="evidence.json">evidence.json</a> · <a href="report.json">report.json</a></div></details>')
    return "".join(out)


def _side(x):
    if not x: return "—"
    return f'{x["episodes"]} / {x["human_prompts"]} / {x["per_100"] if x["per_100"] is not None else "not enough data"}'


# ---- page ----
def page(d, print_mode=False):
    items = [li for li in d["line_items"] if not li.get("trivial")]
    sums, cats = cat_sums(items)
    foot = ("All dollar figures are estimates from measured token counts × OpenRouter list price unless tagged MEASURED. Provider-measured spend is unavailable for these sessions, so it is never shown as zero. "
            "Behavior counts are heuristic until reviewed.")
    body = (f'<div class="win">{sidebar(d, sums, cats)}<main class="main"><div class="bar"><span class="arrow">‹</span><span class="range">{esc(date_pill(d["window"], d["scope"]))}</span><span class="arrow">›</span></div>'
            f'<div class="content">{hero(d)}{wins_mistakes(d)}{ribbon(d, cats)}'
            f'<div class="grid"><div class="card"><h3>Where the money went <span>· by kind of work</span></h3>{donut(d, cats)}</div>'
            f'<div class="card"><h3>Day by day <span>· estimated</span></h3>{day_chart(d, cats)}</div>'
            f'<div class="card"><h3>How much was useful</h3>{ring(d)}</div>'
            f'<div class="card wide" id="outcomes"><h3>What got done <span>· most expensive first</span></h3>{outcomes(d)}</div>'
            f'<div class="card attn"><h3>Worth your attention</h3>{attention(d)}</div></div>'
            f'<div class="foot"><span>{foot} Generated {esc(d.get("generated_at_pt") or "")}.</span><a class="disc" href="#details">› Details: evidence IDs, sessions, tokens, CSV</a></div>'
            f'</div>{details(d, print_mode)}</main></div>')
    return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Cost Report — {esc(date_pill(d["window"], d["scope"]))}</title><style>{CSS}</style></head><body>{body}</body></html>'


# ---- entry points (plan 3.5) ----
def render_file(inp, outdir, print_mode=False):
    import json, os
    with open(inp) as fh: d = json.load(fh)
    os.makedirs(outdir, exist_ok=True)
    name = "report.print.html" if print_mode else "report.html"
    path = os.path.join(outdir, name)
    with open(path, "w") as fh: fh.write(page(d, print_mode))
    return path


def pdf(outdir, chrome="google-chrome"):
    """google-chrome --headless=new ... --print-to-pdf; if Chrome is missing: 'PDF skipped, HTML is canonical' (SKILL.md:165)."""
    import os, shutil, subprocess
    src = os.path.join(outdir, "report.print.html")
    if not os.path.exists(src):
        rp = os.path.join(outdir, "report.json")
        if not os.path.exists(rp): raise FileNotFoundError(f"{src} not found and no report.json to render it from")
        render_file(rp, outdir, print_mode=True)
    exe = shutil.which(chrome)
    if not exe: return None, "PDF skipped, HTML is canonical (google-chrome not found)"
    out = os.path.join(outdir, "report.pdf")
    profile = os.path.join(os.path.abspath(outdir), ".chrome-profile")   # a private profile; the box has no D-Bus session
    cmd = [exe, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", f"--user-data-dir={profile}", "--timeout=60000",
           f"--print-to-pdf={out}", "--no-pdf-header-footer", "file://" + os.path.abspath(src)]
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    except subprocess.TimeoutExpired: return None, "PDF skipped, HTML is canonical (chrome timed out)"
    finally: shutil.rmtree(profile, ignore_errors=True)
    if r.returncode != 0 or not os.path.exists(out): return None, f"PDF skipped, HTML is canonical (chrome exit {r.returncode}: {r.stderr.strip()[-200:]})"
    return out, f"pdf: {out}"
