import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { connectMailbox } from "./mail-account.service.js";

describe("mailbox connection abuse limits", () => {
    it("counts failures before verification and shares the hourly limit across a user's resumes", async () => {
        const previous = process.env.MAIL_ALLOW_LOCAL;
        process.env.MAIL_ALLOW_LOCAL = "false";
        try {
            const input = { email: "applicant@example.test", password: "test", host: "127.0.0.1", port: 587, secure: false };
            for (let attempt = 0; attempt < 10; attempt++) {
                await assert.rejects(connectMailbox(attempt + 1, input, 90001), /public address/);
            }
            await assert.rejects(connectMailbox(999, input, 90001), /Too many mailbox connection attempts/);
            await assert.rejects(connectMailbox(999, input, 90002), /public address/, "another user has an independent allowance");
        } finally {
            if (previous === undefined) delete process.env.MAIL_ALLOW_LOCAL; else process.env.MAIL_ALLOW_LOCAL = previous;
        }
    });

    it("bounds simultaneous SMTP connections and releases capacity after failures", async () => {
        const previousMode = process.env.NODE_ENV;
        const previousLocal = process.env.MAIL_ALLOW_LOCAL;
        process.env.NODE_ENV = "test";
        process.env.MAIL_ALLOW_LOCAL = "true";
        const pending: (() => void)[] = [];
        let hold = true;
        const smtp = new SMTPServer({
            authOptional: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
            onAuth: (_auth, _session, done) => {
                if (hold) pending.push(() => done(new Error("test refusal")));
                else done(new Error("test refusal"));
            },
        });
        await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
        const input = { email: "applicant@example.test", password: "test", host: "127.0.0.1", port: (smtp.server.address() as AddressInfo).port, secure: false };
        const attempts = Array.from({ length: 4 }, (_, index) => connectMailbox(index + 1, input, 91000 + index).catch((error: unknown) => error));
        try {
            for (let tries = 0; pending.length < 4; tries++) {
                if (tries > 200) assert.fail("SMTP connections did not reach verification");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await assert.rejects(connectMailbox(5, input, 92000), /Connecting mailboxes is busy/);
            hold = false;
            for (const fail of pending.splice(0)) fail();
            const errors = await Promise.all(attempts);
            assert.ok(errors.every((error) => error instanceof Error));
            await assert.rejects(connectMailbox(5, input, 92000), /rejected the login|test refusal/);
        } finally {
            hold = false;
            for (const fail of pending.splice(0)) fail();
            await Promise.all(attempts);
            await new Promise<void>((resolve) => smtp.close(() => resolve()));
            if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
            if (previousLocal === undefined) delete process.env.MAIL_ALLOW_LOCAL; else process.env.MAIL_ALLOW_LOCAL = previousLocal;
        }
    });
});
