// Bundled CommonJS helpers still require Node built-ins when emitted as ESM.
// Define require in the bundle's own scope; no global mutation is needed.
export const ESM_REQUIRE_BANNER = "import { createRequire as __cmCreateRequire } from 'node:module'; const require = __cmCreateRequire(import.meta.url);";
