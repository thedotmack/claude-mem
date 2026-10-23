# OTLP fixtures

| File | Source |
| --- | --- |
| `trace.json` | [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) `examples/trace.json`, byte for byte, at commit `c56093a326ec7d9c2436c778c50f656cb73b718c` (fetched 2026-10-23). Apache License 2.0. |

The magpie and GenAI spans in `tests/wire-gateway/ways-in-otlp.test.ts` are
synthesized there from the attribute names verified in magpie's source at
`e297a8ab2` (`internal/usage/otel_wire.go`, `internal/usage/otel_sessions.go`,
`internal/gateway/otel.go`) and from the GenAI semantic conventions (report 07 §2.8).
