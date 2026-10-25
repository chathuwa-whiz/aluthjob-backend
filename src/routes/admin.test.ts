import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

// Configuration must be in place before the modules under test are loaded
import { clearDatabase } from "../db/test-helpers.js";
process.env.AUTH_SCRYPT_COST = "1024"; // fast hashing for tests; production uses 32768
process.env.MAIL_SECRET = "test-secret-".repeat(4);
process.env.FRONTEND_URL = "http://localhost:3000,http://localhost:3001";
process.env.SESSION_DAYS = "30";
process.env.MAIL_WORKER = "off";
delete process.env.COOKIE_SECURE;

const PASSWORD = "correct horse battery";

let base = "";
let server: import("node:http").Server;
let m: {
    db: typeof import("../db/database.js");
    users: typeof import("../auth/user.repository.js");
    password: typeof import("../auth/password.js");
    authService: typeof import("../auth/auth.service.js");
    candidates: typeof import("../candidates/candidate.repository.js");
    jobs: typeof import("../jobs/job.repository.js");
    matches: typeof import("../matching/match.repository.js");
    apps: typeof import("../mail/application.repository.js");
    mailboxes: typeof import("../mail/mail-account.repository.js");
    mailer: typeof import("../mail/system-mailer.js");
};

async function request(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(base + path, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, redirect: "manual" });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: any;
    try {
        json = JSON.parse(bytes.toString("utf8"));
    } catch {
        json = undefined;
    }

    return { status: response.status, json, headers: response.headers, setCookie: response.headers.getSetCookie(), bytes };
}

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("../auth/user.repository.js"),
        password: await import("../auth/password.js"),
        authService: await import("../auth/auth.service.js"),
        candidates: await import("../candidates/candidate.repository.js"),
        jobs: await import("../jobs/job.repository.js"),
        matches: await import("../matching/match.repository.js"),
        apps: await import("../mail/application.repository.js"),
        mailboxes: await import("../mail/mail-account.repository.js"),
        mailer: await import("../mail/system-mailer.js"),
    };
    m.mailer.setSystemMailer({ send: async () => {} });

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

interface World {
    admin: { id: number; cookie: string };
    user: { id: number; cookie: string; email: string };
    other: { id: number; email: string };
    candidateId: number;
    jobId: number;
    closedJobId: number;
    matchId: number;
    applicationId: number;
}

let w: World;

async function signedIn(email: string, role: "user" | "admin", verified = true) {
    const created = await m.users.createUser(email, await m.password.hashPassword(PASSWORD));
    assert.ok(created);
    if (verified) await m.users.markEmailVerified(created.id);
    if (role === "admin") await m.users.setRole(created.id, "admin");

    const response = await request("POST", "/auth/login", { body: { email, password: PASSWORD } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const cookie = response.setCookie.find((value) => value.startsWith("aj_session="))?.split(";")[0] ?? "";
    return { id: created.id, cookie, email };
}

const profile = {
    personalInfo: { fullName: "Nimali Perera", email: "nimali@example.com", phone: null, location: "Colombo", linkedin: null, portfolio: null },
    skills: ["TypeScript", "React"],
    education: [],
    experience: [],
    certifications: [],
    achievements: [],
};

const details = { breakdown: { skills: 70, title: 60, content: 50, experience: 40, location: 100 }, matchedSkills: ["TypeScript"], reasons: ["Skills fit"], warnings: [] };

const posting = (externalId: string, overrides: Partial<import("../jobs/types.js").JobPosting> = {}): import("../jobs/types.js").JobPosting => ({
    source: "topjobs",
    externalId,
    url: `https://example.org/${externalId}`,
    title: `Engineer ${externalId}`,
    company: "Hemas Holdings",
    location: "Colombo",
    description: "Build things",
    jobType: null,
    salary: null,
    category: null,
    postedAt: null,
    closingAt: null,
    applyEmail: null,
    applyUrl: null,
    ...overrides,
});

beforeEach(async () => {
    await clearDatabase();
    for (const limiter of Object.values(m.authService.limits)) limiter.reset();

    const admin = await signedIn("boss@example.com", "admin");
    const user = await signedIn("applicant@example.com", "user");
    const other = await signedIn("someone.else@example.com", "user");

    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await m.jobs.upsertJobs([
        posting("open-1", { applyEmail: "careers@hemas.example", closingAt: future }),
        posting("closed-1", { source: "ikman", closingAt: longAgo }),
        posting("open-2"),
    ]);
    const stored = await m.jobs.listJobs({ limit: 10 });
    const jobId = stored.find((job) => job.externalId === "open-1")!.id;
    const closedJobId = stored.find((job) => job.externalId === "closed-1")!.id;

    const candidate = await m.candidates.createCandidate({ userId: user.id, hash: "hash-a", fileName: "nimali.pdf", mimeType: "application/pdf", fileData: Buffer.from("%PDF-1.4 cv"), profile });
    await m.matches.saveMatches(candidate.id, [{ jobId, score: 77, details }]);
    const match = (await m.matches.listMatches(candidate.id))[0]!;
    await m.mailboxes.saveMailAccount({ candidateId: candidate.id, email: "nimali@example.com", fromName: "Nimali", host: "smtp.example.com", port: 465, secure: true, username: "nimali", password: "very-secret-mailbox-password" });
    const { application } = await m.apps.enqueue(match.id, candidate.id, "careers@hemas.example");

    w = { admin, user, other, candidateId: candidate.id, jobId, closedJobId, matchId: match.id, applicationId: application.id };
});

const asAdmin = (method: string, path: string, body?: unknown) => request(method, path, { cookie: w.admin.cookie, body });

// ---- who may use it --------------------------------------------------------------------

describe("access", () => {
    const READS = [
        "/admin/overview", "/admin/system", "/admin/audit", "/admin/audit/actions", "/admin/users", "/admin/users/1", "/admin/candidates", "/admin/candidates/1",
        "/admin/candidates/1/resume", "/admin/jobs", "/admin/jobs/1", "/admin/collection", "/admin/matches", "/admin/matches/1", "/admin/applications",
        "/admin/applications/1", "/admin/mailboxes", "/admin/sessions",
    ];

    it("turns away anyone who is not signed in", async () => {
        for (const path of READS) assert.equal((await request("GET", path)).status, 401, path);
    });

    it("turns away a signed-in user who is not an administrator, for reads and for changes", async () => {
        for (const path of READS) assert.equal((await request("GET", path, { cookie: w.user.cookie })).status, 403, path);

        const changes: [string, string, unknown?][] = [
            ["POST", "/admin/users", { email: "x@example.com", password: PASSWORD }],
            ["PATCH", `/admin/users/${w.other.id}`, { role: "admin" }],
            ["DELETE", `/admin/users/${w.other.id}`],
            ["DELETE", `/admin/candidates/${w.candidateId}`],
            ["PATCH", `/admin/jobs/${w.jobId}`, { title: "Hacked" }],
            ["POST", "/admin/applications/cancel-queued"],
            ["POST", "/admin/collection/run", {}],
        ];
        for (const [method, path, body] of changes) assert.equal((await request(method, path, { cookie: w.user.cookie, body })).status, 403, `${method} ${path}`);

        assert.equal((await m.users.getUser(w.other.id))?.role, "user", "nothing changed");
        assert.ok(await m.candidates.getCandidate(w.candidateId));
    });

    it("lets an administrator through", async () => {
        for (const path of READS.filter((path) => !/\/\d+/.test(path))) assert.equal((await asAdmin("GET", path)).status, 200, path);
    });

    it("keeps the applicant's own approval out of the console", async () => {
        for (const path of [`/admin/matches/${w.matchId}/approve`, `/admin/matches/${w.matchId}/send`, `/admin/matches/${w.matchId}/confirm-address`]) {
            assert.equal((await asAdmin("POST", path, {})).status, 404, path);
        }
    });
});

// ---- overview and system ---------------------------------------------------------------

describe("overview and system", () => {
    it("counts what is in the database", async () => {
        const { data } = (await asAdmin("GET", "/admin/overview")).json;

        assert.equal(data.users.total, 3);
        assert.equal(data.users.admins, 1);
        assert.equal(data.candidates.total, 1);
        assert.equal(data.candidates.mailboxes, 1);
        assert.equal(data.jobs.total, 3);
        assert.equal(data.jobs.open, 2);
        assert.equal(data.jobs.withEmail, 1);
        assert.equal(data.matches.suggested, 1);
        assert.equal(data.applications.queued, 1);
        assert.equal(data.daily.length, 30);
        assert.equal(data.daily.at(-1).signups, 3, "today's sign-ups land in the last bucket");
        assert.deepEqual(data.sources.map((source: { source: string }) => source.source).sort(), ["ikman", "topjobs"]);
    });

    it("reports the system without leaking a secret", async () => {
        const response = await asAdmin("GET", "/admin/system");
        const { data } = response.json;

        assert.equal(data.database.ok, true);
        assert.equal(data.mail.applicationSecretSet, true);
        assert.ok(!response.bytes.toString().includes(process.env.MAIL_SECRET!), "the mail secret never leaves the server");
        assert.ok(Array.isArray(data.security.allowedOrigins));
    });
});

// ---- lists: every filter and sort must be valid SQL ------------------------------------

describe("lists", () => {
    it("searches and filters users", async () => {
        const all = (await asAdmin("GET", "/admin/users")).json.data;
        assert.equal(all.total, 3);
        assert.equal(all.items.find((user: { email: string }) => user.email === "applicant@example.com").resumes, 1);

        assert.equal((await asAdmin("GET", "/admin/users?search=APPLICANT")).json.data.total, 1, "search ignores case");
        assert.equal((await asAdmin("GET", "/admin/users?role=admin")).json.data.total, 1);
        assert.equal((await asAdmin("GET", "/admin/users?verified=false")).json.data.total, 0);
        for (const sort of ["newest", "oldest", "recent_login", "email"]) assert.equal((await asAdmin("GET", `/admin/users?sort=${sort}&limit=2&offset=1`)).status, 200, sort);
        assert.equal((await asAdmin("GET", "/admin/users?limit=2")).json.data.items.length, 2);
        assert.equal((await asAdmin("GET", "/admin/users?limit=1000")).status, 400, "the page size is capped");
    });

    it("filters vacancies", async () => {
        const jobs = async (query: string) => (await asAdmin("GET", `/admin/jobs${query}`)).json.data;

        assert.equal((await jobs("")).total, 3);
        assert.equal((await jobs("?source=ikman")).total, 1);
        assert.equal((await jobs("?openOnly=true")).total, 2);
        assert.equal((await jobs("?closedOnly=true")).total, 1);
        assert.equal((await jobs("?hasEmail=true")).total, 1);
        assert.equal((await jobs("?hasEmail=false")).total, 2);
        assert.equal((await jobs("?enriched=false")).total, 3);
        assert.equal((await jobs("?search=OPEN-2")).total, 1);
        assert.equal((await jobs("?emailSource=page")).total, 1);
        assert.equal((await jobs("?emailSource=image")).total, 0);
        for (const sort of ["newest", "first_seen", "last_seen", "closing", "most_matched"]) assert.equal((await asAdmin("GET", `/admin/jobs?sort=${sort}`)).status, 200, sort);

        const [first] = (await jobs(`?search=open-1`)).items;
        assert.equal(first.matches, 1);
        assert.equal(first.applyEmail, "careers@hemas.example");
    });

    it("lists resumes, matches, applications, mailboxes, sessions", async () => {
        const candidates = (await asAdmin("GET", "/admin/candidates?search=nimali")).json.data;
        assert.equal(candidates.total, 1);
        assert.equal(candidates.items[0].fullName, "Nimali Perera");
        assert.equal(candidates.items[0].ownerEmail, "applicant@example.com");
        assert.equal(candidates.items[0].hasMailbox, true);
        assert.equal((await asAdmin("GET", "/admin/candidates?orphaned=true")).json.data.total, 0);

        const matches = (await asAdmin("GET", `/admin/matches?status=suggested&minScore=50&candidateId=${w.candidateId}&search=engineer`)).json.data;
        assert.equal(matches.total, 1);
        assert.equal(matches.items[0].applicationStatus, "queued");
        assert.equal(matches.items[0].candidateName, "Nimali Perera");
        for (const sort of ["score", "newest"]) assert.equal((await asAdmin("GET", `/admin/matches?sort=${sort}`)).status, 200);

        const applications = (await asAdmin("GET", "/admin/applications?status=queued&search=hemas")).json.data;
        assert.equal(applications.total, 1);
        assert.equal(applications.items[0].toEmail, "careers@hemas.example");

        const mailboxes = await asAdmin("GET", "/admin/mailboxes");
        assert.equal(mailboxes.json.data.total, 1);
        assert.ok(!mailboxes.bytes.toString().includes("very-secret-mailbox-password"), "no password in a response");
        assert.ok(!/password/i.test(mailboxes.bytes.toString()), "not even a field for it");

        const sessions = (await asAdmin("GET", "/admin/sessions")).json.data;
        assert.equal(sessions.total, 3);
        assert.equal(sessions.items.filter((session: { current: boolean }) => session.current).length, 1, "the caller's own session is marked");
        assert.equal((await asAdmin("GET", "/admin/sessions?search=boss")).json.data.total, 1);
    });
});

// ---- users -----------------------------------------------------------------------------

describe("user actions", () => {
    it("shows an account with its resumes and sessions", async () => {
        const { data } = (await asAdmin("GET", `/admin/users/${w.user.id}`)).json;

        assert.equal(data.user.email, "applicant@example.com");
        assert.equal(data.resumes.length, 1);
        assert.equal(data.resumes[0].matches, 1);
        assert.equal(data.resumes[0].hasMailbox, true);
        assert.equal(data.sessions.length, 1);
        assert.equal((await asAdmin("GET", "/admin/users/99999")).status, 404);
        assert.equal((await asAdmin("GET", "/admin/users/abc")).status, 400);
    });

    it("creates a user who can sign in, and refuses a taken address or a weak password", async () => {
        const created = await asAdmin("POST", "/admin/users", { email: "New.Person@Example.com", password: PASSWORD, role: "user" });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        assert.equal(created.json.data.email, "new.person@example.com");
        assert.equal(created.json.data.emailVerified, true);
        assert.equal((await request("POST", "/auth/login", { body: { email: "new.person@example.com", password: PASSWORD } })).status, 200);

        assert.equal((await asAdmin("POST", "/admin/users", { email: "new.person@example.com", password: PASSWORD })).status, 409);
        assert.equal((await asAdmin("POST", "/admin/users", { email: "weak@example.com", password: "password123" })).status, 409);
    });

    it("promotes and demotes, but never the administrator's own account", async () => {
        assert.equal((await asAdmin("PATCH", `/admin/users/${w.other.id}`, { role: "admin" })).json.data.role, "admin");
        assert.equal((await asAdmin("PATCH", `/admin/users/${w.other.id}`, { role: "user" })).json.data.role, "user");
        assert.equal((await asAdmin("PATCH", `/admin/users/${w.admin.id}`, { role: "user" })).status, 409);
        assert.equal((await asAdmin("PATCH", `/admin/users/${w.other.id}`, {})).status, 400);
        assert.equal((await m.users.getUser(w.admin.id))?.role, "admin");
    });

    it("verifies an address by hand", async () => {
        const unverified = await m.users.createUser("late@example.com", await m.password.hashPassword(PASSWORD));
        assert.equal((await asAdmin("PATCH", `/admin/users/${unverified!.id}`, { emailVerified: true })).json.data.emailVerified, true);
    });

    it("signs a user out everywhere", async () => {
        assert.equal((await request("GET", "/auth/me", { cookie: w.user.cookie })).status, 200);
        assert.equal((await asAdmin("POST", `/admin/users/${w.user.id}/sign-out`)).json.data.signedOut, 1);
        assert.equal((await request("GET", "/auth/me", { cookie: w.user.cookie })).status, 401);
    });

    it("deletes an account with everything it owns, but not the administrator's own", async () => {
        assert.equal((await asAdmin("DELETE", `/admin/users/${w.admin.id}`)).status, 409);

        assert.equal((await asAdmin("DELETE", `/admin/users/${w.user.id}`)).status, 200);
        assert.equal(await m.users.getUser(w.user.id), undefined);
        assert.equal(await m.candidates.getCandidate(w.candidateId), undefined, "its resume went with it");
        assert.equal(await m.apps.getApplication(w.applicationId), undefined, "and its applications");
    });
});

// ---- resumes ---------------------------------------------------------------------------

describe("resume actions", () => {
    it("shows the profile and mailbox, and downloads the file with an audit entry", async () => {
        const { data } = (await asAdmin("GET", `/admin/candidates/${w.candidateId}`)).json;
        assert.equal(data.profile.personalInfo.fullName, "Nimali Perera");
        assert.equal(data.mailbox.email, "nimali@example.com");
        assert.equal(data.mailbox.password, undefined);

        const file = await asAdmin("GET", `/admin/candidates/${w.candidateId}/resume`);
        assert.equal(file.status, 200);
        assert.match(file.headers.get("content-disposition") ?? "", /attachment/);
        assert.equal(file.headers.get("cache-control"), "private, no-store");
        assert.equal(file.bytes.toString(), "%PDF-1.4 cv");

        const audit = (await asAdmin("GET", "/admin/audit?action=resume.download")).json.data;
        assert.equal(audit.total, 1);
        assert.equal(audit.items[0].adminEmail, "boss@example.com");
    });

    it("edits a profile, and refuses one with the wrong shape", async () => {
        const edited = await asAdmin("PUT", `/admin/candidates/${w.candidateId}/profile`, { ...profile, skills: ["Go"] });
        assert.equal(edited.status, 200, JSON.stringify(edited.json));
        assert.deepEqual((await m.candidates.getCandidate(w.candidateId))?.profile.skills, ["Go"]);

        assert.equal((await asAdmin("PUT", `/admin/candidates/${w.candidateId}/profile`, { skills: "Go" })).status, 400);
    });

    it("moves a resume to another account", async () => {
        const moved = await asAdmin("PUT", `/admin/candidates/${w.candidateId}/owner`, { userId: w.other.id });
        assert.equal(moved.json.data.ownerEmail, "someone.else@example.com");
        assert.equal((await asAdmin("PUT", `/admin/candidates/${w.candidateId}/owner`, { userId: 99999 })).status, 404);

        assert.equal((await asAdmin("PUT", `/admin/candidates/${w.candidateId}/owner`, { userId: null })).json.data.ownerEmail, null);
        assert.equal((await asAdmin("GET", "/admin/candidates?orphaned=true")).json.data.total, 1);
    });

    it("deletes a resume with its matches and mailbox", async () => {
        assert.equal((await asAdmin("DELETE", `/admin/candidates/${w.candidateId}`)).status, 200);
        assert.equal((await asAdmin("GET", `/admin/candidates/${w.candidateId}`)).status, 404);
        assert.equal((await asAdmin("GET", "/admin/matches")).json.data.total, 0);
        assert.equal((await asAdmin("GET", "/admin/mailboxes")).json.data.total, 0);
    });

    it("disconnects a mailbox", async () => {
        assert.equal((await asAdmin("DELETE", `/admin/mailboxes/${w.candidateId}`)).status, 200);
        assert.equal((await asAdmin("DELETE", `/admin/mailboxes/${w.candidateId}`)).status, 404);
    });
});

// ---- vacancies -------------------------------------------------------------------------

describe("vacancy actions", () => {
    it("edits only what is sent, and clears a field that is emptied", async () => {
        const response = await asAdmin("PATCH", `/admin/jobs/${w.jobId}`, { title: "Senior Engineer", company: "", closingAt: "2030-01-31", applyEmail: "HR@Hemas.example" });
        assert.equal(response.status, 200, JSON.stringify(response.json));

        const job = response.json.data;
        assert.equal(job.title, "Senior Engineer");
        assert.equal(job.company, null);
        assert.equal(job.closingAt, "2030-01-31T23:59:59.999Z");
        assert.equal(job.applyEmail, "hr@hemas.example");
        assert.equal(job.location, "Colombo", "untouched");
    });

    it("refuses nonsense", async () => {
        for (const body of [{}, { title: "" }, { applyEmail: "not an email" }, { applyUrl: "javascript:alert(1)" }, { closingAt: "soon" }]) {
            assert.equal((await asAdmin("PATCH", `/admin/jobs/${w.jobId}`, body)).status, 400, JSON.stringify(body));
        }
    });

    it("keeps the way an address was found when it is corrected", async () => {
        await m.db.getDatabase().run("UPDATE jobs SET apply_email_source = 'image' WHERE id = ?", [w.jobId]);
        const job = (await asAdmin("PATCH", `/admin/jobs/${w.jobId}`, { applyEmail: "corrected@hemas.example" })).json.data;
        assert.equal(job.applyEmailSource, "image", "the applicant still has to confirm an address that was read from a picture");
    });

    it("deletes one, many, and closed ones past a date, with their matches", async () => {
        assert.equal((await asAdmin("DELETE", `/admin/jobs/${w.jobId}`)).status, 200);
        assert.equal((await asAdmin("GET", "/admin/matches")).json.data.total, 0, "its match went with it");

        assert.equal((await asAdmin("POST", "/admin/jobs/purge-closed", { days: 30 })).json.data.deleted, 1);
        assert.equal((await asAdmin("GET", `/admin/jobs/${w.closedJobId}`)).status, 404);

        const rest = (await asAdmin("GET", "/admin/jobs")).json.data.items.map((job: { id: number }) => job.id);
        assert.equal((await asAdmin("POST", "/admin/jobs/delete", { ids: rest })).json.data.deleted, rest.length);
        assert.equal((await asAdmin("POST", "/admin/jobs/delete", { ids: [] })).status, 400);
    });
});

// ---- matches and applications ----------------------------------------------------------

describe("match and application actions", () => {
    it("shows a match with its owner and application", async () => {
        const { data } = (await asAdmin("GET", `/admin/matches/${w.matchId}`)).json;
        assert.equal(data.match.score, 77);
        assert.equal(data.owner.ownerEmail, "applicant@example.com");
        assert.equal(data.application.status, "queued");
    });

    it("skips and reopens a match, and withdraws an approval when the letter is edited", async () => {
        assert.equal((await asAdmin("POST", `/admin/matches/${w.matchId}/reject`)).json.data.status, "rejected");
        assert.equal((await asAdmin("POST", `/admin/matches/${w.matchId}/reopen`)).json.data.status, "suggested");

        await m.matches.saveDraft(w.matchId, "Application", "Dear team");
        await m.matches.setStatus(w.matchId, "approved");
        const edited = await asAdmin("PATCH", `/admin/matches/${w.matchId}`, { coverLetter: "A different letter" });
        assert.equal(edited.json.data.status, "suggested", "an edited letter has to be approved again by its owner");
        assert.equal(edited.json.data.coverLetter, "A different letter");
    });

    it("cancels, retries and deletes applications", async () => {
        assert.equal((await asAdmin("POST", `/admin/applications/${w.applicationId}/retry`)).status, 409, "only a failed one can be retried");

        const cancelled = await asAdmin("POST", `/admin/applications/${w.applicationId}/cancel`);
        assert.equal(cancelled.json.data.status, "cancelled");
        assert.equal(cancelled.json.data.error, "Cancelled by an administrator");
        assert.equal((await asAdmin("POST", `/admin/applications/${w.applicationId}/cancel`)).status, 409);

        await m.apps.markFailed(w.applicationId, "SMTP 550");
        assert.equal((await asAdmin("POST", `/admin/applications/${w.applicationId}/retry`)).json.data.status, "queued");

        assert.equal((await asAdmin("DELETE", `/admin/applications/${w.applicationId}`)).status, 200);
        assert.equal((await asAdmin("GET", `/admin/applications/${w.applicationId}`)).status, 404);
    });

    it("stops everything waiting in the queue", async () => {
        assert.equal((await asAdmin("POST", "/admin/applications/cancel-queued")).json.data.cancelled, 1);
        assert.equal((await asAdmin("GET", "/admin/applications?status=queued")).json.data.total, 0);
    });
});

// ---- sessions and the audit trail ------------------------------------------------------

describe("sessions and the audit trail", () => {
    it("ends a single session", async () => {
        const session = (await asAdmin("GET", `/admin/sessions?search=${w.other.email}`)).json.data.items[0];
        assert.equal((await asAdmin("DELETE", `/admin/sessions/${session.id}`)).status, 200);
        assert.equal((await asAdmin("DELETE", `/admin/sessions/${session.id}`)).status, 404);
    });

    it("purges expired sessions", async () => {
        await m.db.getDatabase().run("UPDATE sessions SET expires_at = ? WHERE user_id = ?", [new Date(Date.now() - 1000).toISOString(), w.other.id]);
        assert.equal((await asAdmin("POST", "/admin/sessions/purge-expired")).json.data.purged, 1);
    });

    it("records who did what", async () => {
        await asAdmin("PATCH", `/admin/users/${w.other.id}`, { role: "admin" });
        await asAdmin("DELETE", `/admin/jobs/${w.closedJobId}`);

        const audit = (await asAdmin("GET", "/admin/audit")).json.data;
        assert.equal(audit.total, 2);
        assert.deepEqual(audit.items.map((entry: { action: string }) => entry.action), ["job.delete", "user.promote"], "newest first");
        assert.equal(audit.items[1].adminId, w.admin.id);
        assert.equal(audit.items[1].targetId, String(w.other.id));
        assert.deepEqual((await asAdmin("GET", "/admin/audit/actions")).json.data, ["job.delete", "user.promote"]);
        assert.equal((await asAdmin("GET", "/admin/audit?search=someone.else")).json.data.total, 1);
    });
});
