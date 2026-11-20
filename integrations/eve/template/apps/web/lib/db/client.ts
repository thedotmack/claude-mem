import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let database: NeonHttpDatabase<typeof schema> | null = null;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDb() {
  if (!database) {
    const url = process.env.DATABASE_URL?.trim();

    if (!url) {
      throw new Error("DATABASE_URL is required. Add Neon to this Vercel project first.");
    }

    database = drizzle({ client: neon(url), schema });
  }

  return database;
}

const databaseProxyTarget = {} as NeonHttpDatabase<typeof schema>;

export const db = new Proxy(databaseProxyTarget, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export async function isDatabaseSchemaReady() {
  const url = process.env.DATABASE_URL?.trim();

  if (!url) {
    return false;
  }

  try {
    const sql = neon(url);
    const rows = await sql`
      select
        to_regclass('public.account') is not null as account_ready,
        to_regclass('public.chat') is not null as chat_ready,
        to_regclass('public.chat_event') is not null as chat_event_ready,
        to_regclass('public.session') is not null as session_ready,
        to_regclass('public."user"') is not null as user_ready,
        to_regclass('public.verification') is not null as verification_ready
    `;
    const result = rows[0];

    return (
      result?.account_ready === true &&
      result.chat_ready === true &&
      result.chat_event_ready === true &&
      result.session_ready === true &&
      result.user_ready === true &&
      result.verification_ready === true
    );
  } catch {
    return false;
  }
}
