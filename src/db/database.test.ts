import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

process.env.DATABASE_PATH = ":memory:";

describe("schema migration", () => {
    it("adds the newer columns to a database created by an older version, keeping its data", async () => {
        const { migrate } = await import("./database.js");
        const db = new DatabaseSync(":memory:");

        // the tables as they were before email-source tracking existed
        db.exec(`
            CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, apply_email TEXT);
            CREATE TABLE matches (id INTEGER PRIMARY KEY, score INTEGER);
            CREATE TABLE candidates (id INTEGER PRIMARY KEY, resume_hash TEXT NOT NULL UNIQUE);
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, last_login_at TEXT
            );
            INSERT INTO users (email, password_hash, created_at) VALUES ('legacy@old.lk', 'x', '2026-01-01T00:00:00.000Z');
            INSERT INTO jobs (title, apply_email) VALUES ('Old job', 'hr@old.lk');
            INSERT INTO candidates (resume_hash) VALUES ('legacy-hash');
        `);

        migrate(db);

        // an account created after the upgrade, before the next start-up
        db.exec("INSERT INTO users (email, password_hash, created_at) VALUES ('new@new.lk', 'x', '2026-10-01T00:00:00.000Z')");
        migrate(db); // running it again is harmless

        const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        assert.ok(columns("jobs").includes("apply_email_source"));
        assert.ok(columns("jobs").includes("enrich_failures"));
        assert.ok(columns("matches").includes("confirmed_email"));
        assert.ok(columns("candidates").includes("user_id"));
        assert.ok(columns("users").includes("email_verified_at"));

        // Accounts that existed before verification was introduced could never have been verified, so they are
        // treated as verified, once. An account made afterwards must stay unverified through later start-ups.
        const verified = (email: string) => ({ ...db.prepare("SELECT email_verified_at FROM users WHERE email = ?").get(email) }).email_verified_at;
        assert.equal(verified("legacy@old.lk"), "2026-01-01T00:00:00.000Z");
        assert.equal(verified("new@new.lk"), null);
        // resumes stored before accounts existed come out with no owner, so nobody can open them by accident
        assert.deepEqual({ ...db.prepare("SELECT resume_hash, user_id FROM candidates").get() }, { resume_hash: "legacy-hash", user_id: null });
        assert.deepEqual({ ...db.prepare("SELECT title, apply_email, apply_email_source, enrich_failures FROM jobs").get() }, {
            title: "Old job", apply_email: "hr@old.lk", apply_email_source: null, enrich_failures: 0,
        });
    });
});
