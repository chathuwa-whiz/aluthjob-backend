import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";

// Configuration must be in place before the modules under test are loaded
import { clearDatabase } from "../db/test-helpers.js";
process.env.MAIL_SECRET = "test-secret-".repeat(4);
process.env.MAIL_ALLOW_LOCAL = "true";
process.env.MAIL_SEND_GAP_SECONDS = "0";
process.env.MAIL_DAILY_LIMIT = "100";

const LOGIN = { user: "me@applicant.test", pass: "app-password" };
const CV = Buffer.from("%PDF-1.4 pretend this is a CV");

type Mods = {
    db: typeof import("../db/database.js");
    candidates: typeof import("../candidates/candidate.repository.js");
    jobs: typeof import("../jobs/job.repository.js");
    matches: typeof import("../matching/match.repository.js");
    matchService: typeof import("../matching/match.service.js");
    apps: typeof import("./application.repository.js");
    service: typeof import("./application.service.js");
    account: typeof import("./mail-account.service.js");
    accountRepo: typeof import("./mail-account.repository.js");
    box: typeof import("./secret-box.js");
    users: typeof import("../auth/user.repository.js");
};
let m: Mods;

// ---- a real SMTP server that records what it receives ----------------------------------
const received: { raw: string; to: string[] }[] = [];
let rejectRecipient = "";
let smtp: SMTPServer;
let port: number;

before(async () => {
    smtp = new SMTPServer({
        authOptional: false,
        allowInsecureAuth: true,
        disabledCommands: ["STARTTLS"],
        onAuth: (auth, _session, done) =>
            auth.username === LOGIN.user && auth.password === LOGIN.pass ? done(null, { user: 1 }) : done(new Error("Invalid login")),
        onRcptTo: (address, _session, done) => {
            if (address.address === rejectRecipient) {
                return done(Object.assign(new Error("550 Mailbox unavailable"), { responseCode: 550 }));
            }
            done();
        },
        onData: (stream, session, done) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => {
                received.push({ raw: Buffer.concat(chunks).toString("utf8"), to: session.envelope.rcptTo.map((r) => r.address) });
                done();
            });
        },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    port = (smtp.server.address() as AddressInfo).port;

    m = {
        db: await import("../db/database.js"),
        candidates: await import("../candidates/candidate.repository.js"),
        jobs: await import("../jobs/job.repository.js"),
        matches: await import("../matching/match.repository.js"),
        matchService: await import("../matching/match.service.js"),
        apps: await import("./application.repository.js"),
        service: await import("./application.service.js"),
        account: await import("./mail-account.service.js"),
        accountRepo: await import("./mail-account.repository.js"),
        box: await import("./secret-box.js"),
        users: await import("../auth/user.repository.js"),
    };
});

after(async () => {
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
});

// ---- fixtures --------------------------------------------------------------------------
let candidateId: number;
let counter = 0;

const profile = {
    personalInfo: { fullName: "Test Applicant", email: "me@applicant.test", phone: null, location: "Colombo, Sri Lanka", linkedin: null, portfolio: null },
    skills: ["React"], education: [], experience: [], certifications: [], achievements: [],
};

async function connect(overrides: Partial<Parameters<Mods["account"]["connectMailbox"]>[1]> = {}) {
    return m.account.connectMailbox(candidateId, {
        email: LOGIN.user, password: LOGIN.pass, host: "127.0.0.1", port, secure: false, fromName: "Test Applicant", ...overrides,
    });
}

/** An approved match with a cover letter, ready to be queued. */
async function approvedMatch(overrides: { email?: string | null; closingAt?: string | null; approve?: boolean; emailSource?: "image" } = {}) {
    const n = ++counter;
    const email = overrides.email === undefined ? `hr${n}@employer.test` : overrides.email;

    await m.jobs.upsertJobs([{
        source: "xpress", externalId: `job-${n}`, url: `https://example.test/${n}`, title: `Engineer ${n}`, company: "Employer",
        location: "Colombo", description: null, jobType: null, salary: null, category: null, postedAt: null,
        closingAt: overrides.closingAt ?? null, applyEmail: email, applyEmailSource: overrides.emailSource ?? null, applyUrl: null,
    }]);
    const job = (await m.jobs.listJobs({ search: `Engineer ${n}`, limit: 1 }))[0]!;

    await m.matches.saveMatches(candidateId, [
        ...(await m.matches.listMatches(candidateId, { limit: 500 })).map((x) => ({ jobId: x.jobId, score: x.score, details: x.details })),
        { jobId: job.id, score: 80, details: { breakdown: { skills: 1, title: 1, content: 1, experience: 1, location: 1 }, matchedSkills: [], reasons: [], warnings: [] } },
    ]);
    const match = (await m.matches.listMatches(candidateId, { limit: 500 })).find((x) => x.jobId === job.id)!;

    await m.matches.saveDraft(match.id, `Application for Engineer ${n}`, "Dear Hiring Manager,\n\nPlease consider my application.\n\nSincerely,\nTest Applicant");
    if (overrides.approve !== false) await m.matches.setStatus(match.id, "approved");
    return (await m.matches.getMatch(match.id))!;
}

beforeEach(async () => {
    received.length = 0;
    rejectRecipient = "";
    process.env.MAIL_ALLOW_LOCAL = "true";
    process.env.MAIL_SEND_GAP_SECONDS = "0";
    process.env.MAIL_DAILY_LIMIT = "100";

    await clearDatabase();
    const owner = (await m.users.createUser("owner@applicant.test", "not-a-real-hash"))!;
    candidateId = (await m.candidates.createCandidate({
        userId: owner.id, hash: `hash-${++counter}`, fileName: "My CV.pdf", mimeType: "application/pdf", fileData: CV, profile: profile as never,
    })).id;
    await connect();
});

// ---- tests -----------------------------------------------------------------------------

describe("secret box", () => {
    it("round-trips, never stores plaintext, and refuses tampered or foreign data", () => {
        const stored = m.box.encryptSecret("hunter2-password");
        assert.ok(!stored.includes("hunter2"));
        assert.notEqual(stored, m.box.encryptSecret("hunter2-password"), "each encryption uses a fresh IV");
        assert.equal(m.box.decryptSecret(stored), "hunter2-password");

        const [v, iv, tag, data] = stored.split(":");
        const flipped = Buffer.from(data!, "base64");
        flipped[0] = flipped[0]! ^ 1;
        assert.throws(() => m.box.decryptSecret([v, iv, tag, flipped.toString("base64")].join(":")), /decrypt/);

        const original = process.env.MAIL_SECRET;
        process.env.MAIL_SECRET = "a-completely-different-secret-value-123";
        try {
            assert.throws(() => m.box.decryptSecret(stored), /decrypt/);
        } finally {
            process.env.MAIL_SECRET = original;
        }
    });

    it("refuses to work without a strong secret", () => {
        const original = process.env.MAIL_SECRET;
        process.env.MAIL_SECRET = "short";
        try {
            assert.throws(() => m.box.encryptSecret("x"), /MAIL_SECRET/);
        } finally {
            process.env.MAIL_SECRET = original;
        }
    });
});

describe("connecting a mailbox", () => {
    it("stores the account with an encrypted password that the API never exposes", async () => {
        const account = (await m.accountRepo.getMailAccount(candidateId))!;
        assert.equal(account.email, LOGIN.user);
        assert.ok(!JSON.stringify(account).includes(LOGIN.pass));

        const row = (await m.db.getDatabase().get<{ password_enc: string }>("SELECT password_enc FROM mail_accounts"))!;
        assert.ok(!row.password_enc.includes(LOGIN.pass));
        assert.equal((await m.accountRepo.getSmtpSettings(candidateId))!.password, LOGIN.pass);
    });

    it("rejects a wrong password with a readable message and saves nothing", async () => {
        await m.accountRepo.deleteMailAccount(candidateId);

        await assert.rejects(connect({ password: "wrong" }), /rejected the login|Invalid login/);
        assert.equal(await m.accountRepo.getMailAccount(candidateId), undefined);
    });

    it("needs a host for providers without a preset", async () => {
        await assert.rejects(m.account.connectMailbox(candidateId, { email: "me@small-company.test", password: "x" }), /SMTP server/);
    });

    it("refuses internal addresses and unusual ports unless local mode is on", async () => {
        process.env.MAIL_ALLOW_LOCAL = "false";

        await assert.rejects(connect(), /public address|not allowed/);
        await assert.rejects(connect({ host: "localhost", port: 587 }), /public address/);
        await assert.rejects(connect({ host: "169.254.169.254", port: 587 }), /public address/);
        await assert.rejects(connect({ host: "10.0.0.5", port: 22 }), /not allowed/);
    });
});

describe("queueing", () => {
    it("only queues approved matches that have a usable employer email", async () => {
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch({ approve: false })).id), /Approve the match first/);
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch({ email: null })).id), /no employer email/);
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch({ email: "info@topjobs.lk" })).id), /not usable/);
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch({ email: LOGIN.user })).id), /not usable/);
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch({ closingAt: "2020-01-01T00:00:00.000Z" })).id), /already closed/);

        await m.accountRepo.deleteMailAccount(candidateId);
        await assert.rejects(async () => await m.service.queueMatch((await approvedMatch()).id), /Connect your mailbox/);
    });

    it("is idempotent", async () => {
        const match = await approvedMatch();
        const first = await m.service.queueMatch(match.id);
        const second = await m.service.queueMatch(match.id);

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(second.application.id, first.application.id);
    });

    it("sends a second time only when asked to, and keeps the record of the first send", async () => {
        const match = await approvedMatch();
        const first = (await m.service.queueMatch(match.id)).application;
        assert.equal(await m.service.processNext(), "sent");
        const sentAt = (await m.apps.getApplication(first.id))!.sentAt;
        assert.equal(received.length, 1);

        // an ordinary queue request (a double click, the bulk "send all") must never send it twice
        const plain = await m.service.queueMatch(match.id);
        assert.equal(plain.created, false);
        assert.equal(plain.application.status, "sent");
        assert.equal(await m.service.processNext(), "idle");

        const again = await m.service.queueMatch(match.id, { again: true });
        assert.equal(again.created, true);
        assert.equal(again.application.id, first.id, "one application per match: the row is reused");
        assert.equal(again.application.status, "queued");
        assert.equal(again.application.sentAt, sentAt, "when it was first sent is not lost while the second send waits");

        // a second click while it waits queues nothing more
        assert.equal((await m.service.queueMatch(match.id, { again: true })).created, false);

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(received.length, 2);
        assert.equal((await m.apps.getApplication(first.id))!.status, "sent");
    });

    it("queues a whole batch and explains what it left out", async () => {
        const ok = await approvedMatch();
        await approvedMatch({ email: null });
        await approvedMatch({ approve: false });

        const result = await m.service.queueApproved(candidateId);
        assert.deepEqual(result.queued.map((a) => a.matchId), [ok.id]);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0]!.reason, /no employer email/);
    });
});

describe("sending", () => {
    it("revokes mailbox authority and outstanding approval when ownership changes", async () => {
        const match = await approvedMatch();
        const { application } = await m.service.queueMatch(match.id);
        const owner = (await m.candidates.getCandidate(candidateId))!.userId!;
        const next = (await m.users.createUser("new-owner@applicant.test", "not-a-real-hash"))!;
        await m.candidates.setCandidateOwner(candidateId, next.id);
        assert.equal(await m.accountRepo.getMailAccount(candidateId), undefined);
        assert.equal((await m.apps.getApplication(application.id))!.status, "cancelled");
        assert.equal((await m.matches.getMatch(match.id))!.status, "suggested");
        assert.equal(await m.service.processNext(), "idle");
        // A verification started by the former owner must not recreate that mailbox after transfer.
        await assert.rejects(m.accountRepo.saveMailAccount({ candidateId, email: LOGIN.user, password: LOGIN.pass, host: "127.0.0.1", port, secure: false, username: LOGIN.user, fromName: null }, owner), /Candidate not found/);
        assert.equal(await m.accountRepo.getMailAccount(candidateId), undefined);
    });

    it("keeps the mailbox when assigning the same owner and refuses transfers during a send", async () => {
        const owner = (await m.candidates.getCandidate(candidateId))!.userId!;
        await m.candidates.setCandidateOwner(candidateId, owner);
        assert.ok(await m.accountRepo.getMailAccount(candidateId));
        const { application } = await m.service.queueMatch((await approvedMatch()).id);
        await m.apps.claim(application.id);
        await assert.rejects(m.candidates.setCandidateOwner(candidateId, null), /being sent/);
        assert.equal((await m.candidates.getCandidate(candidateId))!.userId, owner);
        assert.ok(await m.accountRepo.getMailAccount(candidateId));
    });

    it("shares the daily allowance across resumes and accounts using the same mailbox", async () => {
        process.env.MAIL_DAILY_LIMIT = "1";
        await m.service.queueMatch((await approvedMatch()).id);
        assert.equal(await m.service.processNext(), "sent");
        const other = (await m.users.createUser("other@applicant.test", "not-a-real-hash"))!;
        candidateId = (await m.candidates.createCandidate({ userId: other.id, hash: `hash-${++counter}`, fileName: "Other CV.pdf", mimeType: "application/pdf", fileData: CV, profile: profile as never })).id;
        await connect();
        await m.service.queueMatch((await approvedMatch()).id);
        assert.equal(await m.service.processNext(), "deferred");
        assert.equal(received.length, 1);
    });

    it("counts every explicit resend rather than just the reused application row", async () => {
        process.env.MAIL_DAILY_LIMIT = "2";
        const match = await approvedMatch();
        await m.service.queueMatch(match.id);
        assert.equal(await m.service.processNext(), "sent");
        await m.service.queueMatch(match.id, { again: true });
        assert.equal(await m.service.processNext(), "sent");
        await m.service.queueMatch(match.id, { again: true });
        assert.equal(await m.service.processNext(), "deferred");
        assert.equal(received.length, 2);
    });

    it("shares SMTP login allowance even if separate accounts choose different From addresses", async () => {
        process.env.MAIL_DAILY_LIMIT = "1";
        await m.service.queueMatch((await approvedMatch()).id);
        assert.equal(await m.service.processNext(), "sent");
        const other = (await m.users.createUser("alias-owner@applicant.test", "not-a-real-hash"))!;
        candidateId = (await m.candidates.createCandidate({ userId: other.id, hash: `hash-${++counter}`, fileName: "Alias CV.pdf", mimeType: "application/pdf", fileData: CV, profile: profile as never })).id;
        await connect({ email: "different-from@applicant.test", username: LOGIN.user });
        await m.service.queueMatch((await approvedMatch()).id);
        assert.equal(await m.service.processNext(), "deferred");
        assert.equal(received.length, 1);
    });

    it("reserves a shared allowance atomically for different applications", async () => {
        const a = (await m.service.queueMatch((await approvedMatch()).id)).application;
        const b = (await m.service.queueMatch((await approvedMatch()).id)).application;
        const owner = (await m.candidates.getCandidate(candidateId))!.userId!;
        const outcomes = await Promise.all([a, b].map((application) => m.apps.reserveSend(application.id, owner, LOGIN.user, new Date(), 1, 0)));
        assert.equal(outcomes.filter((result) => result.kind === "claimed").length, 1);
        assert.equal(outcomes.filter((result) => result.kind === "deferred").length, 1);
    });
    it("delivers the letter with the CV attached, exactly once", async () => {
        const match = await approvedMatch({ email: "Recruiter@Employer.test" });
        const { application } = await m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "idle");

        assert.equal(received.length, 1);
        const mail = received[0]!;
        assert.deepEqual(mail.to, ["recruiter@employer.test"]);
        assert.match(mail.raw, /^Subject: Application for Engineer \d+/m);
        assert.match(mail.raw, /^From: "?Test Applicant"? <me@applicant\.test>/m);
        assert.match(mail.raw, /Please consider my application\./);
        assert.match(mail.raw, /filename="?My CV\.pdf"?/);
        assert.ok(mail.raw.includes(CV.toString("base64")), "the CV bytes are attached");

        const stored = (await m.apps.getApplication(application.id))!;
        assert.equal(stored.status, "sent");
        assert.ok(stored.messageId && stored.sentAt);
        assert.match(stored.sentBody ?? "", /Please consider/);
    });

    it("cannot be made to inject extra headers through the subject", async () => {
        const match = await approvedMatch();
        await m.matches.saveDraft(match.id, "Hello\r\nBcc: victim@elsewhere.test", "Dear Hiring Manager,\n\nPlease consider my application.");
        await m.matches.setStatus(match.id, "approved");
        await m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "sent");
        assert.doesNotMatch(received[0]!.raw, /^Bcc:/im);
        assert.deepEqual(received[0]!.to.length, 1);
    });

    it("sends nothing if the user changed their mind after queueing", async () => {
        const edited = await approvedMatch();
        await m.service.queueMatch(edited.id);
        await m.matchService.editCoverLetter(edited.id, { coverLetter: "A different letter" }); // withdraws approval

        const rejected = await approvedMatch();
        await m.service.queueMatch(rejected.id);
        await m.matchService.rejectMatch(rejected.id);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(await m.service.processNext(), "idle");
        assert.equal(received.length, 0);
        assert.equal((await m.apps.getApplicationByMatch(edited.id))!.status, "cancelled");
    });

    it("cancels if the employer address changed after queueing", async () => {
        const match = await approvedMatch();
        await m.service.queueMatch(match.id);
        await m.db.getDatabase().run("UPDATE jobs SET apply_email = 'other@employer.test' WHERE id = ?", [match.jobId]);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(received.length, 0);
    });

    it("lets the user cancel a queued application but not a sent one", async () => {
        const waiting = (await m.service.queueMatch((await approvedMatch()).id)).application;
        assert.equal((await m.service.cancelApplication(waiting.id)).status, "cancelled");
        assert.equal(await m.service.processNext(), "idle");

        const sent = (await m.service.queueMatch((await approvedMatch()).id)).application;
        await m.service.processNext();
        await assert.rejects(async () => await m.service.cancelApplication(sent.id), /already been sent/);
    });

    it("fails permanently, without retrying, when the server refuses the recipient", async () => {
        const match = await approvedMatch({ email: "gone@employer.test" });
        rejectRecipient = "gone@employer.test";
        const { application } = await m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "failed");
        const failed = (await m.apps.getApplication(application.id))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.attempts, 1);
        assert.match(failed.error ?? "", /550|unavailable/i);
        assert.equal(await m.service.processNext(), "idle");

        // an explicit retry is allowed, and succeeds once the problem is gone
        rejectRecipient = "";
        await m.service.retryApplication(application.id);
        assert.equal(await m.service.processNext(), "sent");
        await assert.rejects(async () => await m.service.retryApplication(application.id), /Only failed/);
    });

    it("fails without retrying when the mailbox login stops working", async () => {
        const { application } = await m.service.queueMatch((await approvedMatch()).id);
        await m.db.getDatabase().run("UPDATE mail_accounts SET password_enc = ?", [m.box.encryptSecret("changed-password")]);

        assert.equal(await m.service.processNext(), "failed");
        assert.match((await m.apps.getApplication(application.id))!.error ?? "", /rejected the login/);
    });

    it("retries later, with backoff, when the mail server cannot be reached", async () => {
        const { application } = await m.service.queueMatch((await approvedMatch()).id);
        await m.db.getDatabase().run("UPDATE mail_accounts SET port = 1"); // nothing listens there

        assert.equal(await m.service.processNext(), "deferred");
        const waiting = (await m.apps.getApplication(application.id))!;
        assert.equal(waiting.status, "queued");
        assert.equal(waiting.attempts, 1);
        assert.ok(new Date(waiting.nextAttemptAt) > new Date(), "next attempt is in the future");
        assert.equal(await m.service.processNext(), "idle", "not due yet");

        // after the last allowed attempt it gives up and says so
        for (let attempt = 2; attempt <= 3; attempt++) {
            await m.db.getDatabase().run("UPDATE applications SET next_attempt_at = ?", [new Date(0).toISOString()]);
            await m.service.processNext();
        }
        assert.equal((await m.apps.getApplication(application.id))!.status, "failed");
        assert.equal(received.length, 0);
    });

    it("respects the daily limit and carries the rest over", async () => {
        process.env.MAIL_DAILY_LIMIT = "2";
        const queued = [];
        for (const match of [await approvedMatch(), await approvedMatch(), await approvedMatch()]) queued.push((await m.service.queueMatch(match.id)).application);

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "deferred");

        assert.equal(received.length, 2);
        const third = (await m.apps.getApplication(queued[2]!.id))!;
        assert.equal(third.status, "queued");
        assert.match(third.error ?? "", /Daily limit/);
    });

    it("keeps a pause between consecutive messages", async () => {
        process.env.MAIL_SEND_GAP_SECONDS = "3600";
        const a = (await m.service.queueMatch((await approvedMatch()).id)).application;
        const b = (await m.service.queueMatch((await approvedMatch()).id)).application;

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "deferred");
        assert.equal(received.length, 1);
        assert.ok(new Date((await m.apps.getApplication(b!.id))!.nextAttemptAt) > new Date(Date.now() + 3000_000));
        assert.equal((await m.apps.getApplication(a!.id))!.status, "sent");
    });

    it("never lets two workers send the same application", async () => {
        const { application } = await m.service.queueMatch((await approvedMatch()).id);

        const results = await Promise.all([m.service.processNext(), m.service.processNext(), m.service.processNext()]);

        assert.equal(results.filter((r) => r === "sent").length, 1);
        assert.equal(received.length, 1);
        assert.equal(await m.apps.claim(application.id), undefined, "a sent application cannot be claimed again");
    });

    it("never retries an application that was interrupted mid-send", async () => {
        const { application } = await m.service.queueMatch((await approvedMatch()).id);
        assert.ok(await m.apps.claim(application.id)); // worker "crashes" right after claiming
        assert.equal(await m.apps.failInterrupted(), 0, "a live claim may belong to another worker");
        await m.db.getDatabase().run("UPDATE applications SET updated_at = ? WHERE id = ?", [new Date(Date.now() - 6 * 60_000).toISOString(), application.id]);
        assert.equal(await m.apps.failInterrupted(), 1);
        const stored = (await m.apps.getApplication(application.id))!;
        assert.equal(stored.status, "failed");
        assert.match(stored.error ?? "", /Check the Sent folder/);
        assert.equal(await m.service.processNext(), "idle");
        assert.equal(received.length, 0);
    });
});

describe("addresses read from pictures", () => {
    it("cannot be queued until the user confirms the address", async () => {
        const match = await approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        await assert.rejects(async () => await m.service.queueMatch(match.id), /read from a picture/);
        assert.match((await m.service.previewMessage(match.id)).problems.join(" "), /read from a picture/);
    });

    it("rejects a confirmation that does not match the address on file, and accepts one that does", async () => {
        const match = await approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        await assert.rejects(async () => await m.matchService.confirmAddress(match.id, "career@acme.lk"), /does not match/);
        await assert.rejects(async () => await m.matchService.confirmAddress(match.id, ""), /does not match/);
        await assert.rejects(async () => await m.service.queueMatch(match.id), /read from a picture/, "a failed confirmation changes nothing");

        await m.matchService.confirmAddress(match.id, "  Careers@ACME.lk ");
        await assert.doesNotReject(async () => await m.service.queueMatch(match.id));
    });

    it("sends once confirmed", async () => {
        const match = await approvedMatch({ email: "careers@acme.lk", emailSource: "image" });
        await m.matchService.confirmAddress(match.id, "careers@acme.lk");
        await m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "sent");
        assert.deepEqual(received[0]!.to, ["careers@acme.lk"]);
    });

    it("loses the confirmation if the address on the job changes, even after queueing", async () => {
        const match = await approvedMatch({ email: "careers@acme.lk", emailSource: "image" });
        await m.matchService.confirmAddress(match.id, "careers@acme.lk");
        await m.service.queueMatch(match.id);

        // the advert is re-read and OCR now sees a different address
        await m.db.getDatabase().run("UPDATE jobs SET apply_email = 'jobs@acme.lk' WHERE id = ?", [match.jobId]);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(received.length, 0);
        await assert.rejects(async () => await m.service.queueMatch(match.id), /read from a picture|already/);
    });

    it("is not required for addresses written in the advert's text", async () => {
        const match = await approvedMatch({ email: "hr@acme.lk" });
        await assert.doesNotReject(async () => await m.service.queueMatch(match.id));
    });

    it("tells the preview where to check the original", async () => {
        const match = await approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        const before = (await m.service.previewMessage(match.id)).message;
        assert.equal(before.addressSource, "image");
        assert.equal(before.addressConfirmed, false);
        assert.match(before.verifyAt ?? "", /^https:\/\/example\.test\//);

        await m.matchService.confirmAddress(match.id, "careers@acme.lk");
        assert.equal((await m.service.previewMessage(match.id)).message.addressConfirmed, true);
    });
});

describe("preview", () => {
    it("shows the exact message and what still blocks it", async () => {
        const ready = await m.service.previewMessage((await approvedMatch({ email: "hr@employer.test" })).id);
        assert.deepEqual(ready.problems, []);
        assert.equal(ready.message.to, "hr@employer.test");
        assert.match(ready.message.from, /Test Applicant <me@applicant\.test>/);
        assert.deepEqual(ready.message.attachment, { fileName: "My CV.pdf", bytes: CV.length });

        const blocked = await m.service.previewMessage((await approvedMatch({ approve: false, email: null })).id);
        assert.ok(blocked.problems.length >= 2);
    });
});
