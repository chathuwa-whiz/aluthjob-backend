import { getDatabase } from "../db/database.js";
import { RuleError } from "../errors.js";
import { ingestAll, type IngestResult, type SiteEvent } from "./ingest.service.js";

export interface StoreStatus {
    total: number;
    /** When any vacancy was last seen on its site, i.e. roughly when collection last worked. */
    lastCollectedAt: string | null;
}

export async function jobStoreStatus(): Promise<StoreStatus> {
    const row = (await getDatabase().get<{ total: number; latest: string | null }>("SELECT COUNT(*) AS total, MAX(last_seen_at) AS latest FROM jobs"))!;
    return { total: row.total, lastCollectedAt: row.latest };
}

/** Vacancies older than this are refreshed in the background before the next search. */
const maxAgeMs = () => Number(process.env.COLLECTION_MAX_AGE_HOURS ?? 12) * 3_600_000;

export function isStale(status: StoreStatus, now = Date.now()): boolean {
    return !status.lastCollectedAt || now - new Date(status.lastCollectedAt).getTime() > maxAgeMs();
}

// ---- collecting, one run at a time -----------------------------------------------------

type SiteListener = (event: SiteEvent) => void;
type Collector = (report: SiteListener) => Promise<IngestResult[]>;

const realCollector: Collector = (report) => ingestAll(undefined, undefined, report);
let collector: Collector = realCollector;
/** For tests: replaces the real job-site collector. Pass nothing to restore it. */
export const setCollector = (replacement?: Collector) => {
    collector = replacement ?? realCollector;
};

let inflight: Promise<IngestResult[]> | undefined;
/** What each site is doing in the collection that is running now, so a searcher that joins late sees the whole picture. */
const sites = new Map<string, SiteEvent>();
const listeners = new Set<SiteListener>();

function publish(event: SiteEvent) {
    sites.set(event.source, event);
    for (const listener of listeners) listener(event);
}

/**
 * Collects vacancies from every job site. Only one collection runs at a time: a search that needs fresh
 * data while the scheduler is already collecting simply waits for that run, instead of hitting every site twice.
 */
export function collectVacancies(): Promise<IngestResult[]> {
    if (!inflight) {
        sites.clear();
        inflight = collector(publish).finally(() => {
            inflight = undefined;
        });
    }
    return inflight;
}

/** Follows the running collection: replays what each site is doing now, then every change. Returns a function that stops following. */
export function followCollection(listener: SiteListener): () => void {
    for (const event of sites.values()) listener(event);
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export interface CollectionReport {
    /** Vacancies gathered by a collection this call waited for (0 when none was needed). */
    collected: number;
    /** Job sites that could not be read during that collection. */
    sourcesFailed: number;
}

/**
 * Makes sure there is something to search before matching starts.
 *
 * - No vacancies at all (a fresh install): collect now and wait. Searching an empty store and calling it
 *   "finished" would tell the person nothing about what went wrong.
 * - Vacancies exist but are old: search what is there right away and refresh in the background.
 */
export async function ensureVacancies(onSite?: SiteListener): Promise<CollectionReport> {
    const status = await jobStoreStatus();

    if (status.total > 0) {
        if (isStale(status)) {
            collectVacancies().catch((error: unknown) => console.warn("Background collection failed:", error instanceof Error ? error.message : error));
        }
        return { collected: 0, sourcesFailed: 0 };
    }

    const collecting = collectVacancies();
    const unfollow = onSite ? followCollection(onSite) : undefined;
    let results: IngestResult[];
    try {
        results = await collecting;
    } finally {
        unfollow?.();
    }
    const report = {
        collected: results.reduce((sum, result) => sum + result.fetched, 0),
        sourcesFailed: results.filter((result) => result.error).length,
    };

    if ((await jobStoreStatus()).total === 0) {
        const reasons = [...new Set(results.flatMap((result) => (result.error ? [result.error] : [])))].slice(0, 2).join("; ");
        throw new RuleError(
            `We could not collect any vacancies from the job sites just now${reasons ? ` (${reasons})` : ""}. ` +
                "Check that this server can reach the internet, then try again.",
        );
    }

    return report;
}
