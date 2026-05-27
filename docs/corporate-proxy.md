# Corporate proxy and custom CA

If you run `claude-mem` from inside a corporate network that requires an outbound HTTP/HTTPS proxy — Zscaler, Cisco Umbrella, on-prem SSL-intercepting firewalls (EANDIS/Fluvius, etc.) — the worker daemon needs an explicit configuration step before it can reach `api.anthropic.com`.

## Why it doesn't "just work"

`claude-mem` deliberately strips proxy environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, …) from the parent shell when it spawns the persistent worker daemon. This is intentional — a session-only proxy silently latching onto a long-lived background daemon is a footgun (the proxy goes away, the daemon keeps trying to reach it). See `src/supervisor/env-sanitizer.ts`.

The trade-off is that, on machines where the proxy is the *only* path to the internet, the daemon's SDK subprocess fails every API call with `SSL certificate verification failed` (the corporate firewall MITMs outbound TLS and presents a self-signed cert that's not in the standard CA bundle).

## Explicit opt-in via `~/.claude-mem/.env`

Declare the proxy and CA bundle in `~/.claude-mem/.env`. The worker reads this file at startup and re-injects the declared values into its own `process.env` (and into the env used to spawn subprocesses).

Example for a typical corporate setup:

```ini
# ~/.claude-mem/.env

# Outbound HTTP/HTTPS proxy
HTTPS_PROXY=http://10.87.0.4:3128/
HTTP_PROXY=http://10.87.0.4:3128/
NO_PROXY=localhost,127.0.0.1,::1,.internal,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16

# CA bundle that trusts the corporate root CA. Make sure your IT-provisioned
# root CA is in this bundle (typically /usr/local/share/ca-certificates/ + run
# `sudo update-ca-certificates`).
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

Recognized keys:

| Key                    | Used by                                        |
|------------------------|------------------------------------------------|
| `HTTPS_PROXY`          | Node fetch (SDK CLI), Python (`requests`)      |
| `HTTP_PROXY`           | Same                                            |
| `NO_PROXY`             | Bypass list — keep `localhost` for the worker  |
| `SSL_CERT_FILE`        | OpenSSL, Python `ssl`                          |
| `REQUESTS_CA_BUNDLE`   | Python `requests`                              |
| `CURL_CA_BUNDLE`       | `curl`                                          |
| `NODE_EXTRA_CA_CERTS`  | Node `tls` (extends, does not replace, the built-in bundle) |

Lowercase variants (`https_proxy` / `http_proxy` / `no_proxy`) are mirrored automatically for curl-family tooling.

## Verifying

After saving `~/.claude-mem/.env`, restart the worker:

```bash
claude-mem restart
```

The worker logs a one-line confirmation at startup when the passthrough fires:

```
[INFO] [SYSTEM] Applied corporate proxy/CA passthrough from ~/.claude-mem/.env { keys: ["HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] }
```

Check the daemon's environment:

```bash
W=$(jq -r .pid ~/.claude-mem/worker.pid)
cat /proc/$W/environ | tr '\0' '\n' | grep -E "HTTPS_PROXY|NODE_EXTRA"
```

And confirm the SDK subprocess (the `claude` CLI spawned by the worker) inherits the same values via `cat /proc/<sdk-pid>/environ`.

## Notes

- Parent-shell values (a `HTTPS_PROXY` set in your interactive shell when you run `claude-mem start`) still take precedence over `.env` values — passthrough only fills in keys that are not already set.
- The `~/.claude-mem/.env` file is also where Anthropic / Gemini / OpenRouter credentials live. Permissions are set to `0700` on the data directory; treat the file as sensitive.
- If your IT team distributes the corporate CA as a `.crt` file, the canonical install is:

  ```bash
  sudo cp corporate-root.crt /usr/local/share/ca-certificates/
  sudo update-ca-certificates
  ```

  After that, `/etc/ssl/certs/ca-certificates.crt` contains the corp CA and pointing `NODE_EXTRA_CA_CERTS` at it is enough.
