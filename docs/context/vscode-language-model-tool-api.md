# Language Model Tool API

Language model tools enable you to extend the functionality of a large language model (LLM) in chat with domain-specific capabilities. To process a user's chat prompt, [agent mode](/docs/copilot/chat/chat-agent-mode) in VS Code can automatically invoke these tools to perform specialized tasks as part of the conversation.

By contributing a language model tool in your VS Code extension, you can extend the agentic coding workflow while also providing deep integration with the editor. Extension tools are one of three types of tools available in VS Code, alongside [built-in tools and MCP tools](/docs/copilot/chat/chat-tools.md#types-of-tools).

In this extension guide, you learn how to create a language model tool by using the Language Model Tools API and how to implement tool calling in a chat extension.

You can also extend the chat experience with specialized tools by contributing an [MCP server](/api/extension-guides/ai/mcp). See the [AI Extensibility Overview](/api/extension-guides/ai/ai-extensibility-overview) for details on the different options and how to decide which approach to use.

> **Tip**
> For information about using tools as an end user, see [Use tools in chat](/docs/copilot/chat/chat-tools.md).

## What is tool calling in an LLM?

A language model tool is a function that can be invoked as part of a language model request. For example, you might have a function that retrieves information from a database, performs some calculation, or calls an online API. When you contribute a tool in a VS Code extension, agent mode can then invoke the tool based on the context of the conversation.

The LLM never actually executes the tool itself, instead the LLM generates the parameters that are used to call your tool. It's important to clearly describe the tool's purpose, functionality, and input parameters so that the tool can be invoked in the right context.

The following diagram shows the tool-calling flow in agent mode in VS Code. See [Tool-calling flow](#tool-calling-flow) for details about the specific steps involved.

![Diagram that shows the Copilot tool-calling flow](/assets/api/extension-guides/ai/tools/copilot-tool-calling-flow.png)

Read more about [function calling](https://platform.openai.com/docs/guides/function-calling) in the OpenAI documentation.

## Why implement a language model tool in your extension?

Implementing a language model tool in your extension has several benefits:

- **Extend agent mode** with specialized, domain-specific tools that are automatically invoked as part of responding to a user prompt. For example, enable database scaffolding and querying to dynamically provide the LLM with relevant context.
- **Deeply integrate with VS Code** by using the broad set of extension APIs. For example, use the [debug APIs](/api/extension-guides/debugger-extension) to get the current debugging context and use it as part of the tool's functionality.
- **Distribute and deploy** tools via the Visual Studio Marketplace, providing a reliable and seamless experience for users. Users don't need a separate installation and update process for your tool.

You might consider implementing a language model tool with an [MCP server](/api/extension-guides/ai/mcp) in the following scenarios:

- You already have an MCP server implementation and also want to use it in VS Code.
- You want to reuse the same tool across different development environments and platforms.
- Your tool is hosted remotely as a service.
- You don't need access to VS Code APIs.

Learn more about the [differences between tool types](/docs/copilot/chat/chat-tools.md#types-of-tools).

## Create a language model tool

Implementing a language model tool consists of two main parts:

1. Define the tool's configuration in the `package.json` file of your extension.
2. Implement the tool in your extension code by using the [Language Model API reference](/api/references/vscode-api#lm)

You can get started with a [basic example project](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample).

### 1. Static configuration in `package.json`

The first step to define a language model tool in your extension is to define it in the `package.json` file of your extension. This configuration includes the tool name, description, input schema, and other metadata:

1. Add an entry for your tool in the `contributes.languageModelTools` section of your extension's `package.json` file.
2. Give the tool a unique name:

   | Property | Description |
   | --- | --- |
   | `name` | The unique name of the tool, used to reference the tool in the extension implementation code. Format the name in the format `{verb}_{noun}`. See [naming guidelines](#guidelines-and-conventions). |
   | `displayName` | The user-friendly name of the tool, used for displaying in the UI. |

3. If the tool can be used in [agent mode](/docs/copilot/chat/chat-agent-mode) or referenced in a chat prompt with `#`, add the following properties:

   Users can enable or disable the tool in the Chat view, similar to how this is done for [Model Context Protocol (MCP) tools](/docs/copilot/chat/chat-tools.md#mcp-tools).

   | Property | Description |
   | --- | --- |
   | `canBeReferencedInPrompt` | Set to `true` if the tool can be used in [agent mode](/docs/copilot/chat/chat-agent-mode) or referenced in chat. |
   | `toolReferenceName` | The name for users to reference the tool in a chat prompt via `#`. |
   | `icon` | The icon to display for the tool in the UI. |
   | `userDescription` | User-friendly description of the tool, used for displaying in the UI. |

4. Add a detailed description in `modelDescription`. This information is used by the LLM to determine in which context your tool should be used.

   - What exactly does the tool do?
   - What kind of information does it return?
   - When should and shouldn't it be used?
   - Describe important limitations or constraints of the tool.

5. If the tool takes input parameters, add an `inputSchema` property that describes the tool's input parameters.

   This JSON schema describes an object with the properties that the tool takes as input, and whether they are required. File paths should be absolute paths.

   Describe what each parameter does and how it relates to the tool's functionality.

6. Add a `when` clause to control when the tool is available.

   The `languageModelTools` contribution point lets you restrict when a tool is available for agent mode or can be referenced in a prompt by using a [when clause](/api/references/when-clause-contexts). For example, a tool that gets the debug call stack information should only be available when the user is debugging.

   ```json
   "contributes": {
       "languageModelTools": [
           {
               "name": "chat-tools-sample_tabCount",
               ...
               "when": "debugState == 'running'"
           }
       ]
   }
   ```

**Example tool definition**

The following example shows how to define a tool that counts the number of active tabs in a tab group.

```json
"contributes": {
    "languageModelTools": [
        {
            "name": "chat-tools-sample_tabCount",
            "tags": [
                "editors",
                "chat-tools-sample"
            ],
            "toolReferenceName": "tabCount",
            "displayName": "Tab Count",
            "modelDescription": "The number of active tabs in a tab group in VS Code.",
            "userDescription": "Count the number of active tabs in a tab group.",
            "canBeReferencedInPrompt": true,
            "icon": "$(files)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabGroup": {
                        "type": "number",
                        "description": "The index of the tab group to check. This is optional- if not specified, the active tab group will be checked.",
                        "default": 0
                    }
                }
            }
        }
    ]
}
```

### 2. Tool implementation

Implement the language model tool by using the [Language Model API](/api/references/vscode-api#lm). This consists of the following steps:

1. On activation of the extension, register the tool with [`vscode.lm.registerTool`](/api/references/vscode-api#lm.registerTool).

   Provide the name of the tool as you specified it in the `name` property in `package.json`.

   If you want the tool to be private to your extension, skip the tool registration step.

   ```ts
   export function registerChatTools(context: vscode.ExtensionContext) {
     context.subscriptions.push(
       vscode.lm.registerTool('chat-tools-sample_tabCount', new TabCountTool())
     );
   }
   ```

2. Create a class that implements the [`vscode.LanguageModelTool<>`](/api/references/vscode-api#LanguageModelTool%3CT%3E) interface.

3. Add tool confirmation messages in the `prepareInvocation` method.

   A generic confirmation dialog will always be shown for tools from extensions, but the tool can customize the confirmation message. Give enough context to the user to understand what the tool is doing. The message can be a `MarkdownString` containing a code block.

   The following example shows how to provide a confirmation message for the tab count tool.

   ```ts
   async prepareInvocation(
       options: vscode.LanguageModelToolInvocationPrepareOptions<ITabCountParameters>,
       _token: vscode.CancellationToken
   ) {
       const confirmationMessages = {
           title: 'Count the number of open tabs',
           message: new vscode.MarkdownString(
               `Count the number of open tabs?` +
               (options.input.tabGroup !== undefined
                   ? ` in tab group ${options.input.tabGroup}`
                   : '')
           ),
       };

       return {
           invocationMessage: 'Counting the number of tabs',
           confirmationMessages,
       };
   }
   ```

   If `prepareInvocation` returned `undefined`, the generic confirmation message will be shown. Note that the user can also select to "Always Allow" a certain tool.

4. Define an interface that describes the tool input parameters.

   The interface is used in the `invoke` method of the `vscode.LanguageModelTool` class. The input parameters are validated against the JSON schema you defined in the `inputSchema` in `package.json`.

   The following example shows the interface for the tab count tool.

   ```ts
   export interface ITabCountParameters {
     tabGroup?: number;
   }
   ```

5. Implement the `invoke` method. This method is called when the language model tool is invoked while processing a chat prompt.

   The `invoke` method receives the tool input parameters in the `options` parameter. The parameters are validated against the JSON schema defined in `inputSchema` in `package.json`.

   When an error occurs, throw an error with a message that makes sense to the LLM. Optionally, provide instructions on what the LLM should do next, such as retrying with different parameters, or performing a different action.

   The following example shows the implementation of the tab count tool. The result of the tool is an instance of type `vscode.LanguageModelToolResult`.

   ```ts
   async invoke(
       options: vscode.LanguageModelToolInvocationOptions<ITabCountParameters>,
       _token: vscode.CancellationToken
   ) {
       const params = options.input;
       if (typeof params.tabGroup === 'number') {
           const group = vscode.window.tabGroups.all[Math.max(params.tabGroup - 1, 0)];
           const nth =
               params.tabGroup === 1
                   ? '1st'
                   : params.tabGroup === 2
                       ? '2nd'
                       : params.tabGroup === 3
                           ? '3rd'
                           : `${params.tabGroup}th`;
           return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`There are ${group.tabs.length} tabs open in the ${nth} tab group.`)]);
       } else {
           const group = vscode.window.tabGroups.activeTabGroup;
           return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`There are ${group.tabs.length} tabs open.`)]);
       }
   }
   ```

View the full source code for implementing a [language model tool](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/src/tools.ts) in the VS Code Extension Samples repository.

## Tool-calling flow

When a user sends a chat prompt, the following steps occur:

1. Copilot determines the list of available tools based on the user's configuration.
   The list of tools consists of built-in tools, tools registered by extensions, and tools from [MCP servers](/docs/copilot/chat/mcp-servers). You can contribute to agent mode via extensions or MCP servers (shown in green in the diagram).
2. Copilot sends the request to the LLM and provides it with the prompt, chat context, and the list of tool definitions to consider.
   The LLM generates a response, which might include one or more requests to invoke a tool.
3. If needed, Copilot invokes the suggested tool(s) with the parameter values provided by the LLM.
   A tool response might result in more requests for tool invocations.
4. If there are errors or follow-up tool requests, Copilot iterates over the tool-calling flow until all tool requests are resolved.
5. Copilot returns the final response to the user, which might include responses from multiple tools.

## Guidelines and conventions

- **Naming**: write clear and descriptive names for tools and parameters.
  - **Tool name**: should be unique, and clearly describe their intent. Structure the tool name in the format `{verb}_{noun}`. For example, `get_weather`, `get_azure_deployment`, or `get_terminal_output`.
  - **Parameter name**: should describe the parameter's purpose. Structure the parameter name in the format `{noun}`. For example, `destination_location`, `ticker`, or `file_name`.
- **Descriptions**: write detailed descriptions for tools and parameters.
  - Describe what the tool does and when it should and shouldn't be used. For example, "This tool retrieves the weather for a given location."
  - Describe what each parameter does and how it relates to the tool's functionality. For example, "The `destination_location` parameter specifies the location for which to retrieve the weather. It should be a valid location name or coordinates."
  - Describe important limitations or constraints of the tool. For example, "This tool only retrieves weather data for locations in the United States. It might not work for other regions."
- **User confirmation**: provide a confirmation message for the tool invocation. A generic confirmation dialog will always be shown for tools from extensions, but the tool can customize the confirmation message. Give enough context to the user to understand what the tool is doing.
- **Error handling**: when an error occurs, throw an error with a message that makes sense to the LLM. Optionally, provide instructions on what the LLM should do next, such as retrying with different parameters, or performing a different action.

Get more best practices for creating tools in the [OpenAI documentation](https://platform.openai.com/docs/guides/function-calling?api-mode=chat#best-practices-for-defining-functions) and [Anthropic documentation](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview).

## Related content

- [Language Model API reference](/api/references/vscode-api#lm)
- [Register an MCP server in a VS Code extension](/api/extension-guides/ai/mcp)
- [Use MCP tools in agent mode](/docs/copilot/chat/mcp-servers)

_Fetched on 2025-11-12 via markitdown MCP._
