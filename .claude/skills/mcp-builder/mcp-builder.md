---
name: mcp-builder
description: Orchestrator for building high-quality MCP servers. Guides through research, implementation, review, and evaluation phases. Use when creating new MCP servers or improving existing ones.
---

# MCP Server Builder

Build MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools.

## Workflow

### Phase 1: Research & Planning

1. **Load best practices**: Read `./reference/mcp_best_practices.md`
2. **Load SDK docs** (pick one):
   - TypeScript (recommended): Read `./reference/node_mcp_server.md`
   - Python: Read `./reference/python_mcp_server.md`
3. **Study the MCP spec** if needed: Fetch `https://modelcontextprotocol.io/specification/draft.md`
4. **Study the target API**: Use WebSearch/WebFetch to understand endpoints, auth, and data models
5. **Plan tools**: List endpoints to implement, prioritizing comprehensive API coverage

### Phase 2: Implementation

1. Set up project structure (see language-specific guide)
2. Implement core infrastructure: API client, auth, error handling, pagination
3. Implement tools with:
   - Input validation (Zod/Pydantic)
   - Output schemas (`structuredContent` where possible)
   - Clear descriptions and annotations
   - Async/await, proper error handling, pagination

### Phase 3: Review & Test

1. Review for DRY, consistent errors, type coverage, clear descriptions
2. Build and verify: `npm run build` (TS) or `python -m py_compile` (Python)
3. Test with MCP Inspector: `npx @modelcontextprotocol/inspector`

### Phase 4: Evaluation

1. Load `./reference/evaluation.md`
2. Create 10 complex, realistic, read-only evaluation questions
3. Output as XML evaluation file

## Key Design Principles

- **API coverage over workflow tools** - give agents flexibility to compose operations
- **Clear naming** - consistent prefixes, action-oriented (`github_create_issue`)
- **Concise context** - focused data, filter/paginate support
- **Actionable errors** - guide agents toward solutions
- **Annotations** - mark tools as `readOnlyHint`, `destructiveHint`, etc.

## Tool Implementation Checklist

For each tool, ensure:
- [ ] Input schema with constraints and descriptions
- [ ] Output schema defined where possible
- [ ] Concise tool description
- [ ] Async implementation with error handling
- [ ] Pagination support where applicable
- [ ] Annotations set correctly
