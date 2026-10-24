import "dotenv/config";
import app from "./app.js";
import { purgeExpiredSessions, purgeExpiredTokens } from "./auth/auth.service.js";
import { collectVacancies, isStale, jobStoreStatus } from "./jobs/collection.service.js";
import { enrichPending } from "./jobs/ingest.service.js";
import { startMailWorker } from "./mail/worker.js";

const port = Number(process.env.PORT ?? 4000);

app.listen(port, "127.0.0.1", () => {
  console.log(
    `API running at http://127.0.0.1:${port}`
  );
});

// Expired sessions and used or expired email links are useless but would pile up in the database
const purge = () => {
  purgeExpiredSessions();
  purgeExpiredTokens();
};
purge();
setInterval(purge, 60 * 60_000).unref();

if (process.env.NODE_ENV === "production") {
  if (!process.env.COOKIE_SECURE && !process.env.FRONTEND_URL?.startsWith("https://")) {
    console.warn("NODE_ENV=production but FRONTEND_URL is not https: session cookies are marked Secure and will not be sent over plain http");
  }
  if (!process.env.SYSTEM_SMTP_HOST) {
    console.warn("SYSTEM_SMTP_HOST is not set: in production nobody can register or reset a password, because confirmation and reset emails cannot be sent");
  }
  if (!process.env.TRUST_PROXY) {
    console.warn("TRUST_PROXY is not set. Behind nginx/Caddy set TRUST_PROXY=1, otherwise every visitor shares one address and one rate limit");
  }
}

// Sends queued applications. Needs MAIL_SECRET (mailbox passwords are encrypted with it); set MAIL_WORKER=off to disable
if (process.env.MAIL_WORKER !== "off") {
  if ((process.env.MAIL_SECRET ?? "").length >= 32) {
    startMailWorker();
  } else {
    console.warn("Mail worker not started: set MAIL_SECRET (32+ characters) to enable sending applications");
  }
}

// Periodic job collection, every 6 hours unless INGEST_INTERVAL_MINUTES says otherwise (0 turns it off; then
// vacancies only arrive through `npm run ingest`, or on a person's first search when there are none).
const ingestIntervalMinutes = Number(process.env.INGEST_INTERVAL_MINUTES ?? 360);

if (ingestIntervalMinutes > 0) {
  // After collecting, read the full adverts of vacancies that only have a teaser so far (TopJobs adverts are
  // pictures read with OCR, a few seconds each). The backlog shrinks by this many per run; 0 turns it off.
  const enrichPerRun = Number(process.env.ENRICH_PER_RUN ?? 40);
  let running = false;

  const run = async () => {
    if (running) return; // a slow run must never overlap the next one
    running = true;

    try {
      const results = await collectVacancies();
      console.log("Ingest finished:", results.map((r) => `${r.source}=${r.fetched}${r.error ? " (failed)" : ""}`).join(" "));

      if (enrichPerRun > 0) console.log("Adverts read:", await enrichPending("topjobs", enrichPerRun));
    } catch (error) {
      console.error("Ingest failed:", error);
    } finally {
      running = false;
    }
  };

  // Not on every start: during development the server restarts on each saved file, and re-reading every job
  // site each time would be both slow and rude. It collects at start-up only when there is nothing or it is old.
  if (isStale(jobStoreStatus())) void run();
  setInterval(run, ingestIntervalMinutes * 60_000).unref();
}
