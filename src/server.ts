import "dotenv/config";
import app from "./app.js";
import { purgeExpiredSessions, purgeExpiredTokens } from "./auth/auth.service.js";
import { collectVacancies, isStale, jobStoreStatus } from "./jobs/collection.service.js";
import { enrichPending } from "./jobs/ingest.service.js";
import { closeDatabase } from "./db/database.js";
import { startMailWorker } from "./mail/worker.js";
import { runAlertCycle } from "./alerts/alert.service.js";

const port = Number(process.env.PORT ?? 4000);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(
    `API running at http://0.0.0.0:${port}`
  );
});

// Give the database connections back: a free Oracle database allows few sessions, and a restart
// (every saved file in dev) that leaves them hanging can lock the next start out for a while
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  closeDatabase().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Expired sessions and used or expired email links are useless but would pile up in the database
const purge = () =>
  Promise.all([purgeExpiredSessions(), purgeExpiredTokens()]).catch((error: unknown) =>
    console.warn("Could not clean up expired sessions:", error instanceof Error ? error.message : error)
  );
void purge();
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

// Job-alert emails: once an hour the server checks who is due (a daily or weekly digest, only when there is
// something new) and sends it. Off unless JOB_ALERTS=on; see .env.example.
if (process.env.JOB_ALERTS === "on") {
  const runAlerts = () =>
    runAlertCycle().then(
      (result) => {
        if (typeof result === "object" && (result.sent > 0 || result.baselined > 0 || result.failed > 0)) console.log("Job alerts:", result);
      },
      (error: unknown) => console.error("Job alert round failed:", error instanceof Error ? error.message : error)
    );

  if (!process.env.SYSTEM_SMTP_HOST) console.warn("JOB_ALERTS=on but SYSTEM_SMTP_HOST is not set: alert emails are only printed to the console");

  if ((process.env.ALERT_SECRET ?? "").length < 32 && (process.env.MAIL_SECRET ?? "").length < 32) {
    console.warn("JOB_ALERTS=on but neither ALERT_SECRET nor MAIL_SECRET (32+ characters) is set: the buttons in the emails cannot be signed, so no alerts are sent");
  } else {
    setTimeout(runAlerts, 2 * 60_000).unref();
    setInterval(runAlerts, 60 * 60_000).unref();
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

      if (enrichPerRun > 0) {
        for (const source of ["topjobs", "finders", "findmyjob"] as const) {
          console.log(`Adverts read (${source}):`, await enrichPending(source, enrichPerRun));
        }
      }
    } catch (error) {
      console.error("Ingest failed:", error);
    } finally {
      running = false;
    }
  };

  // Not on every start: during development the server restarts on each saved file, and re-reading every job
  // site each time would be both slow and rude. It collects at start-up only when there is nothing or it is old.
  jobStoreStatus().then(
    (status) => {
      if (isStale(status)) void run();
    },
    (error: unknown) => console.error("Could not read the vacancy store:", error instanceof Error ? error.message : error)
  );
  setInterval(run, ingestIntervalMinutes * 60_000).unref();
}
