import type { Sql } from "../xodos/db";
import type { AdminDeps } from "./admin";
import { mailerFromEnv } from "./email";

export function adminDeps(sql: Sql): AdminDeps {
  return { sql, mail: mailerFromEnv(), appUrl: process.env.APP_URL || "https://spherum.com.br" };
}
