import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { clearDatabase } from "../db/test-helpers.js";
import { countJobsBySource, getJob, getJobsByIds, listJobs, listUnenriched, recordEnrichmentFailure, saveEnrichment, upsertJobs } from "./job.repository.js";
import type { JobPosting } from "./types.js";

const posting = (n: number, overrides: Partial<JobPosting> = {}): JobPosting => ({
    source: "xpress", externalId: `job-${n}`, url: `https://example.test/${n}`, title: `Engineer ${n}`, company: "Acme", location: "Colombo",
    description: null, jobType: null, salary: null, category: null, postedAt: null, closingAt: null, applyEmail: null, applyUrl: null, ...overrides,
});

beforeEach(clearDatabase);

describe("upserting vacancies", () => {
    it("counts what is new and what was already known", async () => {
        assert.deepEqual(await upsertJobs([posting(1), posting(2)]), { inserted: 2, updated: 0 });
        assert.deepEqual(await upsertJobs([posting(2), posting(3)]), { inserted: 1, updated: 1 });
        assert.deepEqual(await countJobsBySource(), { xpress: 3 });
    });

    it("copes with the same vacancy twice in one batch", async () => {
        const result = await upsertJobs([posting(1), posting(1, { title: "Renamed" })]);

        assert.deepEqual(result, { inserted: 1, updated: 1 });
        assert.equal((await listJobs())[0]!.title, "Renamed");
    });

    it("keeps what an earlier visit found when a listing leaves it out", async () => {
        await upsertJobs([posting(1, { company: "Acme", description: "Full description", applyEmail: "hr@acme.lk", salary: "100k" })]);
        await upsertJobs([posting(1, { company: null, description: null, applyEmail: null, salary: null, title: "New title" })]);

        const job = (await listJobs())[0]!;
        assert.equal(job.title, "New title");
        assert.equal(job.company, "Acme");
        assert.equal(job.description, "Full description");
        assert.equal(job.applyEmail, "hr@acme.lk");
        assert.equal(job.salary, "100k");
    });

    it("does not overwrite a description read from the detail page with a teaser", async () => {
        await upsertJobs([posting(1, { description: "teaser" })]);
        const id = (await listJobs())[0]!.id;
        await saveEnrichment(id, posting(1, { description: "The full advert text" }));

        await upsertJobs([posting(1, { description: "teaser again" })]);

        const job = (await getJob(id))!;
        assert.equal(job.description, "The full advert text");
        assert.ok(job.enrichedAt);
    });

    it("stores long descriptions and cuts fields that are longer than their column", async () => {
        const description = "word ".repeat(20_000);
        await upsertJobs([posting(1, { description, title: "T".repeat(5000), company: "C".repeat(5000) })]);

        const job = (await listJobs())[0]!;
        assert.equal(job.description, description);
        assert.equal(job.title.length, 1000);
        assert.equal(job.company!.length, 1000);
    });

    it("remembers that an address was read from a picture", async () => {
        await upsertJobs([posting(1, { applyEmail: "hr@acme.lk", applyEmailSource: "image" }), posting(2, { applyEmail: "hr@beta.lk" })]);

        const [one, two] = [(await listJobs({ search: "Engineer 1" }))[0]!, (await listJobs({ search: "Engineer 2" }))[0]!];
        assert.equal(one.applyEmailSource, "image");
        assert.equal(two.applyEmailSource, "page");
    });
});

describe("listing vacancies", () => {
    it("searches title, company and description without regard to case", async () => {
        await upsertJobs([
            posting(1, { title: "Senior Accountant", company: "Zeta" }),
            posting(2, { title: "Driver", company: "Acme Logistics" }),
            posting(3, { title: "Clerk", company: "Zeta", description: "Handles PAYROLL queries" }),
        ]);

        assert.deepEqual((await listJobs({ search: "accountant" })).map((job) => job.title), ["Senior Accountant"]);
        assert.deepEqual((await listJobs({ search: "ACME" })).map((job) => job.title), ["Driver"]);
        assert.deepEqual((await listJobs({ search: "payroll" })).map((job) => job.title), ["Clerk"]);
    });

    it("filters open vacancies and vacancies with an employer email", async () => {
        await upsertJobs([
            posting(1, { closingAt: "2020-01-01T00:00:00.000Z" }),
            posting(2, { closingAt: "2999-01-01T00:00:00.000Z", applyEmail: "hr@acme.lk" }),
            posting(3),
        ]);

        assert.deepEqual((await listJobs({ openOnly: true })).map((job) => job.externalId).sort(), ["job-2", "job-3"]);
        assert.deepEqual((await listJobs({ hasEmail: true })).map((job) => job.externalId), ["job-2"]);
    });

    it("pages through the results", async () => {
        await upsertJobs([1, 2, 3, 4, 5].map((n) => posting(n)));

        assert.equal((await listJobs({ limit: 2 })).length, 2);
        assert.equal((await listJobs({ limit: 2, offset: 4 })).length, 1);
    });

    it("loads many vacancies by id in one go", async () => {
        await upsertJobs([1, 2, 3].map((n) => posting(n)));
        const ids = (await listJobs()).map((job) => job.id);

        const found = await getJobsByIds([...ids, 999_999]);
        assert.equal(found.size, 3);
        assert.equal(found.has(999_999), false);
    });
});

describe("reading adverts", () => {
    it("offers open, unread vacancies of a source and gives up after repeated failures", async () => {
        await upsertJobs([posting(1), posting(2, { closingAt: "2020-01-01T00:00:00.000Z" }), posting(3)]);
        const ids = (await listJobs()).map((job) => job.id);

        assert.deepEqual((await listUnenriched("xpress", 10)).map((job) => job.externalId).sort(), ["job-1", "job-3"]);
        assert.equal((await listUnenriched("xpress", 1)).length, 1);

        const target = (await listUnenriched("xpress", 10))[0]!;
        for (let i = 0; i < 3; i++) await recordEnrichmentFailure(target.id);
        assert.ok(!(await listUnenriched("xpress", 10)).some((job) => job.id === target.id));

        await saveEnrichment(ids.find((id) => id !== target.id && true)!, posting(9, { description: "read" }));
        assert.ok((await listUnenriched("xpress", 10)).length <= 1);
    });
});
