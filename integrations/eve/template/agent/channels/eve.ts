import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { betterAuthEveAuth, passwordEveAuth } from "../../apps/web/lib/eve-auth";

export default eveChannel({
  auth: [betterAuthEveAuth, passwordEveAuth, vercelOidc(), localDev()],
  uploadPolicy: "disabled",
});
