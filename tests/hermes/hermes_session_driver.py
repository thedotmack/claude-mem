"""Plays one Hermes session through the claude-mem provider, the way Hermes runs it.

Used by tests/integration/hermes-worker-e2e.test.ts. The provider is loaded
from an installed $HERMES_HOME/plugins/claude-mem/ folder the way Hermes loads a
user plugin (its own package namespace, register(ctx)), against a stand-in for
Hermes's `agent.memory_provider`. Worker settings come from CLAUDE_MEM_DATA_DIR,
exactly as on a real machine.

Input (argv[1], JSON): plugin_dir, cwd, session_id, prompt, tool, memory_note, query.
Output (stdout, JSON): the session block and the turn's notes Hermes would inject.
"""

import abc
import importlib.util
import json
import os
import sys
import types


def install_hermes_stub():
    class MemoryProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self):
            ...

        @abc.abstractmethod
        def is_available(self):
            ...

        @abc.abstractmethod
        def initialize(self, session_id, **kwargs):
            ...

        @abc.abstractmethod
        def get_tool_schemas(self):
            ...

    agent = types.ModuleType("agent")
    agent.__path__ = []
    memory_provider = types.ModuleType("agent.memory_provider")
    memory_provider.MemoryProvider = MemoryProvider
    sys.modules["agent"] = agent
    sys.modules["agent.memory_provider"] = memory_provider


def load_user_plugin(plugin_dir):
    namespace = types.ModuleType("_hermes_user_memory")
    namespace.__path__ = []
    sys.modules["_hermes_user_memory"] = namespace
    name = "_hermes_user_memory.claude_mem"
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(plugin_dir, "__init__.py"), submodule_search_locations=[plugin_dir])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    args = json.loads(sys.argv[1])
    install_hermes_stub()
    plugin = load_user_plugin(args["plugin_dir"])

    providers, hooks = [], {}
    ctx = types.SimpleNamespace(
        register_memory_provider=providers.append,
        register_hook=lambda hook, fn: hooks.setdefault(hook, []).append(fn),
    )
    plugin.register(ctx)
    provider = providers[0]
    assert provider.name == "claude-mem" and provider.is_available()

    os.chdir(args["cwd"])
    session_id = args["session_id"]
    provider.initialize(session_id, platform="cli", hermes_home=os.path.dirname(os.path.dirname(args["plugin_dir"])),
                        agent_context="primary")

    block = provider.system_prompt_block()
    provider.on_turn_start(1, args["prompt"])
    notes = provider.prefetch(args["query"], session_id=session_id)
    for fn in hooks.get("post_tool_call", []):
        fn(tool_name=args["tool"]["name"], args=args["tool"]["args"], result=args["tool"]["result"],
           session_id=session_id, tool_call_id="call-1", task_id="", turn_id="turn-1",
           duration_ms=12, status="ok")
    provider.on_memory_write("add", "memory", args["memory_note"])
    provider.sync_turn(args["prompt"], "Done: the flag is wired in.", session_id=session_id)
    provider.on_session_end([{"role": "user", "content": args["prompt"]},
                             {"role": "assistant", "content": "Done: the flag is wired in."}])
    provider.shutdown()

    print(json.dumps({"block": block, "notes": notes}))


if __name__ == "__main__":
    main()
