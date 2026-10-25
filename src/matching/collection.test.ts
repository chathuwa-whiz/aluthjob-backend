import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

// Configuration must be in place before the modules under test are loaded
import { clearDatabase } from "../db/test-helpers.js";
delete process.env.COLLECTION_MAX_AGE_HOURS;

type Mods = {
    db: typeof import("../db/database.js");
    users: typeof import("../auth/user.repository.js");
    candidates: typeof import("../candidates/candidate.repository.js");
    jobs: typeof import("../jobs/job.repository.js");
    collection: typeof import("../jobs/collection.service.js");
    matching: typeof import("./match.service.js");
};
let m: Mods;
let candidateId: number;

const posting = (n: number) => ({
    source: "xpress" as const, externalId: `job-${n}`, url: `https://example.test/${n}`, title: "Full Stack Developer",
    company: "Acme", location: "Colombo", description: "Build web apps with React, Node.js and TypeScript.",
    jobType: null, salary: null, category: null, postedAt: null, closingAt: null, applyEmail: null, applyUrl: null,
});

const results = (fetched: number, failed = 0) => [
    { source: "xpress" as const, fetched, inserted: fetched, updated: 0 },
    ...Array.from({ length: failed }, () => ({ source: "rooster" as const, fetched: 0, inserted: 0, updated: 0, error: "fetch failed" })),
];

/** A stand-in for the real collector that stores vacancies like the real one does and counts its calls. */
function fakeCollector(count: number, options: { failedSites?: number; delayMs?: number } = {}) {
    const state = { calls: 0 };
    m.collection.setCollector(async () => {
        state.calls++;
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        await m.jobs.upsertJobs(Array.from({ length: count }, (_, index) => posting(index + 1)));
        return results(count, options.failedSites);
    });
    return state;
}

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("../auth/user.repository.js"),
        candidates: await import("../candidates/candidate.repository.js"),
        jobs: await import("../jobs/job.repository.js"),
        collection: await import("../jobs/collection.service.js"),
        matching: await import("./match.service.js"),
    };
});

beforeEach(async () => {
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

const search = () => m.matching.runMatching(candidateId, { enrichTop: 0 });

describe("a first search on an empty store", () => {
    it("collects vacancies first instead of 'finishing' a search of nothing, and says what it collected", async () => {
        const collector = fakeCollector(5);

        const summary = await search();

        assert.equal(collector.calls, 1);
        assert.equal(summary.considered, 5);
        assert.equal(summary.collected, 5);
        assert.equal(summary.sourcesFailed, 0);
        assert.ok(summary.matched > 0, "the vacancies it just collected were searched");
    });

    it("reports a partial collection honestly", async () => {
        fakeCollector(3, { failedSites: 2 });

        const summary = await search();
        assert.equal(summary.considered, 3);
        assert.equal(summary.sourcesFailed, 2);
    });

    it("fails with the reason when no job site could be read, rather than reporting an empty success", async () => {
        m.collection.setCollector(async () => results(0, 3));

        await assert.rejects(search(), /could not collect any vacancies.*fetch failed.*reach the internet/s);
        assert.equal((await m.db.getDatabase().get<{ n: number }>("SELECT COUNT(*) AS n FROM matches"))!.n, 0);
    });

    it("lets two people searching at once share one collection instead of reading every site twice", async () => {
        const collector = fakeCollector(4, { delayMs: 50 });

        const [first, second] = await Promise.all([search(), search()]);

        assert.equal(collector.calls, 1);
        assert.equal(first.considered, 4);
        assert.equal(second.considered, 4);
    });

    it("can collect again once the previous collection has ended", async () => {
        const collector = fakeCollector(2);
        await m.collection.collectVacancies();
        await m.collection.collectVacancies();
        assert.equal(collector.calls, 2);
    });
});

describe("a search when vacancies already exist", () => {
    it("does not collect when the data is fresh", async () => {
        await m.jobs.upsertJobs([posting(1), posting(2)]);
        const collector = fakeCollector(9);

        const summary = await search();

        assert.equal(collector.calls, 0);
        assert.equal(summary.considered, 2);
        assert.equal(summary.collected, 0);
    });

    it("searches stale data straight away and refreshes it in the background", async () => {
        await m.jobs.upsertJobs([posting(1), posting(2)]);
        await m.db.getDatabase().run("UPDATE jobs SET last_seen_at = ?", [new Date(Date.now() - 3 * 864e5).toISOString()]);
        const collector = fakeCollector(9, { delayMs: 300 }); // slow: the search must not wait for it

        const started = Date.now();
        const summary = await search();

        assert.ok(Date.now() - started < 250, "did not wait for the refresh");
        assert.equal(summary.considered, 2);
        assert.equal(collector.calls, 1, "a refresh was started");
        await new Promise((resolve) => setTimeout(resolve, 400)); // let it finish so it cannot leak into the next test
    });
});

describe("staleness", () => {
    it("treats missing and old data as stale, and recent data as fresh", () => {
        const now = Date.parse("2026-10-24T12:00:00Z");
        const { isStale } = m.collection;

        assert.equal(isStale({ total: 0, lastCollectedAt: null }, now), true);
        assert.equal(isStale({ total: 5, lastCollectedAt: "2026-10-24T11:00:00Z" }, now), false);
        assert.equal(isStale({ total: 5, lastCollectedAt: "2026-10-23T23:00:00Z" }, now), true);
    });

    it("honours a configured maximum age", () => {
        process.env.COLLECTION_MAX_AGE_HOURS = "48";
        try {
            const now = Date.parse("2026-10-24T12:00:00Z");
            assert.equal(m.collection.isStale({ total: 5, lastCollectedAt: "2026-10-23T00:00:00Z" }, now), false);
        } finally {
            delete process.env.COLLECTION_MAX_AGE_HOURS;
        }
    });

    it("reads the store's status from the database", async () => {
        assert.deepEqual(await m.collection.jobStoreStatus(), { total: 0, lastCollectedAt: null });
        await m.jobs.upsertJobs([posting(1)]);
        const status = await m.collection.jobStoreStatus();
        assert.equal(status.total, 1);
        assert.ok(status.lastCollectedAt);
    });
});
