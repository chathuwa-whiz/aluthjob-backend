import { after } from "node:test";
import "./test-env.js";
import { closeDatabase, getDatabase } from "./database.js";

// Each test file runs in its own process; without this the open connection pool would keep it alive forever
after(() => closeDatabase());

/** Empties every table, children first. Only ever runs against the TEST_ORACLE_* database (see test-env.ts). */
export async function clearDatabase(): Promise<void> {
    const db = getDatabase();
    for (const table of ["applications", "mail_accounts", "matches", "candidates", "email_tokens", "sessions", "users", "jobs"]) {
        await db.run(`DELETE FROM ${table}`);
    }
}
