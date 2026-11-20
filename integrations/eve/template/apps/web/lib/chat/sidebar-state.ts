export const SIDEBAR_COOKIE_NAME = "eve-chat-sidebar";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseSidebarOpen(value: string | null | undefined) {
  return value !== "closed";
}

export function serializeSidebarOpen(open: boolean) {
  return open ? "open" : "closed";
}
