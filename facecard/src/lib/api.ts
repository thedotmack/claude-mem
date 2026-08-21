import { NextResponse } from "next/server";

/** Uniform API envelopes so the client can handle every failure the same way. */

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, ...data }, { status });
}

export function fail(message: string, status = 400) {
  const clean = message === "UNAUTHENTICATED" ? "Please sign in." : message;
  return NextResponse.json({ ok: false, error: clean }, { status: message === "UNAUTHENTICATED" ? 401 : status });
}

export function statusFor(err: unknown): number {
  const message = err instanceof Error ? err.message : "";
  if (message === "UNAUTHENTICATED") return 401;
  if (message.endsWith("_NOT_FOUND")) return 404;
  if (message === "INVALID_CHOICE" || message === "CHOICE_ALREADY_MADE") return 409;
  return 500;
}
