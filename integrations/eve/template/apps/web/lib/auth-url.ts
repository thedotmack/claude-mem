const LOCAL_APP_URL = "http://localhost:3000";

export function getEffectiveAppUrl() {
  return (
    normalizeAppUrl(process.env.BETTER_AUTH_URL) ??
    normalizeAppUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normalizeAppUrl(process.env.VERCEL_URL) ??
    LOCAL_APP_URL
  );
}

export function getAppUrlHost(value: string | undefined) {
  const url = normalizeAppUrl(value);

  if (!url) {
    return undefined;
  }

  return new URL(url).host;
}

function normalizeAppUrl(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.pathname = "";
    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
