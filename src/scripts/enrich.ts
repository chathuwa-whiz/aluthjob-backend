import "dotenv/config";
import { enrichPending } from "../jobs/ingest.service.js";
import { countJobsBySource } from "../jobs/job.repository.js";
import { shutdownOcr } from "../ocr/ocr.service.js";
import { sourceIds } from "../jobs/sources/index.js";
import type { JobSourceId } from "../jobs/types.js";

// usage: npm run enrich -- [source ...] [--limit=N]   (default: topjobs, 50)
const args = process.argv.slice(2);
const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 50);
const requested = args.filter((arg) => !arg.startsWith("--")) as JobSourceId[];
const targets = requested.length ? requested : (["topjobs"] as JobSourceId[]);
const unknown = targets.filter((id) => !sourceIds.includes(id));

if (unknown.length) {
    console.error(`Unknown source(s): ${unknown.join(", ")}. Available: ${sourceIds.join(", ")}`);
    process.exit(1);
}

async function main() {
    for (const id of targets) {
        console.log(`Reading adverts of ${id} (up to ${limit}); picture adverts take a few seconds each...`);
        console.log(await enrichPending(id, limit));
    }

    console.log("Stored per source:", countJobsBySource());
    await shutdownOcr();
}

main().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
});
