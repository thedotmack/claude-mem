# Draft Observation Prompt

```
TOOL OBSERVATION
================
Tool: {tool_name}
Time: {timestamp}
Prompt: {prompt_number}

Input:
{tool_input JSON}

Output:
{tool_output JSON}

TASK
----
Analyze this tool output. If it contains significant information about the codebase, generate an observation using the XML format from the init prompt.

If this is routine or repetitive, you can skip it.
```
