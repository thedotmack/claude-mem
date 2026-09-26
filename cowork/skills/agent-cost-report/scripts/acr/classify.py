"""Optional cheap classifier pass (plan 2B.4; G5 and G8 settled): OFF by default, enabled per run with
--classify, hard cap $2.00 per run, regular inference OPENROUTER_API_KEY only (never a management key,
never read from a settings file). It only sees candidates the heuristics could not settle. Its own
spend is reported separately ("classifier cost (separate)") and never added to agent cost.

Run path: OpenRouter chat completions (OpenAI-compatible, https://openrouter.ai/docs/api-reference/chat-completion),
urllib only. Input per candidate: the flagged text plus one message before and after, scrubbed, cut to
1,500 characters. Output JSON {label: yes|no|unsure, pattern, reason (≤20 words)}.
"""
import json
import os
import random
import urllib.request

from . import behavior, costs

DEFAULT_MODEL = "anthropic/claude-haiku-4.5"
CAP_USD = 2.00
URL = "https://openrouter.ai/api/v1/chat/completions"
CANDIDATE_CHARS = 1500
EST_IN_TOKENS = 1600   # plan 2B.4 sizing
EST_OUT_TOKENS = 60
QUESTIONS = {
    "frustration": "Is this human message a genuine complaint about the agent's work? Answer yes or no.",
    "P1_invented_gates": "Was this a real gate (something only Alex can do: cold Allow click, payment method, wet-ink signature, phone 2FA) or an invented one? yes = invented.",
    "P4_over_engineering": "Was the extra scope asked for? yes = NOT asked for (over-engineering).",
    "P5_not_asked": "Do the actions match the last human instruction? yes = they do NOT match.",
    "P6_fake_output": "Is each number in this text sourced from a tool result shown? yes = unsourced.",
    "P12_unclear": "Which pattern (P1..P11) does this complaint belong to, if any?",
    "S2_hedging": "Was the answer already available to the agent when it hedged? yes = available (hedge counts).",
    "praise": "Is this praise sincere (yes) or sarcastic (no)?",
}


class ClassifierError(RuntimeError):
    pass


def estimate_usd(n, rate):
    return costs.usd(int(n * (EST_IN_TOKENS * rate["input_usd_per_mtok"] + EST_OUT_TOKENS * rate["output_usd_per_mtok"])))


def _call(model, prompt, key, url=URL, timeout=60):
    body = json.dumps(dict(model=model, max_tokens=120, temperature=0,
                           messages=[dict(role="system", content="Reply with one JSON object: {\"label\": \"yes|no|unsure\", \"pattern\": \"...\", \"reason\": \"<=20 words\"}"),
                                     dict(role="user", content=prompt)])).encode()
    req = urllib.request.Request(url, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp: d = json.load(resp)
    u = d.get("usage") or {}
    txt = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "{}"
    try: out = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    except Exception: out = dict(label="unsure", pattern=None, reason="unparseable")
    return out, int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)


def run(candidates, rate, model=DEFAULT_MODEL, cap_usd=CAP_USD, key=None, call=_call, seed=0):
    """candidates: [{id, kind, text, before, after}]. Returns (labels {id: {...}}, summary).
    Prints the estimate first; over the cap it classifies a stratified random sample and scales up."""
    key = key if key is not None else os.environ.get("OPENROUTER_API_KEY")
    if not key: raise ClassifierError("OPENROUTER_API_KEY is not set (regular inference key, G5); classifier not run")
    if not rate: raise ClassifierError(f"no list price for {model}; classifier not run")
    est = estimate_usd(len(candidates), rate); sampled = False; chosen = list(candidates)
    print(f"classifier: {len(candidates)} candidates, estimated ${est:.2f} at list, cap ${cap_usd:.2f}")
    if est > cap_usd:
        per = estimate_usd(1, rate) or 0.001; n = max(1, int(cap_usd / per * 0.9))
        rnd = random.Random(seed); by_kind = {}
        for c in candidates: by_kind.setdefault(c["kind"], []).append(c)
        chosen = []
        for kind, cs in by_kind.items():
            k = max(1, round(n * len(cs) / len(candidates))); chosen += rnd.sample(cs, min(k, len(cs)))
        sampled = True
    labels = {}; spent = 0; in_tok = out_tok = 0; last = 0; stopped = False
    cap_x1e6 = int(round(cap_usd * 1e6)); per_x1e6 = int(EST_IN_TOKENS * rate["input_usd_per_mtok"] + EST_OUT_TOKENS * rate["output_usd_per_mtok"])
    for c in chosen:
        if spent + max(per_x1e6, last) > cap_x1e6: stopped = True; break         # hard stop: never send a request the cap cannot pay for
        prompt = f"{QUESTIONS.get(c['kind'], QUESTIONS['P12_unclear'])}\n\nBEFORE: {behavior.scrub(c.get('before',''), 400)}\nFLAGGED: {behavior.scrub(c['text'], CANDIDATE_CHARS)}\nAFTER: {behavior.scrub(c.get('after',''), 400)}"
        out, i, o = call(model, prompt, key); in_tok += i; out_tok += o
        last = int(i * rate["input_usd_per_mtok"] + o * rate["output_usd_per_mtok"]); spent += last
        labels[c["id"]] = dict(label=out.get("label", "unsure"), pattern=out.get("pattern"), reason=str(out.get("reason", ""))[:120], label_source="classifier")
    scale = (len(candidates) / len(labels)) if (sampled and labels) else 1.0
    return labels, dict(ran=True, model=model, spend_usd=costs.usd(spent), cap_usd=cap_usd, sampled_n=len(labels) if sampled else 0,
                        candidates_n=len(candidates), estimated_usd=est, scale=round(scale, 2), input_tokens=in_tok, output_tokens=out_tok, stopped_at_cap=stopped,
                        note="estimated from a sample of %d" % len(labels) if sampled else None)
