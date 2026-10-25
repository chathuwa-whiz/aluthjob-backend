import "dotenv/config";
import { ingestAll } from "../jobs/ingest.service.js";
import { countJobsBySource } from "../jobs/job.repository.js";
import { sourceIds } from "../jobs/sources/index.js";
import type { JobSourceId } from "../jobs/types.js";

// usage: npm run ingest [-- source1 source2 ...] [--pages=N]
const args = process.argv.slice(2);
const pages = Number(args.find((arg) => arg.startsWith("--pages="))?.split("=")[1] ?? 0) || undefined;
const requested = args.filter((arg) => !arg.startsWith("--")) as JobSourceId[];
const unknown = requested.filter((id) => !sourceIds.includes(id));

if (unknown.length) {
    console.error(`Unknown source(s): ${unknown.join(", ")}. Available: ${sourceIds.join(", ")}`);
    process.exit(1);
}

async function main() {
    const results = await ingestAll(requested.length ? requested : sourceIds, pages);

    console.table(results);
    console.log("Stored per source:", await countJobsBySource());
    process.exit(results.every((result) => result.error) ? 1 : 0);
}

main();
