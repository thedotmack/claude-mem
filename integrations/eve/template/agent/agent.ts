import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

// eve reads this file when it builds, so changing ANTHROPIC_API_KEY or
// EVE_MODEL needs a redeploy.
//
// 1. ANTHROPIC_API_KEY set: call Claude directly with your Anthropic key.
// 2. EVE_MODEL set: that AI Gateway model, exactly. No fallback, so a model
//    your gateway refuses fails loudly instead of switching quietly.
// 3. Neither: Claude through AI Gateway. AI Gateway free credits refuse Claude
//    ("Free tier users do not have access to this model"), so the gateway then
//    answers with openai/gpt-5-mini, which free credits allow. Tested on a
//    free-credit team: the refused Claude attempt reaches no provider and costs
//    nothing.
const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-5";
const FREE_CREDIT_FALLBACK_MODEL = "openai/gpt-5-mini";

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const gatewayModel = process.env.EVE_MODEL?.trim();

export default anthropicApiKey
  ? defineAgent({ model: anthropic() })
  : gatewayModel
    ? defineAgent({ model: gatewayModel })
    : defineAgent({
        model: DEFAULT_GATEWAY_MODEL,
        modelOptions: {
          providerOptions: { gateway: { models: [FREE_CREDIT_FALLBACK_MODEL] } },
        },
      });
