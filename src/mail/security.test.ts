import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { getDatabase, type Db } from "../db/database.js";
import { setCandidateOwner } from "../candidates/candidate.repository.js";
import { reserveSend } from "./application.repository.js";

afterEach(() => mock.restoreAll());

/** Unit checks for transaction decisions; application.test.ts covers the real Oracle/SMTP integration. */
function transactionFixture(input: { owner?: number; sending?: number; usage?: number; latest?: string; email?: string; matchVersion?: string; matchStatus?: string } = {}) {
    const writes: { sql: string; binds: unknown[] }[] = [];
    const app = { id: 12, candidate_id: 5, match_id: 8, status: "queued", attempts: 0 };
    const tx = {
        get: async (sql: string) => {
            if (sql.includes("FROM candidates")) return { user_id: input.owner ?? 3 };
            if (sql.includes("FROM matches")) return { status: input.matchStatus ?? "approved", updated_at: input.matchVersion ?? "current-version" };
            if (sql.includes("COUNT(*)") && sql.includes("FROM applications")) return { n: input.sending ?? 0 };
            if (sql.includes("FROM applications")) return app;
            if (sql.includes("FROM mail_accounts")) return { email: input.email ?? "from@example.test", host: "smtp.example.test", username: "login@example.test" };
            if (sql.includes("FROM mail_send_events")) return { n: input.usage ?? 0, latest: input.latest ?? null };
            throw new Error(`Unexpected read: ${sql}`);
        },
        all: async () => [],
        run: async (sql: string, binds: unknown[] = []) => { writes.push({ sql, binds }); return { changes: 1 }; },
        insert: async (sql: string, binds: unknown[]) => { writes.push({ sql, binds }); return 42; },
    } as unknown as Db;
    mock.method(getDatabase(), "transaction", async (work: (db: Db) => Promise<unknown>) => work(tx));
    return writes;
}

describe("mail authority transaction decisions", () => {
    it("preserves a mailbox for a same-owner assignment", async () => {
        const writes = transactionFixture();
        assert.equal(await setCandidateOwner(5, 3), true);
        assert.equal(writes.length, 0);
    });

    it("refuses to transfer a candidate whose application is already sending", async () => {
        const writes = transactionFixture({ sending: 1 });
        await assert.rejects(setCandidateOwner(5, 4), /being sent/);
        assert.equal(writes.length, 0);
    });

    it("removes credentials, pending sends and approvals before committing a new owner", async () => {
        const writes = transactionFixture();
        assert.equal(await setCandidateOwner(5, 4), true);
        assert.ok(writes.some(({ sql }) => sql.startsWith("DELETE FROM mail_accounts")));
        assert.ok(writes.some(({ sql }) => sql.includes("status = 'cancelled'")));
        assert.ok(writes.some(({ sql }) => sql.includes("confirmed_email = NULL")));
        assert.ok(writes.at(-1)!.sql.startsWith("UPDATE candidates SET user_id"));
    });

    it("rejects a send snapshot from the former owner without claiming an application", async () => {
        const writes = transactionFixture({ owner: 4 });
        const result = await reserveSend(12, 3, "from@example.test", new Date(), 20, 0);
        assert.equal(result.kind, "stale");
        assert.ok(!writes.some(({ sql }) => sql.startsWith("UPDATE applications")));
    });

    it("defers an exhausted shared allowance without incrementing application attempts", async () => {
        const writes = transactionFixture({ usage: 20 });
        const result = await reserveSend(12, 3, "from@example.test", new Date(), 20, 0);
        assert.equal(result.kind, "deferred");
        assert.ok(!writes.some(({ sql }) => sql.startsWith("UPDATE applications")));
    });

    it("rejects a letter edited after its approved snapshot was prepared", async () => {
        const writes = transactionFixture({ matchVersion: "edited-version" });
        assert.equal((await reserveSend(12, 3, "from@example.test", new Date(), 20, 0, "approved-version")).kind, "stale");
        assert.ok(!writes.some(({ sql }) => sql.startsWith("UPDATE applications")));
    });

    it("rejects a match whose approval was withdrawn before the send claim", async () => {
        const writes = transactionFixture({ matchStatus: "rejected" });
        assert.equal((await reserveSend(12, 3, "from@example.test", new Date(), 20, 0, "current-version")).kind, "stale");
        assert.ok(!writes.some(({ sql }) => sql.startsWith("UPDATE applications")));
    });

    it("records only hashed mailbox identities when reserving a send", async () => {
        const writes = transactionFixture();
        const result = await reserveSend(12, 3, "from@example.test", new Date(), 20, 0);
        assert.equal(result.kind, "claimed");
        const event = writes.find(({ sql }) => sql.startsWith("INSERT INTO mail_send_events"))!;
        assert.match(String(event.binds[2]), /^[a-f0-9]{64}$/);
        assert.match(String(event.binds[3]), /^[a-f0-9]{64}$/);
        assert.notEqual(event.binds[2], event.binds[3]);
        assert.ok(!JSON.stringify(event.binds).includes("@example.test"));
    });
});
