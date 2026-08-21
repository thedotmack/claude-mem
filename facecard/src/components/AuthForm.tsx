"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { GlassButton } from "./Glass";

type Mode = "signup" | "login" | "reset";

const FIELD =
  "w-full rounded-2xl border border-white/12 bg-white/[0.045] px-5 py-4 text-[0.95rem] placeholder:text-white/30 focus:border-white/28 focus:outline-none";

export default function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/create";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = getBrowserSupabase();

    try {
      if (mode === "signup") {
        const clean = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
        if (clean.length < 2) throw new Error("Pick a username with at least 2 characters.");
        if (password.length < 8) throw new Error("Password needs at least 8 characters.");

        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username: clean, display_name: clean },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;

        // With email confirmation off, a session exists right away.
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.push(next);
          router.refresh();
        } else {
          setNotice("Check your email to confirm your account, then sign in.");
        }
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=/me`,
        });
        if (error) throw error;
        setNotice("If that email exists, a reset link is on the way.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    // Surfaces clearly when the Google provider isn't enabled in Supabase yet.
    if (error) setError(`Google sign-in isn't enabled yet: ${error.message}`);
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-black px-6 py-14">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(110% 70% at 50% 0%, rgba(216,176,114,0.13), transparent 60%)" }}
      />
      <div className="film-grain" />

      <div className="rise relative z-10 w-full max-w-md">
        <a href="/" className="kicker mb-6 block text-center">FACE CARD</a>

        <div className="glass px-7 py-8">
          <h1 className="display text-center text-[2rem]">
            {mode === "signup" ? "CREATE YOUR CARD" : mode === "login" ? "WELCOME BACK" : "RESET PASSWORD"}
          </h1>

          <form onSubmit={submit} className="mt-7 flex flex-col gap-3">
            {mode === "signup" && (
              <input
                className={FIELD}
                placeholder="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                maxLength={20}
                required
              />
            )}
            <input
              className={FIELD}
              type="email"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            {mode !== "reset" && (
              <input
                className={FIELD}
                type="password"
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
              />
            )}

            {error && <p className="px-1 text-[0.82rem] text-[#E0836F]">{error}</p>}
            {notice && <p className="px-1 text-[0.82rem] text-[color:var(--color-gold)]">{notice}</p>}

            <GlassButton type="submit" tone="gold" disabled={busy} className="mt-2 w-full">
              {busy ? "…" : mode === "signup" ? "Start" : mode === "login" ? "Enter" : "Send link"}
            </GlassButton>
          </form>

          {mode !== "reset" && (
            <>
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-white/10" />
                <span className="kicker">or</span>
                <span className="h-px flex-1 bg-white/10" />
              </div>
              <GlassButton onClick={google} className="w-full">Continue with Google</GlassButton>
            </>
          )}
        </div>

        <div className="mt-5 flex justify-center gap-5 text-[0.8rem] text-[color:var(--color-muted)]">
          {mode === "login" ? (
            <>
              <a href="/signup" className="hover:text-white">Create account</a>
              <a href="/reset" className="hover:text-white">Forgot password</a>
            </>
          ) : (
            <a href="/login" className="hover:text-white">I already have an account</a>
          )}
        </div>
      </div>
    </main>
  );
}
