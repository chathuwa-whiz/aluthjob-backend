import { getJob, listUnenriched, recordEnrichmentFailure, saveEnrichment, upsertJobs } from "./job.repository.js";
import { sourceIds, sources } from "./sources/index.js";
import type { JobSourceId } from "./types.js";
import { SingleFlight, WorkBudget } from "../security/work-budget.js";

const enrichments = new SingleFlight<Awaited<ReturnType<typeof getJob>>>();
const enrichmentBudget = new WorkBudget(4, "Reading adverts");

export interface IngestResult {
    source: JobSourceId;
    fetched: number;
    inserted: number;
    updated: number;
    error?: string;
}

const DEFAULT_MAX_PAGES = Number(process.env.INGEST_MAX_PAGES ?? 3);

/** What a job site is doing right now, for showing progress. */
export interface SiteEvent {
    source: JobSourceId;
    state: "reading" | "done" | "failed";
    /** Vacancies found so far (while reading) or in total (when done). */
    fetched: number;
    error?: string;
}

/** One failing site must never stop the others, so errors are reported per source. */
export async function ingestSource(id: JobSourceId, maxPages = DEFAULT_MAX_PAGES, report?: (event: SiteEvent) => void): Promise<IngestResult> {
    report?.({ source: id, state: "reading", fetched: 0 });

    try {
        const jobs = await sources[id].fetchListings({ maxPages, onProgress: (found) => report?.({ source: id, state: "reading", fetched: found }) });
        const { inserted, updated } = await upsertJobs(jobs);

        report?.({ source: id, state: "done", fetched: jobs.length });
        return { source: id, fetched: jobs.length, inserted, updated };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        report?.({ source: id, state: "failed", fetched: 0, error: message });
        return { source: id, fetched: 0, inserted: 0, updated: 0, error: message };
    }
}

export async function ingestAll(ids: JobSourceId[] = sourceIds, maxPages = DEFAULT_MAX_PAGES, report?: (event: SiteEvent) => void): Promise<IngestResult[]> {
    // Sources are different hosts, so they can be walked in parallel; each host is throttled separately
    return Promise.all(ids.map((id) => ingestSource(id, maxPages, report)));
}

/** Loads the detail page of one stored vacancy (description, apply email) if not done yet. */
export async function enrichJob(id: number) {
    return enrichments.run(id, () => enrichmentBudget.run(() => loadEnrichedJob(id)));
}

async function loadEnrichedJob(id: number) {
    const job = await getJob(id);
    if (!job) return undefined;

    const source = sources[job.source];
    if (!source.enrich || job.enrichedAt) return job;

    await saveEnrichment(id, await source.enrich(job));
    return getJob(id);
}

export interface EnrichBatchResult {
    source: JobSourceId;
    attempted: number;
    enriched: number;
    failed: number;
}

/**
 * Reads the detail pages (and, for picture adverts, runs OCR) of vacancies not read yet. Listings of
 * some sources are only teasers, so until this has run their jobs score low and are never offered.
 * Sequential on purpose: OCR is CPU heavy and the sites are throttled anyway.
 */
export async function enrichPending(id: JobSourceId, limit: number): Promise<EnrichBatchResult> {
    const result: EnrichBatchResult = { source: id, attempted: 0, enriched: 0, failed: 0 };
    const source = sources[id];
    if (!source.enrich) return result;

    for (const job of await listUnenriched(id, limit)) {
        result.attempted++;

        try {
            await enrichJob(job.id);
            result.enriched++;
        } catch (error) {
            await recordEnrichmentFailure(job.id).catch(() => {});
            result.failed++;
            console.warn(`Could not read advert ${job.id} (${id}):`, error instanceof Error ? error.message : error);
        }
    }

    return result;
}
