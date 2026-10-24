import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";

// Configuration must be in place before the modules under test are loaded
process.env.DATABASE_PATH = ":memory:";
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
function approvedMatch(overrides: { email?: string | null; closingAt?: string | null; approve?: boolean; emailSource?: "image" } = {}) {
    const n = ++counter;
    const email = overrides.email === undefined ? `hr${n}@employer.test` : overrides.email;

    m.jobs.upsertJobs([{
        source: "xpress", externalId: `job-${n}`, url: `https://example.test/${n}`, title: `Engineer ${n}`, company: "Employer",
        location: "Colombo", description: null, jobType: null, salary: null, category: null, postedAt: null,
        closingAt: overrides.closingAt ?? null, applyEmail: email, applyEmailSource: overrides.emailSource ?? null, applyUrl: null,
    }]);
    const job = m.jobs.listJobs({ search: `Engineer ${n}`, limit: 1 })[0]!;

    m.matches.saveMatches(candidateId, [
        ...m.matches.listMatches(candidateId, { limit: 500 }).map((x) => ({ jobId: x.jobId, score: x.score, details: x.details })),
        { jobId: job.id, score: 80, details: { breakdown: { skills: 1, title: 1, content: 1, experience: 1, location: 1 }, matchedSkills: [], reasons: [], warnings: [] } },
    ]);
    const match = m.matches.listMatches(candidateId, { limit: 500 }).find((x) => x.jobId === job.id)!;

    m.matches.saveDraft(match.id, `Application for Engineer ${n}`, "Dear Hiring Manager,\n\nPlease consider my application.\n\nSincerely,\nTest Applicant");
    if (overrides.approve !== false) m.matches.setStatus(match.id, "approved");
    return m.matches.getMatch(match.id)!;
}

beforeEach(async () => {
    received.length = 0;
    rejectRecipient = "";
    process.env.MAIL_ALLOW_LOCAL = "true";
    process.env.MAIL_SEND_GAP_SECONDS = "0";
    process.env.MAIL_DAILY_LIMIT = "100";

    m.db.getDatabase().exec("DELETE FROM applications; DELETE FROM matches; DELETE FROM jobs; DELETE FROM mail_accounts; DELETE FROM candidates; DELETE FROM sessions; DELETE FROM users;");
    const owner = m.users.createUser("owner@applicant.test", "not-a-real-hash")!;
    candidateId = m.candidates.createCandidate({
        userId: owner.id, hash: `hash-${++counter}`, fileName: "My CV.pdf", mimeType: "application/pdf", fileData: CV, profile: profile as never,
    }).id;
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
    it("stores the account with an encrypted password that the API never exposes", () => {
        const account = m.accountRepo.getMailAccount(candidateId)!;
        assert.equal(account.email, LOGIN.user);
        assert.ok(!JSON.stringify(account).includes(LOGIN.pass));

        const row = m.db.getDatabase().prepare("SELECT password_enc FROM mail_accounts").get() as { password_enc: string };
        assert.ok(!row.password_enc.includes(LOGIN.pass));
        assert.equal(m.accountRepo.getSmtpSettings(candidateId)!.password, LOGIN.pass);
    });

    it("rejects a wrong password with a readable message and saves nothing", async () => {
        m.accountRepo.deleteMailAccount(candidateId);

        await assert.rejects(connect({ password: "wrong" }), /rejected the login|Invalid login/);
        assert.equal(m.accountRepo.getMailAccount(candidateId), undefined);
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
    it("only queues approved matches that have a usable employer email", () => {
        assert.throws(() => m.service.queueMatch(approvedMatch({ approve: false }).id), /Approve the match first/);
        assert.throws(() => m.service.queueMatch(approvedMatch({ email: null }).id), /no employer email/);
        assert.throws(() => m.service.queueMatch(approvedMatch({ email: "info@topjobs.lk" }).id), /not usable/);
        assert.throws(() => m.service.queueMatch(approvedMatch({ email: LOGIN.user }).id), /not usable/);
        assert.throws(() => m.service.queueMatch(approvedMatch({ closingAt: "2020-01-01T00:00:00.000Z" }).id), /already closed/);

        m.accountRepo.deleteMailAccount(candidateId);
        assert.throws(() => m.service.queueMatch(approvedMatch().id), /Connect your mailbox/);
    });

    it("is idempotent", () => {
        const match = approvedMatch();
        const first = m.service.queueMatch(match.id);
        const second = m.service.queueMatch(match.id);

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(second.application.id, first.application.id);
    });

    it("queues a whole batch and explains what it left out", () => {
        const ok = approvedMatch();
        approvedMatch({ email: null });
        approvedMatch({ approve: false });

        const result = m.service.queueApproved(candidateId);
        assert.deepEqual(result.queued.map((a) => a.matchId), [ok.id]);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0]!.reason, /no employer email/);
    });
});

describe("sending", () => {
    it("delivers the letter with the CV attached, exactly once", async () => {
        const match = approvedMatch({ email: "Recruiter@Employer.test" });
        const { application } = m.service.queueMatch(match.id);

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

        const stored = m.apps.getApplication(application.id)!;
        assert.equal(stored.status, "sent");
        assert.ok(stored.messageId && stored.sentAt);
        assert.match(stored.sentBody ?? "", /Please consider/);
    });

    it("cannot be made to inject extra headers through the subject", async () => {
        const match = approvedMatch();
        m.matches.saveDraft(match.id, "Hello\r\nBcc: victim@elsewhere.test", "Dear Hiring Manager,\n\nPlease consider my application.");
        m.matches.setStatus(match.id, "approved");
        m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "sent");
        assert.doesNotMatch(received[0]!.raw, /^Bcc:/im);
        assert.deepEqual(received[0]!.to.length, 1);
    });

    it("sends nothing if the user changed their mind after queueing", async () => {
        const edited = approvedMatch();
        m.service.queueMatch(edited.id);
        m.matchService.editCoverLetter(edited.id, { coverLetter: "A different letter" }); // withdraws approval

        const rejected = approvedMatch();
        m.service.queueMatch(rejected.id);
        m.matchService.rejectMatch(rejected.id);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(await m.service.processNext(), "idle");
        assert.equal(received.length, 0);
        assert.equal(m.apps.getApplicationByMatch(edited.id)!.status, "cancelled");
    });

    it("cancels if the employer address changed after queueing", async () => {
        const match = approvedMatch();
        m.service.queueMatch(match.id);
        m.db.getDatabase().prepare("UPDATE jobs SET apply_email = 'other@employer.test' WHERE id = ?").run(match.jobId);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(received.length, 0);
    });

    it("lets the user cancel a queued application but not a sent one", async () => {
        const waiting = m.service.queueMatch(approvedMatch().id).application;
        assert.equal(m.service.cancelApplication(waiting.id).status, "cancelled");
        assert.equal(await m.service.processNext(), "idle");

        const sent = m.service.queueMatch(approvedMatch().id).application;
        await m.service.processNext();
        assert.throws(() => m.service.cancelApplication(sent.id), /already been sent/);
    });

    it("fails permanently, without retrying, when the server refuses the recipient", async () => {
        const match = approvedMatch({ email: "gone@employer.test" });
        rejectRecipient = "gone@employer.test";
        const { application } = m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "failed");
        const failed = m.apps.getApplication(application.id)!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.attempts, 1);
        assert.match(failed.error ?? "", /550|unavailable/i);
        assert.equal(await m.service.processNext(), "idle");

        // an explicit retry is allowed, and succeeds once the problem is gone
        rejectRecipient = "";
        m.service.retryApplication(application.id);
        assert.equal(await m.service.processNext(), "sent");
        assert.throws(() => m.service.retryApplication(application.id), /Only failed/);
    });

    it("fails without retrying when the mailbox login stops working", async () => {
        const { application } = m.service.queueMatch(approvedMatch().id);
        m.db.getDatabase().prepare("UPDATE mail_accounts SET password_enc = ?").run(m.box.encryptSecret("changed-password"));

        assert.equal(await m.service.processNext(), "failed");
        assert.match(m.apps.getApplication(application.id)!.error ?? "", /rejected the login/);
    });

    it("retries later, with backoff, when the mail server cannot be reached", async () => {
        const { application } = m.service.queueMatch(approvedMatch().id);
        m.db.getDatabase().prepare("UPDATE mail_accounts SET port = 1").run(); // nothing listens there

        assert.equal(await m.service.processNext(), "deferred");
        const waiting = m.apps.getApplication(application.id)!;
        assert.equal(waiting.status, "queued");
        assert.equal(waiting.attempts, 1);
        assert.ok(new Date(waiting.nextAttemptAt) > new Date(), "next attempt is in the future");
        assert.equal(await m.service.processNext(), "idle", "not due yet");

        // after the last allowed attempt it gives up and says so
        for (let attempt = 2; attempt <= 3; attempt++) {
            m.db.getDatabase().prepare("UPDATE applications SET next_attempt_at = ?").run(new Date(0).toISOString());
            await m.service.processNext();
        }
        assert.equal(m.apps.getApplication(application.id)!.status, "failed");
        assert.equal(received.length, 0);
    });

    it("respects the daily limit and carries the rest over", async () => {
        process.env.MAIL_DAILY_LIMIT = "2";
        const queued = [approvedMatch(), approvedMatch(), approvedMatch()].map((x) => m.service.queueMatch(x.id).application);

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "deferred");

        assert.equal(received.length, 2);
        const third = m.apps.getApplication(queued[2]!.id)!;
        assert.equal(third.status, "queued");
        assert.match(third.error ?? "", /Daily limit/);
    });

    it("keeps a pause between consecutive messages", async () => {
        process.env.MAIL_SEND_GAP_SECONDS = "3600";
        const [a, b] = [approvedMatch(), approvedMatch()].map((x) => m.service.queueMatch(x.id).application);

        assert.equal(await m.service.processNext(), "sent");
        assert.equal(await m.service.processNext(), "deferred");
        assert.equal(received.length, 1);
        assert.ok(new Date(m.apps.getApplication(b!.id)!.nextAttemptAt) > new Date(Date.now() + 3000_000));
        assert.equal(m.apps.getApplication(a!.id)!.status, "sent");
    });

    it("never lets two workers send the same application", async () => {
        const { application } = m.service.queueMatch(approvedMatch().id);

        const results = await Promise.all([m.service.processNext(), m.service.processNext(), m.service.processNext()]);

        assert.equal(results.filter((r) => r === "sent").length, 1);
        assert.equal(received.length, 1);
        assert.equal(m.apps.claim(application.id), undefined, "a sent application cannot be claimed again");
    });

    it("never retries an application that was interrupted mid-send", async () => {
        const { application } = m.service.queueMatch(approvedMatch().id);
        assert.ok(m.apps.claim(application.id)); // worker "crashes" right after claiming

        assert.equal(m.apps.failInterrupted(), 1);
        const stored = m.apps.getApplication(application.id)!;
        assert.equal(stored.status, "failed");
        assert.match(stored.error ?? "", /Check the Sent folder/);
        assert.equal(await m.service.processNext(), "idle");
        assert.equal(received.length, 0);
    });
});

describe("addresses read from pictures", () => {
    it("cannot be queued until the user confirms the address", () => {
        const match = approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        assert.throws(() => m.service.queueMatch(match.id), /read from a picture/);
        assert.match(m.service.previewMessage(match.id).problems.join(" "), /read from a picture/);
    });

    it("rejects a confirmation that does not match the address on file, and accepts one that does", () => {
        const match = approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        assert.throws(() => m.matchService.confirmAddress(match.id, "career@acme.lk"), /does not match/);
        assert.throws(() => m.matchService.confirmAddress(match.id, ""), /does not match/);
        assert.throws(() => m.service.queueMatch(match.id), /read from a picture/, "a failed confirmation changes nothing");

        m.matchService.confirmAddress(match.id, "  Careers@ACME.lk ");
        assert.doesNotThrow(() => m.service.queueMatch(match.id));
    });

    it("sends once confirmed", async () => {
        const match = approvedMatch({ email: "careers@acme.lk", emailSource: "image" });
        m.matchService.confirmAddress(match.id, "careers@acme.lk");
        m.service.queueMatch(match.id);

        assert.equal(await m.service.processNext(), "sent");
        assert.deepEqual(received[0]!.to, ["careers@acme.lk"]);
    });

    it("loses the confirmation if the address on the job changes, even after queueing", async () => {
        const match = approvedMatch({ email: "careers@acme.lk", emailSource: "image" });
        m.matchService.confirmAddress(match.id, "careers@acme.lk");
        m.service.queueMatch(match.id);

        // the advert is re-read and OCR now sees a different address
        m.db.getDatabase().prepare("UPDATE jobs SET apply_email = 'jobs@acme.lk' WHERE id = ?").run(match.jobId);

        assert.equal(await m.service.processNext(), "cancelled");
        assert.equal(received.length, 0);
        assert.throws(() => m.service.queueMatch(match.id), /read from a picture|already/);
    });

    it("is not required for addresses written in the advert's text", () => {
        const match = approvedMatch({ email: "hr@acme.lk" });
        assert.doesNotThrow(() => m.service.queueMatch(match.id));
    });

    it("tells the preview where to check the original", () => {
        const match = approvedMatch({ email: "careers@acme.lk", emailSource: "image" });

        const before = m.service.previewMessage(match.id).message;
        assert.equal(before.addressSource, "image");
        assert.equal(before.addressConfirmed, false);
        assert.match(before.verifyAt ?? "", /^https:\/\/example\.test\//);

        m.matchService.confirmAddress(match.id, "careers@acme.lk");
        assert.equal(m.service.previewMessage(match.id).message.addressConfirmed, true);
    });
});

describe("preview", () => {
    it("shows the exact message and what still blocks it", () => {
        const ready = m.service.previewMessage(approvedMatch({ email: "hr@employer.test" }).id);
        assert.deepEqual(ready.problems, []);
        assert.equal(ready.message.to, "hr@employer.test");
        assert.match(ready.message.from, /Test Applicant <me@applicant\.test>/);
        assert.deepEqual(ready.message.attachment, { fileName: "My CV.pdf", bytes: CV.length });

        const blocked = m.service.previewMessage(approvedMatch({ approve: false, email: null }).id);
        assert.ok(blocked.problems.length >= 2);
    });
});
