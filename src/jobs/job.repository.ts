import { getDatabase, isUniqueViolation, type Db } from "../db/database.js";
import type { JobPosting, JobSourceId } from "./types.js";

export interface StoredJob extends JobPosting {
    id: number;
    enrichedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
}

interface JobRow {
    id: number;
    source: JobSourceId;
    external_id: string;
    url: string;
    title: string;
    company: string | null;
    location: string | null;
    description: string | null;
    job_type: string | null;
    salary: string | null;
    category: string | null;
    posted_at: string | null;
    closing_at: string | null;
    apply_email: string | null;
    apply_url: string | null;
    apply_email_source: "page" | "image" | null;
    enriched_at: string | null;
    first_seen_at: string;
    last_seen_at: string;
}

const toStoredJob = (row: JobRow): StoredJob => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    jobType: row.job_type,
    salary: row.salary,
    category: row.category,
    postedAt: row.posted_at,
    closingAt: row.closing_at,
    applyEmail: row.apply_email,
    applyUrl: row.apply_url,
    applyEmailSource: row.apply_email ? (row.apply_email_source ?? "page") : null,
    enrichedAt: row.enriched_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
});

/** The listing sites are not under our control; a value longer than its column must not fail a whole collection. */
const fit = (value: string | null | undefined, max: number) => (value == null ? null : value.slice(0, max));

/** Bind values for a job, trimmed to the column sizes. */
function jobBinds(job: JobPosting, now: string) {
    return {
        source: job.source,
        externalId: fit(job.externalId, 400),
        url: fit(job.url, 2000),
        title: fit(job.title, 1000) || "(untitled)",
        company: fit(job.company, 1000),
        location: fit(job.location, 1000),
        description: job.description,
        jobType: fit(job.jobType, 200),
        salary: fit(job.salary, 500),
        category: fit(job.category, 500),
        postedAt: fit(job.postedAt, 40),
        closingAt: fit(job.closingAt, 40),
        applyEmail: fit(job.applyEmail, 320),
        applyEmailSource: job.applyEmail ? (job.applyEmailSource ?? "page") : null,
        applyUrl: fit(job.applyUrl, 2000),
        now,
    };
}

const UPDATE_KNOWN = `
    UPDATE jobs SET
        url         = :url,
        title       = :title,
        company     = COALESCE(:company, company),
        location    = COALESCE(:location, location),
        description = CASE WHEN enriched_at IS NULL THEN COALESCE(TO_CLOB(:description), description) ELSE description END,
        job_type    = COALESCE(:jobType, job_type),
        salary      = COALESCE(:salary, salary),
        category    = COALESCE(:category, category),
        posted_at   = COALESCE(:postedAt, posted_at),
        closing_at  = COALESCE(:closingAt, closing_at),
        apply_email = COALESCE(:applyEmail, apply_email),
        apply_email_source = CASE WHEN :applyEmail IS NOT NULL THEN :applyEmailSource ELSE apply_email_source END,
        apply_url   = COALESCE(:applyUrl, apply_url),
        last_seen_at = :now
    WHERE source = :source AND external_id = :externalId
`;

const INSERT_NEW = `
    INSERT INTO jobs (source, external_id, url, title, company, location, description, job_type, salary,
                      category, posted_at, closing_at, apply_email, apply_email_source, apply_url, first_seen_at, last_seen_at)
    VALUES (:source, :externalId, :url, :title, :company, :location, :description, :jobType, :salary,
            :category, :postedAt, :closingAt, :applyEmail, :applyEmailSource, :applyUrl, :now, :now)
`;

/** Oracle accepts at most 1000 items in an IN list. */
const CHUNK = 500;
const chunks = <T>(items: T[], size = CHUNK): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function knownExternalIds(db: Db, jobs: JobPosting[]): Promise<Set<string>> {
    const known = new Set<string>();

    for (const source of new Set(jobs.map((job) => job.source))) {
        const ids = jobs.filter((job) => job.source === source).map((job) => fit(job.externalId, 400)!);

        for (const part of chunks(ids)) {
            const rows = await db.all<{ external_id: string }>(`SELECT external_id FROM jobs WHERE source = ? AND external_id IN (${part.map(() => "?").join(",")})`, [source, ...part]);
            for (const row of rows) known.add(`${source}\u0000${row.external_id}`);
        }
    }

    return known;
}

/**
 * Inserts new vacancies and refreshes the ones already known. Columns that a listing
 * does not provide (description, apply email) are kept from an earlier detail fetch.
 */
export async function upsertJobs(jobs: JobPosting[]): Promise<{ inserted: number; updated: number }> {
    if (jobs.length === 0) return { inserted: 0, updated: 0 };

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;

    await getDatabase().transaction(async (tx) => {
        const known = await knownExternalIds(tx, jobs);

        for (const job of jobs) {
            const binds = jobBinds(job, now);
            const exists = known.has(`${binds.source}\u0000${binds.externalId}`);

            if (!exists) {
                try {
                    await tx.run(INSERT_NEW, binds);
                    known.add(`${binds.source}\u0000${binds.externalId}`);
                    inserted++;
                    continue;
                } catch (error) {
                    // the same vacancy appearing twice in one batch, or another collection got there first
                    if (!isUniqueViolation(error)) throw error;
                }
            }

            await tx.run(UPDATE_KNOWN, binds);
            updated++;
        }
    });

    return { inserted, updated };
}

export async function saveEnrichment(id: number, job: JobPosting): Promise<void> {
    await getDatabase().run(
        `UPDATE jobs SET description = :description, apply_email = COALESCE(:applyEmail, apply_email),
                         apply_email_source = CASE WHEN :applyEmail IS NOT NULL THEN :applyEmailSource ELSE apply_email_source END,
                         company = COALESCE(:company, company), location = COALESCE(:location, location),
                         posted_at = COALESCE(:postedAt, posted_at), closing_at = COALESCE(:closingAt, closing_at),
                         enriched_at = :now
         WHERE id = :id`,
        {
            id,
            description: job.description,
            applyEmail: fit(job.applyEmail, 320),
            applyEmailSource: job.applyEmail ? (job.applyEmailSource ?? "page") : null,
            company: fit(job.company, 1000),
            location: fit(job.location, 1000),
            postedAt: fit(job.postedAt, 40),
            closingAt: fit(job.closingAt, 40),
            now: new Date().toISOString(),
        },
    );
}

const MAX_ENRICH_FAILURES = 3;

export async function recordEnrichmentFailure(id: number): Promise<void> {
    await getDatabase().run("UPDATE jobs SET enrich_failures = enrich_failures + 1 WHERE id = ?", [id]);
}

/** Open vacancies of a source whose detail page has not been read yet, newest first. */
export async function listUnenriched(source: JobSourceId, limit: number): Promise<StoredJob[]> {
    const rows = await getDatabase().all<JobRow>(
        `SELECT * FROM jobs
         WHERE source = :source AND enriched_at IS NULL AND enrich_failures < :maxFailures AND (closing_at IS NULL OR closing_at >= :today)
         ORDER BY first_seen_at DESC, id DESC FETCH FIRST :lim ROWS ONLY`,
        { source, today: new Date().toISOString(), lim: limit, maxFailures: MAX_ENRICH_FAILURES },
    );

    return rows.map(toStoredJob);
}

export async function getJob(id: number): Promise<StoredJob | undefined> {
    const row = await getDatabase().get<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
    return row && toStoredJob(row);
}

/** Several vacancies in one round trip, keyed by id. Ids that no longer exist are simply absent. */
export async function getJobsByIds(ids: number[]): Promise<Map<number, StoredJob>> {
    const jobs = new Map<number, StoredJob>();

    for (const part of chunks([...new Set(ids)])) {
        const rows = await getDatabase().all<JobRow>(`SELECT * FROM jobs WHERE id IN (${part.map(() => "?").join(",")})`, part);
        for (const row of rows) jobs.set(row.id, toStoredJob(row));
    }

    return jobs;
}

export interface JobFilter {
    source?: JobSourceId;
    search?: string;
    hasEmail?: boolean;
    openOnly?: boolean;
    /** ISO timestamp; skips vacancies that have vanished from their site since then. */
    seenSince?: string;
    limit?: number;
    offset?: number;
}

export async function listJobs(filter: JobFilter = {}): Promise<StoredJob[]> {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (filter.source) {
        where.push("source = :source");
        params.source = filter.source;
    }
    if (filter.search) {
        // Oracle's LIKE is case-sensitive
        where.push("(LOWER(title) LIKE :search OR LOWER(company) LIKE :search OR LOWER(description) LIKE :search)");
        params.search = `%${filter.search.toLowerCase()}%`;
    }
    if (filter.hasEmail) where.push("apply_email IS NOT NULL");
    if (filter.seenSince) {
        where.push("last_seen_at >= :seenSince");
        params.seenSince = filter.seenSince;
    }
    if (filter.openOnly) {
        where.push("(closing_at IS NULL OR closing_at >= :today)");
        params.today = new Date().toISOString();
    }

    const sql = `
        SELECT * FROM jobs
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(posted_at, first_seen_at) DESC, id DESC
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY
    `;

    const rows = await getDatabase().all<JobRow>(sql, { ...params, lim: filter.limit ?? 50, off: filter.offset ?? 0 });
    return rows.map(toStoredJob);
}

export async function countJobsBySource(): Promise<Record<string, number>> {
    const rows = await getDatabase().all<{ source: string; n: number }>("SELECT source, COUNT(*) AS n FROM jobs GROUP BY source");
    return Object.fromEntries(rows.map((row) => [row.source, row.n]));
}
