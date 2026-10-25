import { allowedOrigins } from "../auth/origins.js";
import { getDatabase } from "../db/database.js";
import { RuleError } from "../errors.js";
import { collectionStatus } from "../jobs/collection.service.js";
import { enrichPending, type EnrichBatchResult } from "../jobs/ingest.service.js";
import { sourceIds } from "../jobs/sources/index.js";
import type { JobSourceId } from "../jobs/types.js";
import { mailWorkerStatus } from "../mail/worker.js";
import { systemMailAvailable } from "../mail/system-mailer.js";
import { llmStatus } from "../services/llm.client.js";
import { queueDepth } from "./admin.repository.js";

// Long-running work started from the console runs in the background; the screens poll these snapshots.

// ---- reading adverts in bulk -----------------------------------------------------------

export interface EnrichmentStatus {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    sources: JobSourceId[];
    limit: number;
    results: EnrichBatchResult[];
    error: string | null;
}

let enrichment: EnrichmentStatus = { running: false, startedAt: null, finishedAt: null, sources: [], limit: 0, results: [], error: null };

export const enrichmentStatus = (): EnrichmentStatus => ({ ...enrichment, results: [...enrichment.results] });

/**
 * Reads the full advert (and runs OCR on picture adverts) of vacancies that only have a teaser. Sequential on
 * purpose, like the scheduled run: OCR is CPU heavy and the job sites are throttled anyway.
 */
export function startEnrichment(sources: JobSourceId[], limit: number): EnrichmentStatus {
    if (enrichment.running) throw new RuleError("Reading adverts is already running");

    const run: EnrichmentStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null, sources, limit, results: [], error: null };
    enrichment = run;

    void (async () => {
        try {
            for (const source of sources) run.results.push(await enrichPending(source, limit));
        } catch (error) {
            run.error = error instanceof Error ? error.message : String(error);
        } finally {
            run.running = false;
            run.finishedAt = new Date().toISOString();
        }
    })();

    return enrichmentStatus();
}

// ---- the whole system at a glance ------------------------------------------------------

const flag = (name: string) => Boolean(process.env[name]);

/**
 * What this server is running with. Settings come from the environment and need a restart to change, so this
 * is read-only. It reports whether secrets are set, never their values.
 */
export async function systemInfo() {
    const started = Date.now();
    let database: { ok: boolean; latencyMs: number | null; error: string | null };
    try {
        await getDatabase().get("SELECT 1 AS ok FROM dual");
        database = { ok: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
        database = { ok: false, latencyMs: null, error: (error instanceof Error ? error.message : String(error)).split("\n")[0]! };
    }

    const memory = process.memoryUsage();
    const queue = database.ok ? await queueDepth().catch(() => null) : null;

    return {
        server: {
            node: process.version,
            environment: process.env.NODE_ENV ?? "development",
            uptimeSeconds: Math.round(process.uptime()),
            memoryMb: Math.round(memory.rss / 1024 / 1024),
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        },
        database,
        model: llmStatus(),
        mail: {
            systemMailReady: systemMailAvailable(),
            systemSmtpConfigured: flag("SYSTEM_SMTP_HOST"),
            applicationSecretSet: (process.env.MAIL_SECRET ?? "").length >= 32,
            worker: { enabled: process.env.MAIL_WORKER !== "off", ...mailWorkerStatus() },
            dailyLimit: Number(process.env.MAIL_DAILY_LIMIT ?? 20),
            sendGapSeconds: Number(process.env.MAIL_SEND_GAP_SECONDS ?? 60),
            queue,
        },
        collection: {
            ...collectionStatus(),
            sources: sourceIds,
            intervalMinutes: Number(process.env.INGEST_INTERVAL_MINUTES ?? 360),
            maxAgeHours: Number(process.env.COLLECTION_MAX_AGE_HOURS ?? 12),
            maxPages: Number(process.env.INGEST_MAX_PAGES ?? 3),
            enrichPerRun: Number(process.env.ENRICH_PER_RUN ?? 40),
            enrichment: enrichmentStatus(),
        },
        ocr: {
            languages: process.env.OCR_LANGUAGES ?? "eng",
            minEmailConfidence: Number(process.env.OCR_MIN_EMAIL_CONFIDENCE ?? 40),
        },
        security: {
            allowedOrigins: allowedOrigins(),
            cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
            trustProxy: process.env.TRUST_PROXY ?? null,
            sessionDays: Number(process.env.SESSION_DAYS ?? 30),
        },
    };
}
