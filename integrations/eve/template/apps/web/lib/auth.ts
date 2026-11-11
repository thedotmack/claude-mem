import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getAppUrlHost, getEffectiveAppUrl } from "./auth-url";
import { db } from "./db/client";

const vercelClientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID?.trim() ?? "";
const vercelClientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim() ?? "";
const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();
const vercelProviderConfigured = Boolean(betterAuthSecret && vercelClientId && vercelClientSecret);
const authBaseUrl = getEffectiveAppUrl();
const authProtocol = new URL(authBaseUrl).protocol === "https:" ? "https" : "http";
const allowedHosts = [
  "localhost:3000",
  "localhost:3001",
  "127.0.0.1:3000",
  "127.0.0.1:3001",
  "*.vercel.app",
  getAppUrlHost(process.env.BETTER_AUTH_URL),
  getAppUrlHost(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  getAppUrlHost(process.env.VERCEL_URL),
].filter((host): host is string => Boolean(host));

export const auth = betterAuth({
  baseURL: {
    allowedHosts,
    fallback: authBaseUrl,
    protocol: authProtocol,
  },
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: ["vercel"],
      allowDifferentEmails: true,
    },
  },
  secret: betterAuthSecret ?? "eve-chat-template-unconfigured-secret",
  advanced: {
    database: {
      generateId: () => randomUUID(),
    },
  },
  onAPIError: {
    errorURL: "/auth/error",
  },
  socialProviders: vercelProviderConfigured
    ? {
        vercel: {
          clientId: vercelClientId,
          clientSecret: vercelClientSecret,
          overrideUserInfoOnSignIn: true,
          scope: ["openid", "email", "profile"],
        },
      }
    : {},
  plugins: [nextCookies()],
});
