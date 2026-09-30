# IP Boundary

Claude-Mem uses an open-core structure.

## Apache-2.0 components

- Core memory engine
- Claude-Mem Server
- CLI
- SDKs
- REST API schemas
- MCP tools/resources/prompts
- Claude Code adapter
- Generic agent adapters
- Storage adapters
- Reference knowledge agents
- Tests
- Examples
- Public documentation

## Reserved commercial/private areas

These areas are not shipped by Claude-Mem Server v0.1 and should remain outside
the Apache-2.0 public implementation unless maintainers explicitly open-source
them later.

- Magic Recall hosted cloud
- Team/org memory sync
- Admin dashboard
- SSO/SAML/SCIM
- Enterprise RBAC
- Enterprise audit log UI
- DLP/policy engine
- Premium knowledge agents
- Managed evals
- Customer deployment tooling
- Enterprise observability
- Support/SLA workflows
- Internal eval datasets
- Private customer connectors

## Rule

Do not put commercial/private implementation code into the Apache-2.0 public repo
unless the maintainers intentionally decide to open-source it.
