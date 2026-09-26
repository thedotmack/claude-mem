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
.ribbonwrap{margin:18px 0 6px} .scale{display:flex;font-size:12.5px;color:#444;margin-top:8px} .seg{display:flex;align-items:center;gap:6px;padding-right:8px;white-space:nowrap;overflow:visible}
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
    if isinstance(measured, (int, float)):
        big = f'{usd2(measured)}{tag("meas")}'; basis = f'measured provider spend · estimate from tokens {usd2(s["headline_usd"])} for comparison'
        meas = f'Estimate from measured tokens: {usd2(s["headline_usd"])} {tag("est")}'
    else:
        big = f'{usd2(s["headline_usd"])}{tag("est")}'; basis = esc(s["headline_label"]) + f' · prices fetched {esc((d["pricing"].get("fetched") or "")[:10])} PT'
        meas = "Measured provider spend: unavailable"
    n = t["finished_outcomes"]; cpo = t.get("cost_per_completed_outcome")
    sub = (f"<b>{n} thing{'s' if n != 1 else ''} finished</b>, about <b>{usd2(cpo)} each</b>" if n and cpo is not None else "<b>Nothing finished yet</b>")
    ex = s.get("extrapolated_unmeasured_usd")
    extra = f'<div class="meas">+ {usd2(ex)} extrapolated for sessions without transcripts {tag("extra")}</div>' if ex else ""
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
    return (f'<div class="wins-mistakes"><div><h3>Cost of mistakes <span>· low, same-session figure</span></h3>{line}</div>'
            f'<div><h3>Wins shipped <span>· {"most expensive first" if measured else "newest first"}</span></h3>{"".join(rows)}{more}</div>'
            f'<div class="tl">{timelines(d)}</div></div>')


def timelines(d):
    """Two timelines on one PT-day axis (plan 3.8c): wins as dots above, mistakes as red bars below. Links to Details."""
    days = [x["day_pt"] for x in d["by_day"]]; wbd = {x["day_pt"]: x for x in d["timeline"].get("wins_by_day", [])}; mbd = {x["day_pt"]: x for x in d["timeline"].get("mistakes_by_day", [])}
    n = max(len(days), 1); colw = 90; W = 40 + n * colw; H = 150; axis = 84
    maxm = max([x.get("usd") or 0 for x in mbd.values()] or [0]); maxw = max([x.get("count") or 0 for x in wbd.values()] or [0])
    out = [f'<line x1="20" x2="{W - 10}" y1="{axis}" y2="{axis}" stroke="#e5e5ea"/>']
    partial = d["window"].get("partial_last_day")
    for i, day in enumerate(days):
        cx = 40 + i * colw + colw / 2; wd = wbd.get(day, {}); md = mbd.get(day, {})
        c = wd.get("count") or 0
        if c:
            r = 6 + (10 * c / maxw if maxw else 0)
            val = usd2(wd["usd"]) if wd.get("usd") is not None else "unmeasured"
            out.append(f'<a href="#win-{esc(wd["win_ids"][0])}"><circle cx="{cx:.1f}" cy="{axis - 34:.1f}" r="{r:.1f}" fill="#34C759"/><text x="{cx:.1f}" y="{axis - 30:.1f}" text-anchor="middle" class="tnum" fill="#fff">{c}</text>'
                       f'<text x="{cx:.1f}" y="{axis - 52:.1f}" text-anchor="middle" class="tlab">{esc(val)}</text></a>')
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
    out.append(f'<text x="20" y="{axis - 60}" class="tlab">wins</text><text x="20" y="{axis + 60}" class="tlab">mistakes (low, estimated)</text>')
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
