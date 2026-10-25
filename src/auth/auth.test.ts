import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// Configuration must be in place before the modules under test are loaded
import { clearDatabase } from "../db/test-helpers.js";
process.env.AUTH_SCRYPT_COST = "1024"; // fast hashing for tests; production uses 32768
process.env.MAIL_SECRET = "test-secret-".repeat(4);
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.SESSION_DAYS = "30";
delete process.env.COOKIE_SECURE;

const PASSWORD = "correct horse battery";
const CV = Buffer.from("%PDF-1.4 secret cv of user A");

type Api = Awaited<ReturnType<typeof request>>;
let base = "";
let server: import("node:http").Server;
let m: {
    db: typeof import("../db/database.js");
    users: typeof import("./user.repository.js");
    authService: typeof import("./auth.service.js");
    password: typeof import("./password.js");
    middleware: typeof import("./middleware.js");
    candidates: typeof import("../candidates/candidate.repository.js");
    jobs: typeof import("../jobs/job.repository.js");
    matches: typeof import("../matching/match.repository.js");
    apps: typeof import("../mail/application.repository.js");
    mailboxes: typeof import("../mail/mail-account.repository.js");
    resume: typeof import("../services/resume.service.js");
    mailer: typeof import("../mail/system-mailer.js");
    tokens: typeof import("./email-token.repository.js");
};

// Every email the service "sends" lands here instead of a real mail server
type Sent = import("../mail/system-mailer.js").OutgoingMail;
const outbox: Sent[] = [];

async function request(
    method: string,
    path: string,
    options: { cookie?: string; token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(base + path, {
        method,
        headers,
        body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        redirect: "manual",
    });
    const text = await response.arrayBuffer().then((buffer) => Buffer.from(buffer));
    let json: any;
    try {
        json = JSON.parse(text.toString("utf8"));
    } catch {
        json = undefined;
    }

    return { status: response.status, json, headers: response.headers, setCookie: response.headers.getSetCookie(), bytes: text };
}

const cookieOf = (response: Api) => response.setCookie.find((value) => value.startsWith("aj_session="))?.split(";")[0] ?? "";
const tokenOf = (cookie: string) => cookie.slice("aj_session=".length);

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("./user.repository.js"),
        authService: await import("./auth.service.js"),
        password: await import("./password.js"),
        middleware: await import("./middleware.js"),
        candidates: await import("../candidates/candidate.repository.js"),
        jobs: await import("../jobs/job.repository.js"),
        matches: await import("../matching/match.repository.js"),
        apps: await import("../mail/application.repository.js"),
        mailboxes: await import("../mail/mail-account.repository.js"),
        resume: await import("../services/resume.service.js"),
        mailer: await import("../mail/system-mailer.js"),
        tokens: await import("./email-token.repository.js"),
    };
    m.mailer.setSystemMailer({ send: async (mail) => void outbox.push(mail) });
    // a default export reached through dynamic import() of a CommonJS module can arrive wrapped one level deeper
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
    delete process.env.COOKIE_SECURE;
    outbox.length = 0;
});

/** Emails are sent after the response, so wait for them before looking in the outbox. */
async function mailsTo(email: string, subject?: RegExp): Promise<Sent[]> {
    await m.authService.whenMailSettled();
    return outbox.filter((mail) => mail.to === email && (!subject || subject.test(mail.subject)));
}

/** The one-time token inside the link of an email. */
const tokenIn = (mail: Sent) => mail.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? "";

async function verificationTokenFor(email: string) {
    const [mail] = await mailsTo(email, /Confirm your email/);
    assert.ok(mail, `no confirmation email was sent to ${email}`);
    return tokenIn(mail);
}

/** The full path a real person takes: register, follow the emailed link, sign in. */
async function signUp(email: string) {
    const registered = await request("POST", "/auth/register", { body: { email, password: PASSWORD } });
    assert.equal(registered.status, 202, JSON.stringify(registered.json));

    const verified = await request("POST", "/auth/verify-email", { body: { token: await verificationTokenFor(email) } });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));

    const loggedIn = await request("POST", "/auth/login", { body: { email, password: PASSWORD } });
    assert.equal(loggedIn.status, 200);
    return { cookie: cookieOf(loggedIn), id: loggedIn.json.data.user.id as number, email };
}

/** Registered and signed in, but has not followed the link. */
async function signUpUnverified(email: string) {
    assert.equal((await request("POST", "/auth/register", { body: { email, password: PASSWORD } })).status, 202);

    const loggedIn = await request("POST", "/auth/login", { body: { email, password: PASSWORD } });
    assert.equal(loggedIn.status, 200);
    return { cookie: cookieOf(loggedIn), id: loggedIn.json.data.user.id as number, email };
}

// ---- registration, sessions ------------------------------------------------------------

describe("registration and sessions", () => {
    it("registers without signing anyone in, and only emails a confirmation link", async () => {
        const response = await request("POST", "/auth/register", { body: { email: "New.User@Example.com", password: PASSWORD } });

        assert.equal(response.status, 202);
        assert.equal(response.setCookie.length, 0, "no session until the address is confirmed");
        assert.equal(response.json.data.user, undefined);
        assert.equal(response.json.data.token, undefined);

        const raw = JSON.stringify(response.json);
        assert.ok(!/password|hash|scrypt/i.test(raw), "no credential material in the response");
        assert.ok(!raw.includes(PASSWORD));

        const stored = await m.users.findUserWithHash("new.user@example.com");
        assert.ok(stored, "emails are normalised");
        assert.equal(stored.role, "user");
        assert.equal(stored.emailVerified, false);
        assert.equal((await m.db.getDatabase().get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions"))!.n, 0);
    });

    it("sets an HttpOnly, SameSite cookie when the user signs in", async () => {
        await signUp("cookie@example.com");
        const response = await request("POST", "/auth/login", { body: { email: "cookie@example.com", password: PASSWORD } });

        const cookie = response.setCookie[0]!;
        assert.match(cookie, /^aj_session=/);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.match(cookie, /Path=\//);
        assert.doesNotMatch(cookie, /Secure/i, "Secure is for production over https");
        assert.ok(!/password|hash|scrypt/i.test(JSON.stringify(response.json)));
    });

    it("marks the cookie Secure when configured for production", async () => {
        await signUp("secure@example.com");

        process.env.COOKIE_SECURE = "true";
        const response = await request("POST", "/auth/login", { body: { email: "secure@example.com", password: PASSWORD } });
        assert.match(response.setCookie[0]!, /Secure/);
    });

    it("recognises the session on later requests, and rejects missing or forged ones", async () => {
        const { cookie } = await signUp("me@example.com");

        const me = await request("GET", "/auth/me", { cookie });
        assert.equal(me.status, 200);
        assert.equal(me.json.data.user.email, "me@example.com");

        assert.equal((await request("GET", "/auth/me")).status, 401);
        assert.equal((await request("GET", "/auth/me", { cookie: "aj_session=not-a-real-token" })).status, 401);
        assert.equal((await request("GET", "/auth/me", { token: "not-a-real-token" })).status, 401);
    });

    it("gives scripts a bearer token, and no cookie, when asked", async () => {
        await signUp("script@example.com");

        const response = await request("POST", "/auth/login", { body: { email: "script@example.com", password: PASSWORD, issueToken: true } });

        assert.equal(response.setCookie.length, 0);
        const token = response.json.data.token as string;
        assert.ok(token.length >= 40);
        assert.equal((await request("GET", "/auth/me", { token })).status, 200);

        const again = await request("POST", "/auth/login", { body: { email: "script@example.com", password: PASSWORD, issueToken: true } });
        assert.notEqual(again.json.data.token, token, "each login is its own session");
    });

    it("stores only a hash of the session token", async () => {
        const { cookie } = await signUp("hashed@example.com");
        const rows = await m.db.getDatabase().all<{ token_hash: string }>("SELECT token_hash FROM sessions");

        assert.ok(rows.length >= 1);
        assert.ok(rows.every((row) => row.token_hash !== tokenOf(cookie) && !row.token_hash.includes(tokenOf(cookie))));
    });

    it("answers a repeat registration exactly like a first one, and tells only the real owner", async () => {
        await signUp("dup@example.com");
        outbox.length = 0;

        const first = await request("POST", "/auth/register", { body: { email: "fresh@example.com", password: PASSWORD } });
        const again = await request("POST", "/auth/register", { body: { email: "DUP@example.com", password: PASSWORD } });

        assert.equal(again.status, first.status);
        assert.deepEqual(again.json, first.json, "the page cannot tell a new address from a taken one");
        assert.equal(again.setCookie.length, 0);

        assert.equal((await m.db.getDatabase().get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = ?", ["dup@example.com"]))!.n, 1);

        const [notice] = await mailsTo("dup@example.com");
        assert.match(notice!.subject, /Someone tried to sign up/);
        assert.doesNotMatch(notice!.text, /#token=/, "the notice carries no link that could take over the account");
        assert.match((await mailsTo("fresh@example.com"))[0]!.subject, /Confirm your email/);
    });

    it("refuses weak passwords and creates no account for them", async () => {
        const attempts: [string, RegExp][] = [
            ["short1", /at least 10/],
            ["password123", /too common/],
            ["aaaaaaaaaaaa", /too common/],
            ["weakname@example.com", /email/],
            ["myweakname2024", /email/],
        ];

        for (const [password, message] of attempts) {
            const response = await request("POST", "/auth/register", { body: { email: "weakname@example.com", password } });
            assert.equal(response.status, 409, password);
            assert.match(response.json.message, message, password);
        }
        assert.equal(await m.users.findUserWithHash("weakname@example.com"), undefined);
    });

    it("rejects malformed input and bad JSON without crashing", async () => {
        assert.equal((await request("POST", "/auth/register", { body: { email: "not-an-email", password: PASSWORD } })).status, 400);
        assert.equal((await request("POST", "/auth/login", { body: {} })).status, 400);
        assert.equal((await request("POST", "/auth/login", { rawBody: "{not json" })).status, 400);
    });

    it("logs out: the session stops working, even for a copy of the cookie", async () => {
        const { cookie } = await signUp("out@example.com");

        const response = await request("POST", "/auth/logout", { cookie });
        assert.equal(response.status, 200);
        assert.match(response.setCookie.join(";"), /aj_session=;/, "the browser is told to delete the cookie");

        assert.equal((await request("GET", "/auth/me", { cookie })).status, 401);
    });

    it("lets anyone log out, so a stale cookie can always be cleared", async () => {
        assert.equal((await request("POST", "/auth/logout")).status, 200);
        assert.equal((await request("POST", "/auth/logout", { cookie: "aj_session=stale" })).status, 200);
    });

    it("rejects expired sessions and purges them", async () => {
        const { cookie } = await signUp("expired@example.com");
        await m.db.getDatabase().run("UPDATE sessions SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);

        assert.equal((await request("GET", "/auth/me", { cookie })).status, 401);
        assert.ok(await m.authService.purgeExpiredSessions() >= 1);
        assert.equal((await m.db.getDatabase().get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions"))!.n, 0);
    });
});

// ---- login -----------------------------------------------------------------------------

describe("login", () => {
    it("signs in with the right password", async () => {
        await signUp("login@example.com");

        const response = await request("POST", "/auth/login", { body: { email: "Login@Example.com", password: PASSWORD } });
        assert.equal(response.status, 200);
        assert.ok(cookieOf(response));
    });

    it("gives the same answer for a wrong password and for an unknown address", async () => {
        await signUp("known@example.com");

        const wrongPassword = await request("POST", "/auth/login", { body: { email: "known@example.com", password: "wrong password here" } });
        const unknownUser = await request("POST", "/auth/login", { body: { email: "nobody@example.com", password: "wrong password here" } });

        assert.equal(wrongPassword.status, 401);
        assert.equal(unknownUser.status, 401);
        assert.deepEqual(wrongPassword.json, unknownUser.json);
    });

    it("locks an account after repeated failures, even for the correct password, and says when to retry", async () => {
        await signUp("locked@example.com");
        const bad = () => request("POST", "/auth/login", { body: { email: "locked@example.com", password: "nope nope nope" } });

        for (let attempt = 0; attempt < 8; attempt++) assert.equal((await bad()).status, 401);

        const blocked = await bad();
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers.get("retry-after")) > 0);

        const correct = await request("POST", "/auth/login", { body: { email: "locked@example.com", password: PASSWORD } });
        assert.equal(correct.status, 429, "the right password does not bypass the lock");
    });

    it("lets one account's lockout leave other accounts alone, and a success reset the count", async () => {
        await signUp("busy@example.com");
        await signUp("other@example.com");
        const bad = (email: string) => request("POST", "/auth/login", { body: { email, password: "nope nope nope" } });

        for (let attempt = 0; attempt < 7; attempt++) await bad("busy@example.com");
        assert.equal((await request("POST", "/auth/login", { body: { email: "busy@example.com", password: PASSWORD } })).status, 200);
        for (let attempt = 0; attempt < 7; attempt++) assert.equal((await bad("busy@example.com")).status, 401, "count restarted after the success");

        for (let attempt = 0; attempt < 8; attempt++) await bad("victim@example.com");
        assert.equal((await request("POST", "/auth/login", { body: { email: "other@example.com", password: PASSWORD } })).status, 200);
    });

    it("limits sign-ups per address", async () => {
        for (let n = 0; n < 10; n++) await request("POST", "/auth/register", { body: { email: `spam${n}@example.com`, password: PASSWORD } });

        const eleventh = await request("POST", "/auth/register", { body: { email: "spam11@example.com", password: PASSWORD } });
        assert.equal(eleventh.status, 429);
    });
});

// ---- password change and account deletion ----------------------------------------------

describe("account management", () => {
    it("changes the password, keeps this session, and signs every other session out", async () => {
        const first = await signUp("change@example.com");
        const second = cookieOf(await request("POST", "/auth/login", { body: { email: "change@example.com", password: PASSWORD } }));

        const wrong = await request("POST", "/auth/change-password", { cookie: first.cookie, body: { currentPassword: "not it at all", newPassword: "a brand new passphrase" } });
        assert.equal(wrong.status, 401);

        const weak = await request("POST", "/auth/change-password", { cookie: first.cookie, body: { currentPassword: PASSWORD, newPassword: "short" } });
        assert.equal(weak.status, 409);

        const changed = await request("POST", "/auth/change-password", { cookie: first.cookie, body: { currentPassword: PASSWORD, newPassword: "a brand new passphrase" } });
        assert.equal(changed.status, 200);

        assert.equal((await request("GET", "/auth/me", { cookie: first.cookie })).status, 200, "the session that changed it stays");
        assert.equal((await request("GET", "/auth/me", { cookie: second })).status, 401, "other sessions are revoked");
        assert.equal((await request("POST", "/auth/login", { body: { email: "change@example.com", password: PASSWORD } })).status, 401);
        assert.equal((await request("POST", "/auth/login", { body: { email: "change@example.com", password: "a brand new passphrase" } })).status, 200);
    });

    it("deletes the account and everything stored for it", async () => {
        const user = await signUp("gone@example.com");
        const ids = await seed(user.id, "gone");

        assert.equal((await request("DELETE", "/auth/account", { cookie: user.cookie, body: { password: "not my password" } })).status, 401);
        assert.ok(await m.candidates.getCandidate(ids.candidateId), "a wrong password deletes nothing");

        const deleted = await request("DELETE", "/auth/account", { cookie: user.cookie, body: { password: PASSWORD } });
        assert.equal(deleted.status, 200);

        const count = async (table: string) => (await m.db.getDatabase().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
        assert.equal(await m.candidates.getCandidate(ids.candidateId), undefined);
        assert.equal(await m.matches.getMatch(ids.matchId), undefined);
        assert.equal(await m.apps.getApplication(ids.applicationId), undefined);
        assert.equal(await m.mailboxes.getMailAccount(ids.candidateId), undefined);
        assert.equal((await count("sessions")) >= 0 && (await m.db.getDatabase().get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [user.id]))!.n, 0);

        assert.equal((await request("GET", "/auth/me", { cookie: user.cookie })).status, 401);
        assert.equal((await request("POST", "/auth/login", { body: { email: "gone@example.com", password: PASSWORD } })).status, 401);
    });

    it("deleting one account leaves everyone else's data untouched", async () => {
        const leaving = await signUp("leaving@example.com");
        const staying = await signUp("staying@example.com");
        await seed(leaving.id, "leaving");
        const kept = await seed(staying.id, "staying");

        await request("DELETE", "/auth/account", { cookie: leaving.cookie, body: { password: PASSWORD } });

        assert.ok(await m.candidates.getCandidate(kept.candidateId));
        assert.ok(await m.matches.getMatch(kept.matchId));
        assert.ok(await m.apps.getApplication(kept.applicationId));
    });
});

// ---- cross-site protection -------------------------------------------------------------

describe("cross-site protection", () => {
    it("blocks state-changing requests from an untrusted origin, with or without a session", async () => {
        const { cookie } = await signUp("csrf@example.com");
        const evil = { origin: "https://evil.example" };

        assert.equal((await request("POST", "/auth/login", { headers: evil, body: { email: "csrf@example.com", password: PASSWORD } })).status, 403);
        assert.equal((await request("POST", "/auth/logout", { cookie, headers: evil })).status, 403);
        assert.equal((await request("DELETE", "/auth/account", { cookie, headers: evil, body: { password: PASSWORD } })).status, 403);
        assert.equal((await request("GET", "/auth/me", { cookie })).status, 200, "and the victim is still signed in");
    });

    it("allows the configured front end, and requests with no Origin (scripts)", async () => {
        await signUp("friendly@example.com");
        const body = { email: "friendly@example.com", password: PASSWORD };

        assert.equal((await request("POST", "/auth/login", { headers: { origin: "http://localhost:3000" }, body })).status, 200);
        assert.equal((await request("POST", "/auth/login", { body })).status, 200);
    });

    it("blocks a browser-declared cross-site request that carries no Origin", async () => {
        const response = await request("POST", "/auth/logout", { headers: { "sec-fetch-site": "cross-site" } });
        assert.equal(response.status, 403);
    });

    it("lets only the configured front end read responses, and with credentials", async () => {
        const allowed = await request("GET", "/health", { headers: { origin: "http://localhost:3000" } });
        assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
        assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

        const denied = await request("GET", "/health", { headers: { origin: "https://evil.example" } });
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
    });
});

// ---- default deny ----------------------------------------------------------------------

// Routes are read from the source files, so a route added tomorrow is tested without anyone remembering to list it
const MOUNTS: Record<string, string> = {
    "auth.routes.ts": "/auth", "resume.routes.ts": "/resumes", "job.routes.ts": "/jobs",
    "candidate.routes.ts": "/candidates", "match.routes.ts": "/matches", "application.routes.ts": "/applications",
};
const PUBLIC = new Set([
    "POST /auth/register", "POST /auth/login", "POST /auth/logout",
    "POST /auth/verify-email", "POST /auth/forgot-password", "POST /auth/reset-password",
]);

function discoverEndpoints(): { method: string; path: string }[] {
    const directory = join(__dirname, "..", "routes");
    const found: { method: string; path: string }[] = [];

    for (const file of readdirSync(directory).filter((name) => name.endsWith(".routes.ts"))) {
        const mount = MOUNTS[file];
        assert.ok(mount, `${file} is a new route file: add its mount point to MOUNTS in this test`);

        const source = readFileSync(join(directory, file), "utf8");
        for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
            const route = match[2] === "/" ? "" : match[2]!;
            found.push({ method: match[1]!.toUpperCase(), path: `${mount}${route}`.replace(/:\w+/g, "1") });
        }
    }
    return found;
}

describe("default deny", () => {
    const endpoints = discoverEndpoints();

    it("finds the routes (so the checks below are not vacuous)", () => {
        assert.ok(endpoints.length >= 30, `only found ${endpoints.length} endpoints`);
        assert.ok(endpoints.some((e) => e.method === "GET" && e.path === "/candidates/1/resume"));
    });

    it("requires a session on every route except the few that must work before signing in", async () => {
        for (const { method, path } of endpoints) {
            if (PUBLIC.has(`${method} ${path}`)) continue;

            const response = await request(method, path, method === "GET" || method === "DELETE" ? {} : { body: {} });
            assert.equal(response.status, 401, `${method} ${path} answered ${response.status} without a session`);
        }
    });

    it("also refuses unknown paths and the health-adjacent ones without revealing which exist", async () => {
        for (const path of ["/does-not-exist", "/candidates/1/secrets", "/admin", "/auth-not"]) {
            assert.equal((await request("GET", path)).status, 401, path);
        }
        assert.equal((await request("GET", "/health")).status, 200, "health is the one public read");
    });

    it("keeps working for a signed-in user on the routes it protects", async () => {
        const { cookie } = await signUp("ok@example.com");
        assert.equal((await request("GET", "/candidates", { cookie })).status, 200);
        assert.equal((await request("GET", "/jobs", { cookie })).status, 200);
    });
});

// ---- isolation between users -----------------------------------------------------------

async function seed(userId: number, tag: string) {
    const candidate = await m.candidates.createCandidate({
        userId, hash: `hash-${tag}`, fileName: `${tag}-cv.pdf`, mimeType: "application/pdf", fileData: CV,
        profile: {
            personalInfo: { fullName: `Person ${tag}`, email: `${tag}@example.com`, phone: null, location: "Colombo, Sri Lanka", linkedin: null, portfolio: null },
            skills: ["React"], education: [], experience: [], certifications: [], achievements: [],
        },
    });

    await m.jobs.upsertJobs([{
        source: "xpress", externalId: `job-${tag}`, url: `https://example.test/${tag}`, title: `Engineer ${tag}`, company: "Employer", location: "Colombo",
        description: null, jobType: null, salary: null, category: null, postedAt: null, closingAt: null, applyEmail: `hr-${tag}@employer.test`, applyUrl: null,
    }]);
    const job = (await m.jobs.listJobs({ search: `Engineer ${tag}`, limit: 1 }))[0]!;

    await m.matches.saveMatches(candidate.id, [{ jobId: job.id, score: 80, details: { breakdown: { skills: 1, title: 1, content: 1, experience: 1, location: 1 }, matchedSkills: [], reasons: [], warnings: [] } }]);
    const match = (await m.matches.listMatches(candidate.id))[0]!;
    await m.matches.saveDraft(match.id, `Application ${tag}`, `Dear Hiring Manager,\n\nLetter of ${tag}.\n\nSincerely,\n${tag}`);
    await m.matches.setStatus(match.id, "approved");

    await m.mailboxes.saveMailAccount({ candidateId: candidate.id, email: `${tag}@example.com`, fromName: null, host: "127.0.0.1", port: 2525, secure: false, username: tag, password: "mailbox-password" });
    const application = (await m.apps.enqueue(match.id, candidate.id, `hr-${tag}@employer.test`)).application;

    return { candidateId: candidate.id, jobId: job.id, matchId: match.id, applicationId: application.id };
}

describe("isolation between users", () => {
    let alice: Awaited<ReturnType<typeof signUp>>;
    let bob: Awaited<ReturnType<typeof signUp>>;
    let a: Awaited<ReturnType<typeof seed>>;
    let b: Awaited<ReturnType<typeof seed>>;

    beforeEach(async () => {
        await clearDatabase();
        alice = await signUp("alice@example.com");
        bob = await signUp("bob@example.com");
        a = await seed(alice.id, "alice");
        b = await seed(bob.id, "bob");
    });

    it("lets each user see their own data", async () => {
        assert.equal((await request("GET", `/candidates/${a.candidateId}`, { cookie: alice.cookie })).status, 200);
        assert.equal((await request("GET", `/matches/${a.matchId}`, { cookie: alice.cookie })).status, 200);
        assert.equal((await request("GET", `/applications/${a.applicationId}`, { cookie: alice.cookie })).status, 200);
        assert.equal((await request("GET", `/candidates/${a.candidateId}/mail-account`, { cookie: alice.cookie })).status, 200);

        const cv = await request("GET", `/candidates/${a.candidateId}/resume`, { cookie: alice.cookie });
        assert.equal(cv.status, 200);
        assert.ok(cv.bytes.equals(CV));
        assert.match(cv.headers.get("cache-control") ?? "", /no-store/);
    });

    it("answers 404 for every route that takes somebody else's id, exactly as for an id that does not exist", async () => {
        const body = { subject: "hijacked", coverLetter: "hijacked", address: "x@evil.test", password: "x", email: "evil@evil.test" };
        const profile = { personalInfo: { fullName: "Hijacked", email: null, phone: null, location: null, linkedin: null, portfolio: null }, skills: [], education: [], experience: [], certifications: [], achievements: [] };

        const attempts: [string, string, unknown?][] = [
            ["GET", `/candidates/${a.candidateId}`],
            ["PUT", `/candidates/${a.candidateId}/profile`, profile],
            ["GET", `/candidates/${a.candidateId}/resume`],
            ["POST", `/candidates/${a.candidateId}/matches/run`, {}],
            ["GET", `/candidates/${a.candidateId}/matches/run`],
            ["PUT", `/candidates/${a.candidateId}/mail-account`, body],
            ["GET", `/candidates/${a.candidateId}/mail-account`],
            ["DELETE", `/candidates/${a.candidateId}/mail-account`],
            ["POST", `/candidates/${a.candidateId}/applications/queue`, {}],
            ["GET", `/candidates/${a.candidateId}/applications`],
            ["GET", `/candidates/${a.candidateId}/matches`],
            ["GET", `/matches/${a.matchId}`],
            ["POST", `/matches/${a.matchId}/cover-letter`, {}],
            ["PATCH", `/matches/${a.matchId}`, body],
            ["POST", `/matches/${a.matchId}/approve`, {}],
            ["GET", `/matches/${a.matchId}/email-preview`],
            ["POST", `/matches/${a.matchId}/confirm-address`, body],
            ["POST", `/matches/${a.matchId}/send`, {}],
            ["POST", `/matches/${a.matchId}/reject`, {}],
            ["GET", `/applications/${a.applicationId}`],
            ["POST", `/applications/${a.applicationId}/cancel`, {}],
            ["POST", `/applications/${a.applicationId}/retry`, {}],
        ];

        for (const [method, path, payload] of attempts) {
            const theirs = await request(method, path, { cookie: bob.cookie, ...(payload !== undefined && { body: payload }) });
            const missing = await request(method, path.replace(/\/(\d+)/, "/999999"), { cookie: bob.cookie, ...(payload !== undefined && { body: payload }) });

            assert.equal(theirs.status, 404, `${method} ${path} -> ${theirs.status} ${JSON.stringify(theirs.json)}`);
            assert.equal(missing.status, 404, `${method} ${path} with a missing id`);
            assert.equal(theirs.json.message, missing.json.message, `${method} ${path} must not reveal that the id exists`);
        }
    });

    it("changes nothing of Alice's, whatever Bob attempts", async () => {
        const before = JSON.stringify({
            candidate: await m.candidates.getCandidate(a.candidateId),
            match: await m.matches.getMatch(a.matchId),
            application: await m.apps.getApplication(a.applicationId),
            mailbox: await m.mailboxes.getMailAccount(a.candidateId),
        });

        const profile = { personalInfo: { fullName: "Hijacked", email: null, phone: null, location: null, linkedin: null, portfolio: null }, skills: [], education: [], experience: [], certifications: [], achievements: [] };
        await request("PUT", `/candidates/${a.candidateId}/profile`, { cookie: bob.cookie, body: profile });
        await request("PATCH", `/matches/${a.matchId}`, { cookie: bob.cookie, body: { coverLetter: "hijacked" } });
        await request("POST", `/matches/${a.matchId}/reject`, { cookie: bob.cookie, body: {} });
        await request("POST", `/matches/${a.matchId}/send`, { cookie: bob.cookie, body: {} });
        await request("DELETE", `/candidates/${a.candidateId}/mail-account`, { cookie: bob.cookie });
        await request("POST", `/applications/${a.applicationId}/cancel`, { cookie: bob.cookie, body: {} });
        await request("POST", `/candidates/${a.candidateId}/applications/queue`, { cookie: bob.cookie, body: {} });

        const after = JSON.stringify({
            candidate: await m.candidates.getCandidate(a.candidateId),
            match: await m.matches.getMatch(a.matchId),
            application: await m.apps.getApplication(a.applicationId),
            mailbox: await m.mailboxes.getMailAccount(a.candidateId),
        });
        assert.equal(after, before);
    });

    it("lists only the caller's own resumes", async () => {
        const mine = await request("GET", "/candidates", { cookie: alice.cookie });
        assert.deepEqual(mine.json.data.map((c: { id: number }) => c.id), [a.candidateId]);

        const his = await request("GET", "/candidates", { cookie: bob.cookie });
        assert.deepEqual(his.json.data.map((c: { id: number }) => c.id), [b.candidateId]);
        assert.ok(!JSON.stringify(mine.json).includes("resume_hash") && !JSON.stringify(mine.json).includes("file_data"));
    });

    it("does not let matchIds smuggle another user's match into one's own queue", async () => {
        const response = await request("POST", `/candidates/${b.candidateId}/applications/queue`, { cookie: bob.cookie, body: { matchIds: [a.matchId] } });

        assert.equal(response.status, 202);
        assert.deepEqual(response.json.data.queued, []);
        assert.equal((await m.apps.getApplicationByMatch(a.matchId))!.candidateId, a.candidateId);
    });

    it("never lets one user's session act as another", async () => {
        // a session is bound to its user: Bob's token cannot be turned into Alice's by changing ids anywhere
        assert.equal((await request("GET", "/auth/me", { cookie: bob.cookie })).json.data.user.email, "bob@example.com");
        assert.equal((await request("GET", `/candidates/${b.candidateId}`, { cookie: alice.cookie })).status, 404);
    });

    it("keeps ownerless (pre-accounts) resumes out of everyone's reach", async () => {
        await m.db.getDatabase().run("UPDATE candidates SET user_id = NULL WHERE id = ?", [a.candidateId]);

        assert.equal((await request("GET", `/candidates/${a.candidateId}`, { cookie: alice.cookie })).status, 404);
        assert.equal((await request("GET", `/candidates/${a.candidateId}/resume`, { cookie: bob.cookie })).status, 404);
    });

    it("rejects ids that are not positive integers", async () => {
        for (const id of ["0", "-1", "1.5", "abc", "1e3"]) {
            assert.equal((await request("GET", `/candidates/${id}`, { cookie: alice.cookie })).status, 404, id);
        }
    });
});

// ---- roles -----------------------------------------------------------------------------

describe("administrators", () => {
    it("keeps the job-site collection away from ordinary users", async () => {
        const { cookie } = await signUp("regular@example.com");
        assert.equal((await request("POST", "/jobs/ingest", { cookie, body: {} })).status, 403);
    });

    it("cannot be self-granted through registration or any API field", async () => {
        const response = await request("POST", "/auth/register", { body: { email: "sneaky@example.com", password: PASSWORD, role: "admin", isAdmin: true } });

        assert.equal(response.status, 202);
        assert.equal((await m.users.findUserWithHash("sneaky@example.com"))!.role, "user");
    });

    it("lets requireAdmin pass only administrators", () => {
        const run = (role: "user" | "admin" | undefined) => {
            let passed = false;
            const request = { user: role && { id: 1, email: "x", role, createdAt: "", lastLoginAt: null } } as never;
            try {
                m.middleware.requireAdmin(request, {} as never, () => { passed = true; });
            } catch {
                /* ForbiddenError */
            }
            return passed;
        };

        assert.equal(run("admin"), true);
        assert.equal(run("user"), false);
        assert.equal(run(undefined), false);
    });
});

// ---- units -----------------------------------------------------------------------------

describe("password hashing", () => {
    it("verifies the right password only, with a fresh salt each time", async () => {
        const one = await m.password.hashPassword("a long enough passphrase");
        const two = await m.password.hashPassword("a long enough passphrase");

        assert.notEqual(one, two);
        assert.match(one, /^scrypt\$\d+\$8\$1\$/);
        assert.ok(await m.password.verifyPassword("a long enough passphrase", one));
        assert.ok(!(await m.password.verifyPassword("a long enough passphrasE", one)));
        assert.ok(!(await m.password.verifyPassword("", one)));
    });

    it("treats visually identical unicode forms as the same password", async () => {
        const hash = await m.password.hashPassword("café au lait 2026");
        assert.ok(await m.password.verifyPassword("café au lait 2026", hash));
    });

    it("never accepts malformed stored hashes", async () => {
        for (const stored of ["", "plaintext", "scrypt$1$2", "bcrypt$a$b$c$d$e", "scrypt$1024$8$1$AAAA$"]) {
            assert.equal(await m.password.verifyPassword("anything", stored), false, stored);
        }
    });

    it("keeps verifying hashes made with older parameters", async () => {
        process.env.AUTH_SCRYPT_COST = "2048";
        const old = await m.password.hashPassword("parameters may change");
        process.env.AUTH_SCRYPT_COST = "1024";

        assert.ok(await m.password.verifyPassword("parameters may change", old));
    });
});

describe("rate limiter", () => {
    it("blocks after the allowance and recovers when the window ends", async () => {
        const { RateLimiter } = await import("./rate-limit.js");
        let now = 1_000_000;
        const limiter = new RateLimiter(3, 60_000, "tries", () => now);

        for (let n = 0; n < 3; n++) {
            limiter.assertAllowed("k");
            limiter.record("k");
        }
        assert.throws(() => limiter.assertAllowed("k"), /Too many tries/);
        assert.doesNotThrow(() => limiter.assertAllowed("other"));

        now += 60_001;
        assert.doesNotThrow(() => limiter.assertAllowed("k"));
    });
});

describe("resume ownership key", () => {
    it("separates identical resumes of different users, and is stable for the same user", () => {
        const links = [{ text: "LinkedIn", url: "https://linkedin.com/in/x" }];

        assert.equal(m.resume.resumeKey(1, "same text", links), m.resume.resumeKey(1, "same text", links));
        assert.notEqual(m.resume.resumeKey(1, "same text", links), m.resume.resumeKey(2, "same text", links));
        assert.notEqual(m.resume.resumeKey(1, "same text", links), m.resume.resumeKey(1, "same text 2", links));
        assert.notEqual(m.resume.resumeKey(1, "ab", []), m.resume.resumeKey(11, "b", []), "no ambiguity between user id and text");
    });

    it("never hands user A's record to user B who uploads the same file", async () => {
        await clearDatabase();
        const ua = (await m.users.createUser("ra@example.com", "x"))!;
        const ub = (await m.users.createUser("rb@example.com", "x"))!;
        const profile = seed_profile();

        const keyA = m.resume.resumeKey(ua.id, "identical cv", []);
        await m.candidates.createCandidate({ userId: ua.id, hash: keyA, fileName: "cv.pdf", mimeType: "application/pdf", fileData: CV, profile });

        assert.ok(await m.candidates.findCandidateByHash(ua.id, keyA));
        assert.equal(await m.candidates.findCandidateByHash(ub.id, m.resume.resumeKey(ub.id, "identical cv", [])), undefined);
        assert.equal(await m.candidates.findCandidateByHash(ub.id, keyA), undefined, "even knowing A's key does not find it");
    });
});

function seed_profile() {
    return { personalInfo: { fullName: "P", email: null, phone: null, location: null, linkedin: null, portfolio: null }, skills: [], education: [], experience: [], certifications: [], achievements: [] };
}
