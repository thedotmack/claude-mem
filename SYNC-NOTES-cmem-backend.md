# SYNC NOTES → cmem-pro backend (cmem.ai)

Contract delta required by the claude-mem installer's install-first login flow
(branch `almondine-detective`, plan `plans/2026-08-26-install-first-login-flow.md`).
The installer already tolerates BOTH the old and new shapes — ship the backend
change whenever ready, nothing breaks in either order.

## What changes

`POST /api/pro/trial/poll` (`{ pairing_id, secret }`) — the `200 ready` response:

```jsonc
{
  "status": "ready",
  "user_id": "…",                       // unchanged
  "setup_token": "…",                   // unchanged — cloud-sync token
  "hub_url": "…",                       // unchanged
  "memory_key": "cm_pro_…",             // NEW — see below
  "memory_base_url": "https://…",       // NEW, optional
  "memory_model": "cmem-observer",      // NEW, optional
  "plan": "trial" | "pro" | "none",     // NEW
  "trial": { "ends_at": "ISO-8601" }    // unchanged — present while the free week is active
}
```

1. **`memory_key` is minted for EVERY login.** Login alone must satisfy the
   poll: the key maps to an OpenRouter provisioned key server-side and simply
   carries a **$0 balance** until the user subscribes. No card, no checkout
   required to reach `ready`.
2. **Checkout no longer gates `ready`.** The `awaiting_checkout` pending stage
   becomes optional — the installer still renders it if sent (it shows a
   generic "waiting for checkout in the browser" spinner), but the server may
   go straight `awaiting_login` → (`awaiting_approval` →) `ready`.
3. **`memory_base_url` / `memory_model`** are optional overrides. When absent
   the installer defaults to `<origin>/api/inference/v1` and `cmem-observer`
   (its `CMEM_PRO_BASE_URL` / `CMEM_PRO_MODEL` constants).
4. **`plan`** tells the installer what to say after sign-in:
   - `trial` — free week active (send `trial.ends_at` too),
   - `pro` — already subscribed,
   - `none` — logged in, not subscribed, key has a $0 balance.

## Backward compatibility (already handled client-side)

- Old shape (no `memory_key` / `plan`): the installer uses `setup_token` as
  the memory key against the gateway defaults and assumes `plan: "trial"` —
  exactly today's behavior.
- `POST /api/pro/trial/start` is unchanged (`{email, source, device_name}` →
  `{pairing_id, secret, poll_interval, user_code}`).
- Non-200/202/404/410 handling, the 30-minute pairing TTL, the device
  user-code approval step, and one-shot credential delivery are all unchanged.
