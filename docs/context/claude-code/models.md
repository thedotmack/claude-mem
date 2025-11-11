# Models overview

> Claude is a family of state-of-the-art large language models developed by Anthropic. This guide introduces our models and compares their performance with legacy models. 

export const ModelId = ({children, style = {}}) => {
  const copiedNotice = 'Copied!';
  const handleClick = e => {
    const element = e.currentTarget;
    const originalText = element.textContent;
    navigator.clipboard.writeText(children).then(() => {
      element.textContent = copiedNotice;
      element.style.backgroundColor = '#d4edda';
      element.style.color = '#155724';
      element.style.borderColor = '#c3e6cb';
      setTimeout(() => {
        element.textContent = originalText;
        element.style.backgroundColor = '#f5f5f5';
        element.style.color = '';
        element.style.borderColor = 'transparent';
      }, 2000);
    }).catch(error => {
      console.error('Failed to copy:', error);
    });
  };
  const handleMouseEnter = e => {
    const element = e.currentTarget;
    const tooltip = element.querySelector('.copy-tooltip');
    if (tooltip && element.textContent !== copiedNotice) {
      tooltip.style.opacity = '1';
    }
    element.style.backgroundColor = '#e8e8e8';
    element.style.borderColor = '#d0d0d0';
  };
  const handleMouseLeave = e => {
    const element = e.currentTarget;
    const tooltip = element.querySelector('.copy-tooltip');
    if (tooltip) {
      tooltip.style.opacity = '0';
    }
    if (element.textContent !== copiedNotice) {
      element.style.backgroundColor = '#f5f5f5';
      element.style.borderColor = 'transparent';
    }
  };
  const defaultStyle = {
    cursor: 'pointer',
    position: 'relative',
    transition: 'all 0.2s ease',
    display: 'inline-block',
    userSelect: 'none',
    backgroundColor: '#f5f5f5',
    padding: '2px 4px',
    borderRadius: '4px',
    fontFamily: 'Monaco, Consolas, "Courier New", monospace',
    fontSize: '0.9em',
    border: '1px solid transparent',
    ...style
  };
  return <span onClick={handleClick} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} style={defaultStyle}>
      {children}
    </span>;
};

<CardGroup cols={3}>
  <Card title="Claude Sonnet 4.5" icon="star" href="/en/docs/about-claude/models/overview#model-comparison-table">
    Our best model for complex agents and coding

    * <Icon icon="inbox-in" iconType="thin" /> Text and image input
    * <Icon icon="inbox-out" iconType="thin" /> Text output
    * <Icon icon="book" iconType="thin" /> 200k context window (1M context beta available)
    * <Icon icon="brain" iconType="thin" /> Highest intelligence across most tasks
  </Card>

  <Card title="Claude Haiku 4.5" icon="rocket-launch" href="/en/docs/about-claude/models/overview#model-comparison-table">
    Our fastest and most intelligent Haiku model

    * <Icon icon="inbox-in" iconType="thin" /> Text and image input
    * <Icon icon="inbox-out" iconType="thin" /> Text output
    * <Icon icon="book" iconType="thin" /> 200k context window
    * <Icon icon="zap" iconType="thin" /> Lightning-fast speed with extended thinking
  </Card>

  <Card title="Claude Opus 4.1" icon="trophy" href="/en/docs/about-claude/models/overview#model-comparison-table">
    Exceptional model for specialized complex tasks

    * <Icon icon="inbox-in" iconType="thin" /> Text and image input
    * <Icon icon="inbox-out" iconType="thin" /> Text output
    * <Icon icon="book" iconType="thin" /> 200k context window
    * <Icon icon="brain" iconType="thin" /> Superior reasoning capabilities
  </Card>
</CardGroup>

***

## Model names

| Model             | Claude API                                                                                  | AWS Bedrock                                                  | GCP Vertex AI                                  |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| Claude Sonnet 4.5 | <ModelId>claude-sonnet-4-5-20250929</ModelId>                                               | <ModelId>anthropic.claude-sonnet-4-5-20250929-v1:0</ModelId> | <ModelId>claude-sonnet-4-5\@20250929</ModelId> |
| Claude Sonnet 4   | <ModelId>claude-sonnet-4-20250514</ModelId>                                                 | <ModelId>anthropic.claude-sonnet-4-20250514-v1:0</ModelId>   | <ModelId>claude-sonnet-4\@20250514</ModelId>   |
| Claude Sonnet 3.7 | <ModelId>claude-3-7-sonnet-20250219</ModelId> (<ModelId>claude-3-7-sonnet-latest</ModelId>) | <ModelId>anthropic.claude-3-7-sonnet-20250219-v1:0</ModelId> | <ModelId>claude-3-7-sonnet\@20250219</ModelId> |
| Claude Haiku 4.5  | <ModelId>claude-haiku-4-5-20251001</ModelId>                                                | <ModelId>anthropic.claude-haiku-4-5-20251001-v1:0</ModelId>  | <ModelId>claude-haiku-4-5\@20251001</ModelId>  |
| Claude Haiku 3.5  | <ModelId>claude-3-5-haiku-20241022</ModelId> (<ModelId>claude-3-5-haiku-latest</ModelId>)   | <ModelId>anthropic.claude-3-5-haiku-20241022-v1:0</ModelId>  | <ModelId>claude-3-5-haiku\@20241022</ModelId>  |
| Claude Haiku 3    | <ModelId>claude-3-haiku-20240307</ModelId>                                                  | <ModelId>anthropic.claude-3-haiku-20240307-v1:0</ModelId>    | <ModelId>claude-3-haiku\@20240307</ModelId>    |
| Claude Opus 4.1   | <ModelId>claude-opus-4-1-20250805</ModelId>                                                 | <ModelId>anthropic.claude-opus-4-1-20250805-v1:0</ModelId>   | <ModelId>claude-opus-4-1\@20250805</ModelId>   |
| Claude Opus 4     | <ModelId>claude-opus-4-20250514</ModelId>                                                   | <ModelId>anthropic.claude-opus-4-20250514-v1:0</ModelId>     | <ModelId>claude-opus-4\@20250514</ModelId>     |

<Note>Models with the same snapshot date (e.g., 20240620) are identical across all platforms and do not change. The snapshot date in the model name ensures consistency and allows developers to rely on stable performance across different environments.</Note>

<Note>Starting with **Claude Sonnet 4.5 and all future models**, AWS Bedrock and Google Vertex AI offer two endpoint types: **global endpoints** (dynamic routing for maximum availability) and **regional endpoints** (guaranteed data routing through specific geographic regions). For more information, see the [third-party platform pricing section](/en/docs/about-claude/pricing#third-party-platform-pricing).</Note>

### Model aliases

For convenience during development and testing, we offer aliases for our model ids. These aliases automatically point to the most recent snapshot of a given model. When we release new model snapshots, we migrate aliases to point to the newest version of a model, typically within a week of the new release.

<Tip>
  While aliases are useful for experimentation, we recommend using specific model versions (e.g., `claude-sonnet-4-5-20250929`) in production applications to ensure consistent behavior.
</Tip>

| Model             | Alias                                       | Model ID                                      |
| ----------------- | ------------------------------------------- | --------------------------------------------- |
| Claude Sonnet 4.5 | <ModelId>claude-sonnet-4-5</ModelId>        | <ModelId>claude-sonnet-4-5-20250929</ModelId> |
| Claude Sonnet 4   | <ModelId>claude-sonnet-4-0</ModelId>        | <ModelId>claude-sonnet-4-20250514</ModelId>   |
| Claude Sonnet 3.7 | <ModelId>claude-3-7-sonnet-latest</ModelId> | <ModelId>claude-3-7-sonnet-20250219</ModelId> |
| Claude Haiku 4.5  | <ModelId>claude-haiku-4-5</ModelId>         | <ModelId>claude-haiku-4-5-20251001</ModelId>  |
| Claude Haiku 3.5  | <ModelId>claude-3-5-haiku-latest</ModelId>  | <ModelId>claude-3-5-haiku-20241022</ModelId>  |
| Claude Opus 4.1   | <ModelId>claude-opus-4-1</ModelId>          | <ModelId>claude-opus-4-1-20250805</ModelId>   |
| Claude Opus 4     | <ModelId>claude-opus-4-0</ModelId>          | <ModelId>claude-opus-4-20250514</ModelId>     |

<Note>
  Aliases are subject to the same rate limits and pricing as the underlying model version they reference.
</Note>

### Model comparison table

To help you choose the right model for your needs, we've compiled a table comparing the key features and capabilities of each model in the Claude family:

| Feature                                                               | Claude Sonnet 4.5                                                                                     | Claude Sonnet 4                                                                                       | Claude Sonnet 3.7                                                                                     | Claude Opus 4.1                                                                                      | Claude Opus 4                                                                                        | Claude Haiku 4.5                                                                                      | Claude Haiku 3.5                                                                                       | Claude Haiku 3                                                                                       |
| :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Description**                                                       | Our best model for complex agents and coding                                                          | High-performance model                                                                                | High-performance model with early extended thinking                                                   | Exceptional model for specialized complex tasks                                                      | Our previous flagship model                                                                          | Our fastest and most intelligent Haiku model                                                          | Our fastest model                                                                                      | Fast and compact model for near-instant responsiveness                                               |
| **Strengths**                                                         | Highest intelligence across most tasks with exceptional agent and coding capabilities                 | High intelligence and balanced performance                                                            | High intelligence with toggleable extended thinking                                                   | Very high intelligence and capability for specialized tasks                                          | Very high intelligence and capability                                                                | Near-frontier intelligence at blazing speeds with extended thinking and exceptional cost-efficiency   | Intelligence at blazing speeds                                                                         | Quick and accurate targeted performance                                                              |
| **Multilingual**                                                      | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                  | Yes                                                                                                  | Yes                                                                                                   | Yes                                                                                                    | Yes                                                                                                  |
| **Vision**                                                            | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                  | Yes                                                                                                  | Yes                                                                                                   | Yes                                                                                                    | Yes                                                                                                  |
| **[Extended thinking](/en/docs/build-with-claude/extended-thinking)** | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                  | Yes                                                                                                  | Yes                                                                                                   | No                                                                                                     | No                                                                                                   |
| **[Priority Tier](/en/api/service-tiers)**                            | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                   | Yes                                                                                                  | Yes                                                                                                  | Yes                                                                                                   | Yes                                                                                                    | No                                                                                                   |
| **API model name**                                                    | <ModelId>claude-sonnet-4-5-20250929</ModelId>                                                         | <ModelId>claude-sonnet-4-20250514</ModelId>                                                           | <ModelId>claude-3-7-sonnet-20250219</ModelId>                                                         | <ModelId>claude-opus-4-1-20250805</ModelId>                                                          | <ModelId>claude-opus-4-20250514</ModelId>                                                            | <ModelId>claude-haiku-4-5-20251001</ModelId>                                                          | <ModelId>claude-3-5-haiku-20241022</ModelId>                                                           | <ModelId>claude-3-haiku-20240307</ModelId>                                                           |
| **Comparative latency**                                               | Fast                                                                                                  | Fast                                                                                                  | Fast                                                                                                  | Moderately Fast                                                                                      | Moderately Fast                                                                                      | Fastest                                                                                               | Fastest                                                                                                | Fast                                                                                                 |
| **Context window**                                                    | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip> / <br /> 1M (beta)<sup>1</sup>   | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip> / <br /> 1M (beta)<sup>1</sup>   | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip>                                  | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip>                                 | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip>                                 | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip>                                  | <Tooltip tip="~150K words \ ~215K unicode characters">200K</Tooltip>                                   | <Tooltip tip="~150K words \ ~680K unicode characters">200K</Tooltip>                                 |
| **Max output**                                                        | <Tooltip tip="~48K words \ 218K unicode characters \ ~100 single spaced pages">64000 tokens</Tooltip> | <Tooltip tip="~48K words \ 218K unicode characters \ ~100 single spaced pages">64000 tokens</Tooltip> | <Tooltip tip="~48K words \ 218K unicode characters \ ~100 single spaced pages">64000 tokens</Tooltip> | <Tooltip tip="~24K words \ 109K unicode characters \ ~50 single spaced pages">32000 tokens</Tooltip> | <Tooltip tip="~24K words \ 109K unicode characters \ ~50 single spaced pages">32000 tokens</Tooltip> | <Tooltip tip="~48K words \ 218K unicode characters \ ~100 single spaced pages">64000 tokens</Tooltip> | <Tooltip tip="~6.2K words \ 28K unicode characters \ ~12-13 single spaced pages">8192 tokens</Tooltip> | <Tooltip tip="~3.1K words \ 14K unicode characters \ ~6-7 single spaced pages">4096 tokens</Tooltip> |
| **Reliable knowledge cutoff**                                         | Jan 2025<sup>2</sup>                                                                                  | Jan 2025<sup>2</sup>                                                                                  | Oct 2024<sup>2</sup>                                                                                  | Jan 2025<sup>2</sup>                                                                                 | Jan 2025<sup>2</sup>                                                                                 | Feb 2025                                                                                              | <sup>3</sup>                                                                                           | <sup>3</sup>                                                                                         |
| **Training data cutoff**                                              | Jul 2025                                                                                              | Mar 2025                                                                                              | Nov 2024                                                                                              | Mar 2025                                                                                             | Mar 2025                                                                                             | Jul 2025                                                                                              | Jul 2024                                                                                               | Aug 2023                                                                                             |

*<sup>1 - Claude Sonnet 4.5 and Claude Sonnet 4 support a [1M token context window](/en/docs/build-with-claude/context-windows#1m-token-context-window) when using the `context-1m-2025-08-07` beta header. [Long context pricing](/en/docs/about-claude/pricing#long-context-pricing) applies to requests exceeding 200K tokens.</sup>*

*<sup>2 - **Reliable knowledge cutoff** indicates the date through which a model's knowledge is most extensive and reliable. **Training data cutoff** is the broader date range of training data used. For example, Claude Sonnet 4.5 was trained on publicly available information through July 2025, but its knowledge is most extensive and reliable through January 2025. For more information, see [Anthropic's Transparency Hub](https://www.anthropic.com/transparency).</sup>*

*<sup>3 - Some Haiku models have a single training data cutoff date.</sup>*

<Note>
  Include the beta header `output-128k-2025-02-19` in your API request to increase the maximum output token length to 128k tokens for Claude Sonnet 3.7.

  We strongly suggest using our [streaming Messages API](/en/docs/build-with-claude/streaming) to avoid timeouts when generating longer outputs.
  See our guidance on [long requests](/en/api/errors#long-requests) for more details.
</Note>

### Model pricing

The table below shows the price per million tokens for each model:

| Model                                                                      | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| -------------------------------------------------------------------------- | ----------------- | --------------- | --------------- | ---------------------- | ------------- |
| Claude Opus 4.1                                                            | \$15 / MTok       | \$18.75 / MTok  | \$30 / MTok     | \$1.50 / MTok          | \$75 / MTok   |
| Claude Opus 4                                                              | \$15 / MTok       | \$18.75 / MTok  | \$30 / MTok     | \$1.50 / MTok          | \$75 / MTok   |
| Claude Sonnet 4.5                                                          | \$3 / MTok        | \$3.75 / MTok   | \$6 / MTok      | \$0.30 / MTok          | \$15 / MTok   |
| Claude Sonnet 4                                                            | \$3 / MTok        | \$3.75 / MTok   | \$6 / MTok      | \$0.30 / MTok          | \$15 / MTok   |
| Claude Sonnet 3.7                                                          | \$3 / MTok        | \$3.75 / MTok   | \$6 / MTok      | \$0.30 / MTok          | \$15 / MTok   |
| Claude Sonnet 3.5 ([deprecated](/en/docs/about-claude/model-deprecations)) | \$3 / MTok        | \$3.75 / MTok   | \$6 / MTok      | \$0.30 / MTok          | \$15 / MTok   |
| Claude Haiku 4.5                                                           | \$1 / MTok        | \$1.25 / MTok   | \$2 / MTok      | \$0.10 / MTok          | \$5 / MTok    |
| Claude Haiku 3.5                                                           | \$0.80 / MTok     | \$1 / MTok      | \$1.6 / MTok    | \$0.08 / MTok          | \$4 / MTok    |
| Claude Opus 3 ([deprecated](/en/docs/about-claude/model-deprecations))     | \$15 / MTok       | \$18.75 / MTok  | \$30 / MTok     | \$1.50 / MTok          | \$75 / MTok   |
| Claude Haiku 3                                                             | \$0.25 / MTok     | \$0.30 / MTok   | \$0.50 / MTok   | \$0.03 / MTok          | \$1.25 / MTok |

## Prompt and output performance

Claude 4 models excel in:

* **Performance**: Top-tier results in reasoning, coding, multilingual tasks, long-context handling, honesty, and image processing. See the [Claude 4 blog post](http://www.anthropic.com/news/claude-4) for more information.
* **Engaging responses**: Claude models are ideal for applications that require rich, human-like interactions.

  * If you prefer more concise responses, you can adjust your prompts to guide the model toward the desired output length. Refer to our [prompt engineering guides](/en/docs/build-with-claude/prompt-engineering) for details.
  * For specific Claude 4 prompting best practices, see our [Claude 4 best practices guide](/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices).
* **Output quality**: When migrating from previous model generations to Claude 4, you may notice larger improvements in overall performance.

## Migrating to Claude 4.5

If you're currently using Claude 3 models, we recommend migrating to Claude 4.5 to take advantage of improved intelligence and enhanced capabilities. For detailed migration instructions, see [Migrating to Claude 4.5](/en/docs/about-claude/models/migrating-to-claude-4).

## Get started with Claude

If you're ready to start exploring what Claude can do for you, let's dive in! Whether you're a developer looking to integrate Claude into your applications or a user wanting to experience the power of AI firsthand, we've got you covered.

<Note>Looking to chat with Claude? Visit [claude.ai](http://www.claude.ai)!</Note>

<CardGroup cols={3}>
  <Card title="Intro to Claude" icon="check" href="/en/docs/intro-to-claude">
    Explore Claude’s capabilities and development flow.
  </Card>

  <Card title="Quickstart" icon="bolt-lightning" href="/en/resources/quickstarts">
    Learn how to make your first API call in minutes.
  </Card>

  <Card title="Claude Console" icon="code" href="https://console.anthropic.com">
    Craft and test powerful prompts directly in your browser.
  </Card>
</CardGroup>

If you have any questions or need assistance, don't hesitate to reach out to our [support team](https://support.claude.com/) or consult the [Discord community](https://www.anthropic.com/discord).
