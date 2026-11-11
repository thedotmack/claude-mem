import { NextResponse } from "next/server";
import { AUTH_HINT_COOKIE_NAME, isSecureAuthHintCookie } from "@/lib/auth-hint";
import { hasSameOriginRequest, PASSWORD_SESSION_COOKIE_NAME } from "@/lib/password-auth";

export async function POST(request: Request) {
  if (!hasSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  const secure = isSecureAuthHintCookie();
  const expiredCookie = {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure,
  };

  response.cookies.set(PASSWORD_SESSION_COOKIE_NAME, "", expiredCookie);
  response.cookies.set(AUTH_HINT_COOKIE_NAME, "", {
    ...expiredCookie,
    httpOnly: false,
  });

  return response;
}
