import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

// Configuration must be in place before the modules under test are loaded
import { clearDatabase } from "../db/test-helpers.js";
delete process.env.COLLECTION_MAX_AGE_HOURS;

type Mods = {
    db: typeof import("../db/database.js");
    users: typeof import("../auth/user.repository.js");
    candidates: typeof import("../candidates/candidate.repository.js");
    jobs: typeof import("../jobs/job.repository.js");
    collection: typeof import("../jobs/collection.service.js");
    tracker: typeof import("./run-tracker.js");
};
let m: Mods;
let candidateId: number;
const realFetch = globalThis.fetch;

const posting = (n: number) => ({
    source: "xpress" as const, externalId: `job-${n}`, url: `https://example.test/${n}`, title: `Full Stack Developer ${n}`,
    company: "Acme", location: "Colombo", description: "Build web apps with React, Node.js and TypeScript.",
    jobType: null, salary: null, category: null, postedAt: null, closingAt: null, applyEmail: null, applyUrl: null,
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean) => {
    for (let waited = 0; !condition(); waited += 5) {
        if (waited > 5000) throw new Error("timed out waiting for the search");
        await tick(5);
    }
};

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("../auth/user.repository.js"),
        candidates: await import("../candidates/candidate.repository.js"),
        jobs: await import("../jobs/job.repository.js"),
        collection: await import("../jobs/collection.service.js"),
        tracker: await import("./run-tracker.js"),
    };
});

beforeEach(async () => {
    m.tracker.forgetRuns();
    m.collection.setCollector();
    await clearDatabase();
    const user = (await m.users.createUser("a@example.test", "x"))!;
    candidateId = (await m.candidates.createCandidate({
        userId: user.id, hash: "h", fileName: "cv.pdf", mimeType: "application/pdf", fileData: Buffer.from("cv"),
        profile: {
            personalInfo: { fullName: "Ama", email: null, phone: null, location: "Colombo, Sri Lanka", linkedin: null, portfolio: null },
            skills: ["React", "Node.js", "TypeScript"],
            education: [], experience: [{ company: "Webminds", position: "Full Stack Developer", startDate: "2023-01", endDate: "Present", responsibilities: ["Built React apps"] }],
            certifications: [], achievements: [],
        },
    })).id;
});

after(() => {
    globalThis.fetch = realFetch;
    m.collection.setCollector();
});

describe("following a search", () => {
    it("is null before anything has been searched", () => {
        assert.equal(m.tracker.getRun(candidateId), null);
    });

    it("returns at once and shows what each job site is doing while it collects", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        m.collection.setCollector(async (report) => {
            report({ source: "xpress", state: "reading", fetched: 0 });
            report({ source: "rooster", state: "reading", fetched: 0 });
            report({ source: "xpress", state: "reading", fetched: 50 });
            await gate;
            await m.jobs.upsertJobs([posting(1), posting(2)]);
            report({ source: "xpress", state: "done", fetched: 2 });
            report({ source: "rooster", state: "failed", fetched: 0, error: "fetch failed" });
            return [
                { source: "xpress", fetched: 2, inserted: 2, updated: 0 },
                { source: "rooster", fetched: 0, inserted: 0, updated: 0, error: "fetch failed" },
            ];
        });

        const started = m.tracker.startRun(candidateId, { enrichTop: 0 });
        assert.equal(started.status, "running");
        assert.ok(["starting", "collecting"].includes(started.phase));

        await until(() => (m.tracker.getRun(candidateId)?.sites.length ?? 0) === 2);
        const during = m.tracker.getRun(candidateId)!;
        assert.equal(during.status, "running");
        assert.equal(during.phase, "collecting");
        assert.deepEqual(during.sites.find((site) => site.source === "xpress"), { source: "xpress", state: "reading", fetched: 50 });
        assert.equal(during.considered, null);

        release();
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");
        const after = m.tracker.getRun(candidateId)!;

        assert.equal(after.status, "done");
        assert.equal(after.phase, "done");
        assert.equal(after.considered, 2);
        assert.deepEqual(after.sites.map((site) => [site.source, site.state]).sort(), [["rooster", "failed"], ["xpress", "done"]]);
        assert.equal(after.summary?.considered, 2);
        assert.equal(after.summary?.sourcesFailed, 1);
        assert.equal(after.matched, after.summary?.matched);
        assert.ok(after.activity.some((entry) => /Xpress: found 2 vacancies/.test(entry.text)));
        assert.ok(after.activity.some((entry) => /Rooster could not be read/.test(entry.text)));
    });

    it("reports which advert is being read, out of how many", async () => {
        await m.jobs.upsertJobs([posting(1), posting(2)]);
        const seen: unknown[] = [];
        globalThis.fetch = (async () => {
            const snapshot = m.tracker.getRun(candidateId)!;
            seen.push({ phase: snapshot.phase, ...snapshot.adverts });
            return Response.json({ jobInfo: "Build React apps", education: "Any", experience: "Any", salaryRange: "Any" });
        }) as typeof fetch;

        m.tracker.startRun(candidateId, { enrichTop: 2 });
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");

        assert.equal(seen.length, 2);
        for (const [index, entry] of (seen as { phase: string; done: number; total: number; current: { title: string; company: string; source: string } }[]).entries()) {
            assert.equal(entry.phase, "reading");
            assert.equal(entry.done, index);
            assert.equal(entry.total, 2);
            assert.match(entry.current.title, /^Full Stack Developer \d$/);
            assert.equal(entry.current.company, "Acme");
            assert.equal(entry.current.source, "xpress");
        }

        const finished = m.tracker.getRun(candidateId)!;
        assert.equal(finished.summary?.enriched, 2);
        assert.equal(finished.adverts.current, null, "nothing is 'being read' once the search is over");
    });

    it("keeps a failed search's reason and does not leak internal errors", async () => {
        m.collection.setCollector(async () => []);
        m.tracker.startRun(candidateId, { enrichTop: 0 });
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");

        const failed = m.tracker.getRun(candidateId)!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.phase, "failed");
        assert.match(failed.error ?? "", /could not collect any vacancies/);
        assert.equal(failed.summary, null);

        m.collection.setCollector(async () => {
            throw new Error("connect ECONNREFUSED 10.0.0.5:5432 secret-token");
        });
        const log = console.error;
        console.error = () => {};
        try {
            m.tracker.startRun(candidateId, { enrichTop: 0 });
            await until(() => m.tracker.getRun(candidateId)!.status !== "running");
        } finally {
            console.error = log;
        }
        assert.doesNotMatch(m.tracker.getRun(candidateId)!.error ?? "", /ECONNREFUSED|secret-token/);
    });

    it("never starts a second search while one is running, but allows a new one afterwards", async () => {
        let starts = 0;
        m.collection.setCollector(async () => {
            starts++;
            await tick(40);
            await m.jobs.upsertJobs([posting(1)]);
            return [{ source: "xpress", fetched: 1, inserted: 1, updated: 0 }];
        });

        const first = m.tracker.startRun(candidateId, { enrichTop: 0 });
        const second = m.tracker.startRun(candidateId, { enrichTop: 0 });
        assert.equal(second.startedAt, first.startedAt);

        await until(() => m.tracker.getRun(candidateId)!.status !== "running");
        assert.equal(starts, 1);

        await tick(5);
        const third = m.tracker.startRun(candidateId, { enrichTop: 0 });
        assert.equal(third.status, "running");
        assert.deepEqual(third.sites, [], "a new search starts from a clean slate");
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");
    });

    it("measures elapsed time on the server and stops the clock when the search ends", async () => {
        await m.jobs.upsertJobs([posting(1)]);
        m.tracker.startRun(candidateId, { enrichTop: 0 });
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");

        const first = m.tracker.getRun(candidateId)!.elapsedMs;
        await tick(30);
        assert.equal(m.tracker.getRun(candidateId)!.elapsedMs, first);
        assert.ok(first >= 0);
    });

    it("keeps a search per CV, so one person's progress is never shown for another's", async () => {
        const other = (await m.candidates.createCandidate({
            userId: (await m.users.createUser("b@example.test", "x"))!.id, hash: "h2", fileName: "b.pdf", mimeType: "application/pdf", fileData: Buffer.from("b"),
            profile: { personalInfo: { fullName: "Bo", email: null, phone: null, location: null, linkedin: null, portfolio: null }, skills: [], education: [], experience: [], certifications: [], achievements: [] },
        })).id;

        await m.jobs.upsertJobs([posting(1)]);
        m.tracker.startRun(candidateId, { enrichTop: 0 });
        await until(() => m.tracker.getRun(candidateId)!.status !== "running");

        assert.equal(m.tracker.getRun(other), null);
    });
});

describe("collection following", () => {
    it("lets a search that joins a running collection see the sites that already reported", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        m.collection.setCollector(async (report) => {
            report({ source: "ikman", state: "reading", fetched: 30 });
            await gate;
            return [];
        });

        const running = m.collection.collectVacancies();
        const heard: string[] = [];
        const stop = m.collection.followCollection((event) => heard.push(`${event.source}:${event.fetched}`));
        assert.deepEqual(heard, ["ikman:30"]);

        stop();
        release();
        await running;
    });
});
