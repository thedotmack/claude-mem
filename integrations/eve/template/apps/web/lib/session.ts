import { headers } from "next/headers";
import { auth } from "./auth";
import type { SetupStatus, Viewer } from "./chat/types";
import { getPasswordSessionFromHeaders } from "./password-auth";
import { getSetupStatus } from "./setup";

const PASSWORD_VIEWER: Viewer = {
  email: "local@eve.dev",
  id: "eve-chat-user",
  image: null,
  name: "eve user",
};

export async function getServerViewer(setupStatus?: SetupStatus): Promise<Viewer | null> {
  const status = setupStatus ?? (await getSetupStatus());

  if (!status.appReady) {
    return null;
  }

  const requestHeaders = await headers();

  if (status.authMode === "local-dev") {
    return PASSWORD_VIEWER;
  }

  if (status.authMode === "password") {
    return getPasswordSessionFromHeaders(requestHeaders) ? PASSWORD_VIEWER : null;
  }

  if (status.authMode !== "vercel") {
    return null;
  }

  try {
    const session = await auth.api.getSession({
      headers: requestHeaders,
    });

    if (!session?.user) {
      return null;
    }

    return {
      email: session.user.email,
      id: session.user.id,
      image: session.user.image ?? null,
      name: session.user.name,
    };
  } catch {
    return null;
  }
}
