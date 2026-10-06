# Pinned DSH helper bundle

This module contains the public `Schema`, `defineTool` and `createUserMessage`
helpers compiled from the package versions in `provenance.json`. Their behavior
and strict tool validation come from the DSH SDK; this plugin does not replace
the host runtime. License texts ship in `dsh/THIRD-PARTY-LICENSES.txt`.

The SDK packages have optional host peer graphs that some package managers
resolve eagerly, including unpublished peers. Keep them out of the root
installer dependencies. The release build consumes this checked-in helper and
does not fetch SDK packages.

To update, install the versions in `provenance.json` into an isolated folder
using npm with `--ignore-scripts --legacy-peer-deps`, set
`DSH_SDK_NODE_MODULES` to that folder's `node_modules`, and run
`node scripts/vendor-dsh-sdk.js`. Review source, provenance, license texts and
the regenerated helper together. The generator inlines the SDK's own manifest
version so a bundled relative manifest read cannot accidentally use the
Claude-Mem package version. Run typecheck, native bundle tests and a clean
marketplace dependency install before accepting an update.
