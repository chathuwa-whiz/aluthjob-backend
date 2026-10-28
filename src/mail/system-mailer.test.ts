import assert from "node:assert/strict";
import { it, mock } from "node:test";
import nodemailer from "nodemailer";
import { getSystemMailer } from "./system-mailer.js";

it("requires STARTTLS for production account email delivery", async () => {
    const names = ["NODE_ENV", "SYSTEM_SMTP_HOST", "SYSTEM_MAIL_FROM", "SYSTEM_SMTP_PORT", "SYSTEM_SMTP_SECURE"] as const;
    const before = names.map((name) => process.env[name]);
    let options: Record<string, unknown> | undefined;
    const intercept = mock.method(nodemailer, "createTransport", (settings: unknown) => {
        options = settings as Record<string, unknown>;
        return { sendMail: async () => ({ messageId: "test" }) } as never;
    });
    try {
        process.env.NODE_ENV = "production";
        process.env.SYSTEM_SMTP_HOST = "production-tls-test.example";
        process.env.SYSTEM_MAIL_FROM = "noreply@example.com";
        process.env.SYSTEM_SMTP_PORT = "587";
        process.env.SYSTEM_SMTP_SECURE = "false";
        await getSystemMailer().send({ to: "user@example.com", subject: "test", text: "test" });
        assert.equal(options?.secure, false);
        assert.equal(options?.requireTLS, true);
    } finally {
        intercept.mock.restore();
        names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
    }
});
