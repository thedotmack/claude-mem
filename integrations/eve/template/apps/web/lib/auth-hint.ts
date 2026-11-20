export const AUTH_HINT_COOKIE_NAME = "eve_logged_in";
export const AUTH_HINT_COOKIE_VALUE = "1";
export const AUTH_HINT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function isSecureAuthHintCookie() {
  return process.env.NODE_ENV !== "development";
}
