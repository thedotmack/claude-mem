# Ragtime

> **Status**: Not yet implemented

Ragtime is a planned feature for claude-mem that will enable advanced timeline analysis and automated workflow orchestration.

## Why It's Not Ready Yet

Ragtime requires a fully functional **modes system** to work properly. The modes system (implemented in PR #412) provides:

- Mode inheritance and configuration loading
- Type-safe observation metadata
- Dynamic prompt injection based on workflow context
- Language-specific behavior

Now that the modes system is complete, Ragtime can be fully scripted out in a future release.

## License

This directory is licensed under the **PolyForm Noncommercial License 1.0.0**.

See [LICENSE](./LICENSE) for full terms.

### What this means:

- ✅ You can use ragtime for noncommercial purposes
- ✅ You can modify and distribute it
- ❌ You cannot use it for commercial purposes without permission

### Why a different license?

The main claude-mem repository is licensed under AGPL 3.0, but ragtime uses the more restrictive PolyForm Noncommercial license to ensure it remains freely available for personal and educational use while preventing commercial exploitation.

---

For questions about commercial licensing, please contact the project maintainer.
