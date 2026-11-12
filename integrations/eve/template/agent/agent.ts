import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

// eve reads this file when it builds, so changing ANTHROPIC_API_KEY or
// EVE_MODEL needs a redeploy.
//
// 1. ANTHROPIC_API_KEY set: call Claude directly with your Anthropic key.
// 2. EVE_MODEL set: that AI Gateway model, exactly. No fallback, so a model
//    your gateway refuses fails loudly instead of switching quietly.
// 3. Neither: Claude through AI Gateway. Gateways with paid credits answer with
//    Claude and never touch the fallbacks. AI Gateway free credits refuse
//    Claude ("Free tier users do not have access to this model"); the refused
//    attempt reaches no provider and costs nothing, and the gateway moves on to
//    FREE_CREDIT_FALLBACK_MODELS in order.
const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-5";

// Why three models: free credits limit each model to 5 requests per minute per
// provider (429 header x-ratelimit-limit-requests: 5). These models each run on
// two providers, so each gives about 10 calls a minute. One eve turn made 12
// model calls in 60 s and failed on gpt-5-mini alone. The gateway also falls
// back to the next model on a 429, so the list gives about 30 calls a minute.
// Tested on a free-credit team: a 12-call tool turn failed with gpt-5-mini
// alone and passed with this list; a 24-call turn passed in 33 s.
// Order: cheapest first; gpt-5 costs about 5x more and is the last resort.
// All three are free-tier eligible and handled tool calls in those tests.
const FREE_CREDIT_FALLBACK_MODELS = [
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash",
  "openai/gpt-5",
];

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const gatewayModel = process.env.EVE_MODEL?.trim();

export default anthropicApiKey
  ? defineAgent({ model: anthropic() })
  : gatewayModel
    ? defineAgent({ model: gatewayModel })
    : defineAgent({
        model: DEFAULT_GATEWAY_MODEL,
        modelOptions: {
          providerOptions: { gateway: { models: FREE_CREDIT_FALLBACK_MODELS } },
        },
      });
