# Native ODS integration

Claude-Mem connects to **ODS itself**: its admitted conversation requests,
validated activity events, and final verified deliveries. It needs no agent
plugin and makes no changes to the underlying agent's configuration.

The ODS extension runs a local Claude-Mem worker, stores memory in
`data/claude-mem`, and uses the existing ODS model gateway (`ods/current`) for
observation extraction. SQLite search is enabled; Chroma and telemetry are off
in this lightweight deployment.

## Install from source

This is a source integration, not an entry already published in ODS's catalog.
The patch is qualified against ODS 3.0.0 at
`Osmantic/ODS@c99f52822f2c37813fd880004f964ca83dfc5a35`.
The installer checks every patch hunk before touching the selected ODS tree.

```bash
# From a Claude-Mem checkout; the directory can be the ODS repo or its ods/ folder.
node ods/install.mjs --ods-dir /path/to/ODS --check
node ods/install.mjs --ods-dir /path/to/ODS
```

This prepares the native source changes and installs the disabled service
definition. Existing application data and secrets are preserved. Repeating the
command is safe; a locally modified integration is reported instead of replaced.

Set these values in the ODS installation's `.env`:

```dotenv
ODS_CLAUDE_MEM_ENABLED=true
ODS_CLAUDE_MEM_PORT=37778
ODS_CLAUDE_MEM_SCOPE=conversation
```

Deploy the modified ODS tree through its existing local installation workflow
so the updated ingress module and environment reach the host service. The
source patch adds them to ODS's own deployment step. Copying the extension
directory alone does **not** update an already running ingress process.
Then enable the service:

```bash
ods enable claude-mem
ods start claude-mem
```

The worker's viewer and API are at `http://127.0.0.1:37778`; its health endpoint
is `/api/health`. The API has no authentication, so its exposure is limited by
network placement:

- **Host:** the published port binds `127.0.0.1` only. Any local process or
  user on the ODS host can read, write and delete memory through it, the same
  as a desktop Claude-Mem worker.
- **Containers:** the worker is not on the shared `ods-network`. It sits on a
  private Compose network whose only other member is `claude-mem-gateway`.
  Other ODS services and extensions cannot reach the worker's API.
- **Gateway:** `claude-mem-gateway` (`gateway.mjs`) is the one container on
  `ods-network`. It relays the worker's observer calls to LiteLLM and answers
  the dashboard's `GET /api/health` probe from the worker. It forwards no other
  worker request.

`LITELLM_KEY` is passed to the existing local model gateway inside the ODS
network. This integration does not choose a new model or change ODS's
local/cloud routing policy.

## Memory scope

`conversation` is the default. Each ODS conversation has its own persistent
memory, including when the underlying session has been replaced or compacted.

For a personal, single-owner ODS appliance, set
`ODS_CLAUDE_MEM_SCOPE=installation` to recall memories across its chats. This
intentionally shares one `ods` project across all conversations on that
installation. It is not an account-isolation boundary for a multi-user service.
Scope comes only from operator configuration, never from model output.

## What the integration records

| ODS event | Claude-Mem operation |
| --- | --- |
| New admitted request | Session init with the native request ID and `platformSource: ods` |
| Before model execution | Retrieve the five most recent observations in scope as a bounded, model-only reference |
| Validated terminal activity event | Store `ODSActivity` with its source and status |
| Verified final delivery | Store `ODSConversation`, preserve the verification separately, summarize |
| Cached response replay | No new capture or model execution |
| Conversation deletion | Fence queued writes and request deletion of the exact Claude-Mem session |

The integration captures ODS's **public activity projection**, not raw tools
hidden inside an agent runtime. Activity records are labeled as observations,
not independent proof of success. Final messages use ODS's verified delivery.
Streaming and non-streaming requests use the same native boundary.
Both modes collect a final activity snapshot before the final answer is stored.
Private blocks are removed before capture size limits are applied; nested and
unfinished private blocks stay private. An entirely private prompt skips capture.

Memory reads and writes have short timeouts. Unavailable memory leaves chat
usable and emits a sanitized warning. Failed writes stop that turn's write
chain; they are not reported as saved and are not silently replayed. This
version does not provide an offline outbox. Native request and tool-use IDs
support the worker's existing duplicate detection.

The released worker refuses to delete a session while its observer is active.
ODS reports `memory-deletion-unconfirmed` in that case, rather than claiming all
copies were erased. Retry deletion once the observer is idle. A session that
was never captured or was already deleted is treated as absent.

## Validation

```bash
node --test ods/test/native.test.mjs
ODS_TEST_REPO=/path/to/ODS node --test ods/test/install.test.mjs
ODS_TEST_ROOT=/path/to/ODS/ods node --test ods/test/ingress.test.mjs
# The last command requires the native integration to be installed in that tree.

# Exercise the actual bundled worker, its SQLite store and a local test observer.
# Install plugin dependencies first, as for ordinary Claude-Mem development.
BUN_BIN=/path/to/bun node ods/test/worker-smoke.mjs
```

The tests cover capture/recall, privacy skips, bounded responses, failed writes,
conversation isolation, deletion, install rollback, local-edit protection, and
both ODS response modes. The worker smoke test uses deterministic model output;
it does not measure the quality of any particular local model.

## Remove

```bash
ods disable claude-mem
node ods/install.mjs --ods-dir /path/to/ODS --uninstall
```

Redeploy ODS's restored ingress source and remove the three optional settings
from `.env`. The installer restores only source files it owns and verifies that
they have not changed. `data/claude-mem` remains available for backup or a later
reinstall. Delete that directory separately only when you intend to erase it.
If removal is interrupted by a filesystem error, fix the error and repeat
`--uninstall`. Its receipt tracks removal intent and still protects local edits.
