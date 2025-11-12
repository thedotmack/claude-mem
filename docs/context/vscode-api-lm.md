# VS Code API – Language Model (`lm`) Namespace

Excerpt captured from `https://code.visualstudio.com/api/references/vscode-api#lm` using markitdown MCP on 2025-11-12.

## Overview

The `vscode.lm` namespace exposes APIs for interacting with language models inside Visual Studio Code. It allows extensions to register tools, select chat models, invoke tools, and surface MCP servers so that agent mode can compose complex responses.

### Available Tools

- `vscode.lm.tools`: Readonly array of [`LanguageModelToolInformation`](https://code.visualstudio.com/api/references/vscode-api#LanguageModelToolInformation).
  - Lists all tools registered via `vscode.lm.registerTool`.
  - Tools can be invoked programmatically with `vscode.lm.invokeTool` when their inputs satisfy the declared schema.

### Events

- `vscode.lm.onDidChangeChatModels`: Fires when the set of available chat models changes. Extensions should re-query models after this event.

### Functions

#### `vscode.lm.invokeTool(name, options, token?)`

Invokes a tool by name with a given input payload.

- Validates input against the schema declared by the tool.
- When called from a chat participant, pass the `toolInvocationToken` so the chat UI associates results with the correct conversation.
- Returns a [`LanguageModelToolResult`](https://code.visualstudio.com/api/references/vscode-api#LanguageModelToolResult) composed of text and optional prompt-tsx parts.
- Tool results can be preserved across turns by storing them in `ChatResult.metadata` and retrieving them later from `ChatResponseTurn.result`.

#### `vscode.lm.registerLanguageModelChatProvider(vendor, provider)`

Registers a [`LanguageModelChatProvider`](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatProvider).

- Requires a matching `languageModelChatProviders` contribution in `package.json`.
- `vendor` must be globally unique (for example `copilot` or `openai`).
- Returns a `Disposable` to unregister the provider.

#### `vscode.lm.registerMcpServerDefinitionProvider(id, provider)`

Publishes Model Context Protocol servers for the editor.

- Requires a `contributes.mcpServerDefinitionProviders` entry in `package.json`.
- Enables dynamic discovery of MCP servers and tools when users submit chat messages.
- Returns a `Disposable` that unregisters the provider.

#### `vscode.lm.registerTool(name, tool)`

Registers a [`LanguageModelTool`](https://code.visualstudio.com/api/references/vscode-api#LanguageModelTool) implementation with the runtime.

- Tool must also appear in `package.json -> contributes.languageModelTools`.
- Registered tools appear in `vscode.lm.tools` and can be used by any extension.

#### `vscode.lm.selectChatModels(selector?)`

Returns an array of [`LanguageModelChat`](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChat) instances matching a selector.

- Selector can be broad (by vendor or family) or narrow (by exact model ID).
- Handle scenarios where zero models are available.
- Persisted model references should be refreshed when `onDidChangeChatModels` fires.

## Usage Notes

- Extensions should gracefully handle missing models or tools.
- Tool invocation responses can include multiple parts; integrate them using prompt-tsx or by constructing `LanguageModelToolResultPart` objects.
- When providing MCP servers or tools, ensure proper contribution points exist in `package.json`.

_Fetched on 2025-11-12 via markitdown MCP._
