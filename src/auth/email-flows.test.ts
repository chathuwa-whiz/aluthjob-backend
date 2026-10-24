import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { SMTPServer } from "smtp-server";

// Configuration must be in place before the modules under test are loaded
process.env.DATABASE_PATH = ":memory:";
process.env.AUTH_SCRYPT_COST = "1024"; // fast hashing for tests; production uses 32768
process.env.MAIL_SECRET = "test-secret-".repeat(4);
process.env.FRONTEND_URL = "http://localhost:3000";
delete process.env.APP_URL;
delete process.env.SYSTEM_SMTP_HOST;
delete process.env.SYSTEM_MAIL_FROM;

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase 42";

type Sent = import("../mail/system-mailer.js").OutgoingMail;
const outbox: Sent[] = [];

let base = "";
let server: import("node:http").Server;
let m: {
    db: typeof import("../db/database.js");
    users: typeof import("./user.repository.js");
    authService: typeof import("./auth.service.js");
    tokens: typeof import("./email-token.repository.js");
    mailer: typeof import("../mail/system-mailer.js");
    messages: typeof import("../mail/system-messages.js");
};

async function request(method: string, path: string, options: { cookie?: string; token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(base + path, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, redirect: "manual" });
    let json: any;
    try {
        json = await response.json();
    } catch {
        json = undefined;
    }
    return { status: response.status, json, setCookie: response.headers.getSetCookie() };
}

const cookieOf = (setCookie: string[]) => setCookie.find((value) => value.startsWith("aj_session="))?.split(";")[0] ?? "";
const tokenIn = (mail: Sent) => mail.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? "";

async function mailsTo(email: string, subject?: RegExp): Promise<Sent[]> {
    await m.authService.whenMailSettled();
    return outbox.filter((mail) => mail.to === email && (!subject || subject.test(mail.subject)));
}

const register = (email: string) => request("POST", "/auth/register", { body: { email, password: PASSWORD } });
const login = (email: string, password = PASSWORD) => request("POST", "/auth/login", { body: { email, password } });

async function confirmationToken(email: string) {
    const mail = (await mailsTo(email, /Confirm your email/)).at(-1);
    assert.ok(mail, `no confirmation email for ${email}`);
    return tokenIn(mail);
}

async function resetToken(email: string) {
    const mail = (await mailsTo(email, /Reset your/)).at(-1);
    assert.ok(mail, `no reset email for ${email}`);
    return tokenIn(mail);
}

/** Registered, link followed, signed in. */
async function verifiedUser(email: string) {
    await register(email);
    assert.equal((await request("POST", "/auth/verify-email", { body: { token: await confirmationToken(email) } })).status, 200);
    const response = await login(email);
    return { email, cookie: cookieOf(response.setCookie), id: response.json.data.user.id as number };
}

/** Registered and signed in, link not followed. */
async function unverifiedUser(email: string) {
    await register(email);
    const response = await login(email);
    return { email, cookie: cookieOf(response.setCookie), id: response.json.data.user.id as number };
}

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("./user.repository.js"),
        authService: await import("./auth.service.js"),
        tokens: await import("./email-token.repository.js"),
        mailer: await import("../mail/system-mailer.js"),
        messages: await import("../mail/system-messages.js"),
    };
    m.mailer.setSystemMailer({ send: async (mail) => void outbox.push(mail) });

    const loaded = (await import("../app.js")) as unknown as { default: { listen?: unknown; default?: unknown } };
    const app = (loaded.default.listen ? loaded.default : loaded.default.default) as import("express").Express;
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(() => {
    server.close();
});

beforeEach(() => {
    for (const limiter of Object.values(m.authService.limits)) limiter.reset();
    outbox.length = 0;
    m.mailer.setSystemMailer({ send: async (mail) => void outbox.push(mail) });
});

// ---- email verification ----------------------------------------------------------------

// Every route outside /auth, read from the source so a route added later is covered automatically
const MOUNTS: Record<string, string> = {
    "resume.routes.ts": "/resumes", "job.routes.ts": "/jobs", "candidate.routes.ts": "/candidates",
    "match.routes.ts": "/matches", "application.routes.ts": "/applications",
};

function dataEndpoints(): { method: string; path: string }[] {
    const directory = join(__dirname, "..", "routes");
    const found: { method: string; path: string }[] = [];

    for (const [file, mount] of Object.entries(MOUNTS)) {
        for (const match of readFileSync(join(directory, file), "utf8").matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
            found.push({ method: match[1]!.toUpperCase(), path: `${mount}${match[2] === "/" ? "" : match[2]}`.replace(/:\w+/g, "1") });
        }
    }
    assert.ok(readdirSync(directory).filter((name) => name.endsWith(".routes.ts")).length === Object.keys(MOUNTS).length + 1, "a new route file needs a mount point here");
    return found;
}

describe("email verification", () => {
    it("lets an unconfirmed account sign in, but nothing else", async () => {
        const user = await unverifiedUser("early@example.com");

        const me = await request("GET", "/auth/me", { cookie: user.cookie });
        assert.equal(me.status, 200);
        assert.equal(me.json.data.user.emailVerified, false);

        const endpoints = dataEndpoints();
        assert.ok(endpoints.length >= 25);
        for (const { method, path } of endpoints) {
            const response = await request(method, path, { cookie: user.cookie, ...(method !== "GET" && method !== "DELETE" && { body: {} }) });
            assert.equal(response.status, 403, `${method} ${path} -> ${response.status}`);
            assert.equal(response.json.code, "EMAIL_NOT_VERIFIED", `${method} ${path}`);
        }
    });

    it("keeps the account-management routes open to an unconfirmed user", async () => {
        const user = await unverifiedUser("manage@example.com");

        assert.equal((await request("POST", "/auth/resend-verification", { cookie: user.cookie })).status, 202);
        const change = await request("POST", "/auth/change-password", { cookie: user.cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
        assert.equal(change.status, 200);
        assert.equal((await request("DELETE", "/auth/account", { cookie: user.cookie, body: { password: NEW_PASSWORD } })).status, 200);
    });

    it("unlocks the service once the link is followed, even for a session that already exists", async () => {
        const user = await unverifiedUser("unlock@example.com");
        assert.equal((await request("GET", "/candidates", { cookie: user.cookie })).status, 403);

        assert.equal((await request("POST", "/auth/verify-email", { body: { token: await confirmationToken(user.email) } })).status, 200);

        assert.equal((await request("GET", "/candidates", { cookie: user.cookie })).status, 200, "no need to sign in again");
        assert.equal((await request("GET", "/auth/me", { cookie: user.cookie })).json.data.user.emailVerified, true);
    });

    it("emails a link that carries the token in the fragment, never in the query string", async () => {
        await register("link@example.com");
        const [mail] = await mailsTo("link@example.com");

        assert.match(mail!.text, /http:\/\/localhost:3000\/verify-email#token=[A-Za-z0-9_-]{40,}/);
        assert.doesNotMatch(mail!.text, /\?token=|&token=/);
        assert.doesNotMatch(mail!.text, /<[a-z]+[ >]/i, "plain text: no HTML, no tracking pixels");
    });

    it("works once only, and a second use fails like any invalid link", async () => {
        await register("once@example.com");
        const token = await confirmationToken("once@example.com");

        assert.equal((await request("POST", "/auth/verify-email", { body: { token } })).status, 200);
        assert.equal((await request("POST", "/auth/verify-email", { body: { token } })).status, 400);
    });

    it("cannot be used twice by two requests racing with the same link", async () => {
        await register("race@example.com");
        const token = await confirmationToken("race@example.com");

        const results = await Promise.all(Array.from({ length: 5 }, () => request("POST", "/auth/verify-email", { body: { token } })));
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400, 400, 400]);
    });

    it("answers unknown, expired, used and malformed links identically", async () => {
        await register("same@example.com");
        const token = await confirmationToken("same@example.com");
        m.db.getDatabase().prepare("UPDATE email_tokens SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());

        const expired = await request("POST", "/auth/verify-email", { body: { token } });
        const unknown = await request("POST", "/auth/verify-email", { body: { token: "x".repeat(43) } });

        assert.equal(expired.status, 400);
        assert.deepEqual(expired.json, unknown.json);
        assert.equal((await request("POST", "/auth/verify-email", { body: { token: "short" } })).status, 400);
        assert.equal((await request("POST", "/auth/verify-email", { body: {} })).status, 400);
        assert.equal(m.users.findUserWithHash("same@example.com")!.emailVerified, false);
    });

    it("only counts for the address it was sent to", async () => {
        const user = await unverifiedUser("moved@example.com");
        const token = await confirmationToken(user.email);

        m.db.getDatabase().prepare("UPDATE users SET email = 'someone-else@example.com' WHERE id = ?").run(user.id);

        assert.equal((await request("POST", "/auth/verify-email", { body: { token } })).status, 400);
        assert.equal(m.users.getUser(user.id)!.emailVerified, false);
    });

    it("stores only a hash of each link token", async () => {
        await register("hashed@example.com");
        const token = await confirmationToken("hashed@example.com");

        const rows = m.db.getDatabase().prepare("SELECT token_hash FROM email_tokens").all() as { token_hash: string }[];
        assert.ok(rows.length >= 1);
        assert.ok(rows.every((row) => row.token_hash !== token && !row.token_hash.includes(token)));
    });

    it("does not accept a password-reset link as a confirmation link, or the other way round", async () => {
        const user = await unverifiedUser("purpose@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const reset = await resetToken(user.email);
        const confirm = await confirmationToken(user.email);

        assert.equal((await request("POST", "/auth/verify-email", { body: { token: reset } })).status, 400);
        assert.equal((await request("POST", "/auth/reset-password", { body: { token: confirm, newPassword: NEW_PASSWORD } })).status, 400);
        assert.equal(m.users.getUser(user.id)!.emailVerified, false);
        assert.equal((await login(user.email)).status, 200, "the password was not changed");
    });

    it("limits how many wrong links one address may try", async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
            assert.equal((await request("POST", "/auth/verify-email", { body: { token: `${attempt}`.padStart(40, "x") } })).status, 400);
        }
        assert.equal((await request("POST", "/auth/verify-email", { body: { token: "y".repeat(40) } })).status, 429);
    });

    it("lets a signed-in user ask for a new link, which replaces the old one", async () => {
        const user = await unverifiedUser("resend@example.com");
        const first = await confirmationToken(user.email);

        assert.equal((await request("POST", "/auth/resend-verification", { cookie: user.cookie })).status, 202);
        const second = await confirmationToken(user.email);

        assert.notEqual(first, second);
        assert.equal((await request("POST", "/auth/verify-email", { body: { token: first } })).status, 400, "the old link stopped working");
        assert.equal((await request("POST", "/auth/verify-email", { body: { token: second } })).status, 200);
    });

    it("limits resends, refuses them for a confirmed account, and needs a session", async () => {
        const user = await unverifiedUser("limit@example.com");
        for (let n = 0; n < 3; n++) assert.equal((await request("POST", "/auth/resend-verification", { cookie: user.cookie })).status, 202);
        assert.equal((await request("POST", "/auth/resend-verification", { cookie: user.cookie })).status, 429);

        const done = await verifiedUser("done@example.com");
        assert.equal((await request("POST", "/auth/resend-verification", { cookie: done.cookie })).status, 409);
        assert.equal((await request("POST", "/auth/resend-verification")).status, 401);
    });

    it("refuses to register when the server cannot send email, rather than creating accounts nobody can confirm", async () => {
        const original = process.env.NODE_ENV;
        m.mailer.setSystemMailer(undefined);
        process.env.NODE_ENV = "production";

        try {
            const response = await register("nomail@example.com");
            assert.equal(response.status, 503);
            assert.match(response.json.message, /SYSTEM_SMTP_HOST/);
            assert.equal(m.users.findUserWithHash("nomail@example.com"), undefined);
            assert.equal((await request("POST", "/auth/forgot-password", { body: { email: "nomail@example.com" } })).status, 503);
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    it("still answers normally when the mail server is down, and does not wait for it", async () => {
        const logged: unknown[] = [];
        const realError = console.error;
        console.error = (...args: unknown[]) => void logged.push(args);
        m.mailer.setSystemMailer({ send: () => new Promise((_, reject) => setTimeout(() => reject(new Error("smtp down")), 400)) });

        try {
            const started = Date.now();
            const response = await register("down@example.com");

            assert.equal(response.status, 202);
            assert.ok(Date.now() - started < 300, "the response did not wait for the mail server");
            await m.authService.whenMailSettled();
            assert.ok(logged.length >= 1, "the failure is logged for the operator");
            assert.ok(!JSON.stringify(response.json).includes("smtp down"), "and not shown to the caller");
        } finally {
            console.error = realError;
        }
    });
});

// ---- password reset --------------------------------------------------------------------

describe("password reset", () => {
    it("answers identically for an address with an account and one without, and mails only the former", async () => {
        await verifiedUser("known@example.com");
        outbox.length = 0;

        const known = await request("POST", "/auth/forgot-password", { body: { email: "known@example.com" } });
        const unknown = await request("POST", "/auth/forgot-password", { body: { email: "nobody@example.com" } });

        assert.equal(known.status, 202);
        assert.equal(unknown.status, 202);
        assert.deepEqual(known.json, unknown.json);

        assert.equal((await mailsTo("known@example.com", /Reset your/)).length, 1);
        assert.equal((await mailsTo("nobody@example.com")).length, 0);
    });

    it("does not take longer for an address with an account, even when sending mail is slow", async () => {
        await verifiedUser("timing@example.com");
        m.mailer.setSystemMailer({ send: () => new Promise((resolve) => setTimeout(resolve, 500)) });

        const known = Date.now();
        await request("POST", "/auth/forgot-password", { body: { email: "timing@example.com" } });
        const knownMs = Date.now() - known;

        const unknown = Date.now();
        await request("POST", "/auth/forgot-password", { body: { email: "ghost@example.com" } });
        const unknownMs = Date.now() - unknown;

        assert.ok(knownMs < 300 && unknownMs < 300, `responses took ${knownMs} ms and ${unknownMs} ms: they must not wait for the mail`);
        await m.authService.whenMailSettled();
    });

    it("cannot be used to flood someone's inbox, and shows nothing when it declines", async () => {
        await verifiedUser("victim@example.com");
        outbox.length = 0;

        const statuses: number[] = [];
        for (let n = 0; n < 6; n++) statuses.push((await request("POST", "/auth/forgot-password", { body: { email: "victim@example.com" } })).status);

        assert.deepEqual(statuses, [202, 202, 202, 202, 202, 202]);
        assert.equal((await mailsTo("victim@example.com", /Reset your/)).length, 3);
    });

    it("limits requests per address", async () => {
        for (let n = 0; n < 10; n++) assert.equal((await request("POST", "/auth/forgot-password", { body: { email: `bulk${n}@example.com` } })).status, 202);
        assert.equal((await request("POST", "/auth/forgot-password", { body: { email: "bulk11@example.com" } })).status, 429);
    });

    it("rejects malformed requests", async () => {
        assert.equal((await request("POST", "/auth/forgot-password", { body: { email: "nope" } })).status, 400);
        assert.equal((await request("POST", "/auth/forgot-password", { body: {} })).status, 400);
        assert.equal((await request("POST", "/auth/reset-password", { body: { token: "x".repeat(30) } })).status, 400);
    });

    it("sets a new password from the emailed link, and signs every device out", async () => {
        const first = await verifiedUser("flow@example.com");
        const second = cookieOf((await login(first.email)).setCookie);

        await request("POST", "/auth/forgot-password", { body: { email: first.email } });
        const token = await resetToken(first.email);
        const [mail] = await mailsTo(first.email, /Reset your/);
        assert.match(mail!.text, /http:\/\/localhost:3000\/reset-password#token=/);

        const reset = await request("POST", "/auth/reset-password", { body: { token, newPassword: NEW_PASSWORD } });
        assert.equal(reset.status, 200);
        assert.equal(reset.setCookie.length, 0, "resetting does not sign anyone in");

        assert.equal((await request("GET", "/auth/me", { cookie: first.cookie })).status, 401);
        assert.equal((await request("GET", "/auth/me", { cookie: second })).status, 401);
        assert.equal((await login(first.email, PASSWORD)).status, 401, "the old password is dead");
        assert.equal((await login(first.email, NEW_PASSWORD)).status, 200);

        const [notice] = await mailsTo(first.email, /password was changed/);
        assert.match(notice!.text, /reset using an emailed link/);
    });

    it("does not spend the link when the new password is rejected", async () => {
        const user = await verifiedUser("weak@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);

        for (const newPassword of ["short", "password123", "weak-at-example"]) {
            const response = await request("POST", "/auth/reset-password", { body: { token, newPassword } });
            assert.equal(response.status, 409, newPassword);
        }
        assert.ok(m.tokens.peekEmailToken("reset", token), "the link still works");

        assert.equal((await request("POST", "/auth/reset-password", { body: { token, newPassword: NEW_PASSWORD } })).status, 200);
    });

    it("works once only", async () => {
        const user = await verifiedUser("single@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);

        assert.equal((await request("POST", "/auth/reset-password", { body: { token, newPassword: NEW_PASSWORD } })).status, 200);
        assert.equal((await request("POST", "/auth/reset-password", { body: { token, newPassword: "an even newer passphrase 7" } })).status, 400);
        assert.equal((await login(user.email, NEW_PASSWORD)).status, 200, "the second attempt changed nothing");
    });

    it("cannot be used twice by two requests racing with the same link", async () => {
        const user = await verifiedUser("racereset@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);

        const results = await Promise.all(Array.from({ length: 4 }, (_, n) => request("POST", "/auth/reset-password", { body: { token, newPassword: `${NEW_PASSWORD} ${n}` } })));
        assert.equal(results.filter((r) => r.status === 200).length, 1);
    });

    it("expires, and then fails like any invalid link", async () => {
        const user = await verifiedUser("late@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);
        m.db.getDatabase().prepare("UPDATE email_tokens SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());

        const expired = await request("POST", "/auth/reset-password", { body: { token, newPassword: NEW_PASSWORD } });
        const unknown = await request("POST", "/auth/reset-password", { body: { token: "z".repeat(43), newPassword: NEW_PASSWORD } });

        assert.equal(expired.status, 400);
        assert.deepEqual(expired.json, unknown.json);
        assert.equal((await login(user.email)).status, 200);
    });

    it("lets only the newest link work", async () => {
        const user = await verifiedUser("newest@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const older = await resetToken(user.email);
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const newer = await resetToken(user.email);

        assert.notEqual(older, newer);
        assert.equal((await request("POST", "/auth/reset-password", { body: { token: older, newPassword: NEW_PASSWORD } })).status, 400);
        assert.equal((await request("POST", "/auth/reset-password", { body: { token: newer, newPassword: NEW_PASSWORD } })).status, 200);
    });

    it("also confirms the address, since only its owner can read the link", async () => {
        const user = await unverifiedUser("locked-out@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });

        await request("POST", "/auth/reset-password", { body: { token: await resetToken(user.email), newPassword: NEW_PASSWORD } });

        const signedIn = await login(user.email, NEW_PASSWORD);
        assert.equal(signedIn.json.data.user.emailVerified, true);
        assert.equal((await request("GET", "/candidates", { cookie: cookieOf(signedIn.setCookie) })).status, 200);
    });

    it("is withdrawn when the user changes their password from inside the account", async () => {
        const user = await verifiedUser("changed@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);

        const change = await request("POST", "/auth/change-password", { cookie: user.cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
        assert.equal(change.status, 200);

        assert.equal((await request("POST", "/auth/reset-password", { body: { token, newPassword: "yet another passphrase 9" } })).status, 400);
        const [notice] = await mailsTo(user.email, /password was changed/);
        assert.match(notice!.text, /changed from within your account/);
    });

    it("is not a session: the link token cannot be used to sign in", async () => {
        const user = await verifiedUser("notasession@example.com");
        await request("POST", "/auth/forgot-password", { body: { email: user.email } });
        const token = await resetToken(user.email);

        assert.equal((await request("GET", "/auth/me", { token })).status, 401);
        assert.equal((await request("GET", "/auth/me", { cookie: `aj_session=${token}` })).status, 401);
    });

    it("limits wrong links per address, shared with confirmation links", async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
            assert.equal((await request("POST", "/auth/reset-password", { body: { token: `${attempt}`.padStart(40, "q"), newPassword: NEW_PASSWORD } })).status, 400);
        }
        assert.equal((await request("POST", "/auth/reset-password", { body: { token: "r".repeat(40), newPassword: NEW_PASSWORD } })).status, 429);
    });
});

// ---- the system mailer -----------------------------------------------------------------

describe("system mailer", () => {
    it("prints to the console in development instead of sending", async () => {
        const realLog = console.log;
        console.log = () => undefined;
        m.mailer.setSystemMailer(undefined);
        const before = m.mailer.devOutbox.length;

        try {
            await m.mailer.getSystemMailer().send({ to: "dev@example.com", subject: "Hello", text: "Body" });
        } finally {
            console.log = realLog;
        }

        assert.equal(m.mailer.devOutbox.length, before + 1);
        assert.equal(m.mailer.devOutbox.at(-1)!.to, "dev@example.com");
    });

    it("requires SYSTEM_MAIL_FROM when an SMTP host is configured", () => {
        m.mailer.setSystemMailer(undefined);
        process.env.SYSTEM_SMTP_HOST = "127.0.0.1";
        delete process.env.SYSTEM_MAIL_FROM;

        try {
            assert.throws(() => m.mailer.getSystemMailer(), /SYSTEM_MAIL_FROM/);
        } finally {
            delete process.env.SYSTEM_SMTP_HOST;
        }
    });

    it("sends plain-text mail through the configured SMTP server", async () => {
        const received: string[] = [];
        const smtp = new SMTPServer({
            authOptional: true,
            disabledCommands: ["STARTTLS"],
            onData: (stream, _session, done) => {
                const chunks: Buffer[] = [];
                stream.on("data", (chunk) => chunks.push(chunk));
                stream.on("end", () => {
                    received.push(Buffer.concat(chunks).toString("utf8"));
                    done();
                });
            },
        });
        await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));

        m.mailer.setSystemMailer(undefined);
        process.env.SYSTEM_SMTP_HOST = "127.0.0.1";
        process.env.SYSTEM_SMTP_PORT = String((smtp.server.address() as AddressInfo).port);
        process.env.SYSTEM_MAIL_FROM = "AluthJob <no-reply@example.test>";

        try {
            await m.mailer.getSystemMailer().send({ to: "person@example.com", subject: "Confirm", text: "Follow the link" });
        } finally {
            delete process.env.SYSTEM_SMTP_HOST;
            delete process.env.SYSTEM_SMTP_PORT;
            delete process.env.SYSTEM_MAIL_FROM;
            await new Promise<void>((resolve) => smtp.close(() => resolve()));
        }

        assert.equal(received.length, 1);
        assert.match(received[0]!, /^From: AluthJob <no-reply@example\.test>/m);
        assert.match(received[0]!, /^To: person@example\.com/m);
        assert.match(received[0]!, /^Subject: Confirm/m);
        assert.match(received[0]!, /Follow the link/);
        assert.doesNotMatch(received[0]!, /text\/html/i);
    });
});

describe("message links", () => {
    it("point at APP_URL when set, otherwise at the front end", () => {
        assert.equal(m.messages.verificationLink("abc"), "http://localhost:3000/verify-email#token=abc");

        process.env.APP_URL = "https://jobs.example.com/";
        try {
            assert.equal(m.messages.verificationLink("abc"), "https://jobs.example.com/verify-email#token=abc");
            assert.equal(m.messages.resetLink("abc"), "https://jobs.example.com/reset-password#token=abc");
        } finally {
            delete process.env.APP_URL;
        }
    });

    it("keep the account-exists notice free of any token", () => {
        const mail = m.messages.alreadyRegisteredMessage("owner@example.com");
        assert.doesNotMatch(mail.text, /token/);
        assert.match(mail.text, /forgot-password/);
    });
});
