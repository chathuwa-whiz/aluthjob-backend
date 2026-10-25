import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { clearDatabase } from "./test-helpers.js";
import { getDatabase, isUniqueViolation } from "./database.js";

const db = getDatabase();

before(async () => {
    // the first call connects and creates the tables
    await clearDatabase();
});

beforeEach(clearDatabase);

const addUser = (email: string) => db.insert("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'x', ?)", [email, new Date().toISOString()]);

describe("schema", () => {
    it("is created once and left alone on later connections", async () => {
        const id = await addUser("keep@example.test");
        const { closeDatabase } = await import("./database.js");

        await closeDatabase();
        // a new pool runs the CREATE ... IF NOT EXISTS statements again; the data must survive
        assert.equal((await db.get<{ email: string }>("SELECT email FROM users WHERE id = ?", [id]))?.email, "keep@example.test");
    });
});

describe("queries", () => {
    it("returns column names in lower case", async () => {
        await addUser("a@example.test");
        const row = await db.get<Record<string, unknown>>("SELECT id, email, last_login_at FROM users");

        assert.deepEqual(Object.keys(row!), ["id", "email", "last_login_at"]);
        assert.equal(row!.last_login_at, null);
    });

    it("binds positional (?) and named (:name) values, ignoring named values the statement does not use", async () => {
        await addUser("a@example.test");

        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = ?", ["a@example.test"]))!.n, 1);
        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = :email", { email: "a@example.test", unused: 1 }))!.n, 1);
        // the same name twice in one statement
        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = :e OR role = :e", { e: "a@example.test" }))!.n, 1);
    });

    it("stores undefined as NULL and booleans as 1/0", async () => {
        const id = await db.insert(
            "INSERT INTO mail_accounts (candidate_id, email, from_name, host, port, secure, username, password_enc, verified_at, created_at, updated_at) VALUES (?, 'a@b.test', ?, 'h', 25, ?, 'u', 'p', 'v', 'c', 'u')",
            [await candidate(), undefined, true],
            "candidate_id",
        );
        const row = await db.get<{ from_name: string | null; secure: number }>("SELECT from_name, secure FROM mail_accounts WHERE candidate_id = ?", [id]);

        assert.deepEqual(row, { from_name: null, secure: 1 });
    });

    it("returns the generated id of an insert", async () => {
        const first = await addUser("a@example.test");
        const second = await addUser("b@example.test");

        assert.ok(second > first);
    });

    it("counts the rows a statement changed", async () => {
        await addUser("a@example.test");
        await addUser("b@example.test");

        assert.equal((await db.run("UPDATE users SET role = 'admin'")).changes, 2);
        assert.equal((await db.run("UPDATE users SET role = 'admin' WHERE email = ?", ["nobody@example.test"])).changes, 0);
    });

    it("returns columns of an updated row, or nothing when no row matched", async () => {
        const id = await addUser("a@example.test");

        const hit = await db.update<{ id: number; email: string }>("UPDATE users SET role = 'admin' WHERE id = ?", [id], { id: "number", email: "string" });
        assert.deepEqual(hit, { id, email: "a@example.test" });

        assert.equal(await db.update("UPDATE users SET role = 'admin' WHERE id = ?", [-1], { id: "number" }), undefined);
    });

    it("pages with OFFSET ... FETCH", async () => {
        for (const n of [1, 2, 3, 4, 5]) await addUser(`u${n}@example.test`);

        const page = await db.all<{ email: string }>("SELECT email FROM users ORDER BY id OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY", { off: 1, lim: 2 });
        assert.deepEqual(page.map((row) => row.email), ["u2@example.test", "u3@example.test"]);
    });
});

describe("large values", () => {
    it("round-trips a resume file (BLOB) and a long text (CLOB) unchanged", async () => {
        const userId = await addUser("a@example.test");
        const file = Buffer.alloc(300_000);
        for (let i = 0; i < file.length; i++) file[i] = i % 251;
        const json = JSON.stringify({ text: "é".repeat(60_000) });

        const id = await db.insert(
            "INSERT INTO candidates (user_id, resume_hash, file_name, mime_type, file_data, profile_json, created_at, updated_at) VALUES (?, 'h', 'cv.pdf', 'application/pdf', ?, ?, 'c', 'u')",
            [userId, file, json],
        );
        const row = await db.get<{ file_data: Buffer; profile_json: string }>("SELECT file_data, profile_json FROM candidates WHERE id = ?", [id]);

        assert.ok(Buffer.isBuffer(row!.file_data));
        assert.ok(file.equals(row!.file_data));
        assert.equal(row!.profile_json, json);
    });
});

describe("constraints", () => {
    it("reports a duplicate as a unique violation", async () => {
        await addUser("dup@example.test");

        await assert.rejects(addUser("dup@example.test"), (error: unknown) => isUniqueViolation(error));
        await assert.rejects(db.run("INSERT INTO users (email, password_hash, created_at) VALUES (NULL, 'x', 'c')"), (error: unknown) => !isUniqueViolation(error));
    });

    it("deletes everything an account owns together with the account", async () => {
        const userId = await candidate().then(async (candidateId) => (await db.get<{ user_id: number }>("SELECT user_id FROM candidates WHERE id = ?", [candidateId]))!.user_id);
        await db.run("INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, 't', 'c', 'e')", [userId]);

        await db.run("DELETE FROM users WHERE id = ?", [userId]);

        for (const table of ["candidates", "sessions", "mail_accounts"]) {
            assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0, table);
        }
    });
});

describe("transactions", () => {
    it("commits when the work finishes", async () => {
        await db.transaction(async (tx) => {
            await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('t1@example.test', 'x', 'c')");
            await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('t2@example.test', 'x', 'c')");
        });

        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n, 2);
    });

    it("rolls everything back when the work throws", async () => {
        await assert.rejects(
            db.transaction(async (tx) => {
                await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('t1@example.test', 'x', 'c')");
                throw new Error("stop");
            }),
            /stop/,
        );

        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n, 0);
    });

    it("keeps going after a statement fails with a unique violation, as the job upsert relies on", async () => {
        await addUser("dup@example.test");

        await db.transaction(async (tx) => {
            await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('first@example.test', 'x', 'c')");
            await assert.rejects(tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('dup@example.test', 'x', 'c')"), (error: unknown) => isUniqueViolation(error));
            await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('second@example.test', 'x', 'c')");
        });

        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n, 3);
    });

    it("does not show uncommitted work to other connections", async () => {
        await db.transaction(async (tx) => {
            await tx.run("INSERT INTO users (email, password_hash, created_at) VALUES ('t1@example.test', 'x', 'c')");
            assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n, 0);
            assert.equal((await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n, 1);
        });
    });
});

/** A candidate with an owner; returns the candidate id. */
async function candidate(): Promise<number> {
    const userId = await addUser(`owner-${Math.random()}@example.test`);
    return db.insert(
        "INSERT INTO candidates (user_id, resume_hash, file_name, mime_type, file_data, profile_json, created_at, updated_at) VALUES (?, ?, 'cv.pdf', 'application/pdf', ?, '{}', 'c', 'u')",
        [userId, `hash-${Math.random()}`, Buffer.from("cv")],
    );
}
