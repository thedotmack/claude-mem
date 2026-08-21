"use client";

/** Subtle haptics on supporting devices; silently ignored everywhere else. */
function buzz(pattern: number | number[]) {
  if (typeof navigator === "undefined") return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

export const tap = () => buzz(11);
export const tick = () => buzz([9, 40, 16]);
export const thud = () => buzz(26);
