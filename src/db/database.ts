import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DATABASE_PATH ?? "data/aluthjob.db";

let database: DatabaseSync | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    external_id   TEXT NOT NULL,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    company       TEXT,
    location      TEXT,
    description   TEXT,
    job_type      TEXT,
    salary        TEXT,
    category      TEXT,
    posted_at     TEXT,
    closing_at    TEXT,
    apply_email   TEXT,
    apply_url     TEXT,
    enriched_at   TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_jobs_closing ON jobs (closing_at);

CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user',
    created_at     TEXT NOT NULL,
    last_login_at  TEXT,
    -- set when the owner proved control of the address (verification link or password-reset link)
    email_verified_at TEXT
);

-- One-time links sent by email. Only a hash of the token is stored; a used or expired row is useless.
-- purpose: 'verify' (confirm the address) or 'reset' (choose a new password)
CREATE TABLE IF NOT EXISTS email_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    -- the address the link was sent to; a verification only counts while it is still the account's address
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, purpose);

-- Only a hash of the session token is stored, so a copy of the database cannot be used to sign in
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS candidates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- the account that owns this resume; deleting the account deletes everything below it
    user_id        INTEGER REFERENCES users (id) ON DELETE CASCADE,
    resume_hash    TEXT NOT NULL UNIQUE,
    file_name      TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    -- the original upload, attached to applications later
    file_data      BLOB NOT NULL,
    profile_json   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

-- One row per (candidate, job) suggestion. status: suggested -> approved | rejected
CREATE TABLE IF NOT EXISTS matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    INTEGER NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
    job_id          INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    score           INTEGER NOT NULL,
    details_json    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'suggested',
    subject         TEXT,
    cover_letter    TEXT,
    drafted_at      TEXT,
    decided_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (candidate_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_candidate_score ON matches (candidate_id, score DESC);

-- The applicant's own SMTP mailbox. The password is AES-256-GCM encrypted, never stored in clear.
CREATE TABLE IF NOT EXISTS mail_accounts (
    candidate_id  INTEGER PRIMARY KEY REFERENCES candidates (id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    from_name     TEXT,
    host          TEXT NOT NULL,
    port          INTEGER NOT NULL,
    secure        INTEGER NOT NULL,
    username      TEXT NOT NULL,
    password_enc  TEXT NOT NULL,
    verified_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- Send queue and audit trail: one application per approved match.
-- status: queued -> sending -> sent | failed ; queued -> cancelled
CREATE TABLE IF NOT EXISTS applications (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id         INTEGER NOT NULL UNIQUE REFERENCES matches (id) ON DELETE CASCADE,
    candidate_id     INTEGER NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
    to_email         TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT NOT NULL,
    error            TEXT,
    message_id       TEXT,
    -- exactly what was sent, kept for the audit trail
    sent_subject     TEXT,
    sent_body        TEXT,
    queued_at        TEXT NOT NULL,
    sent_at          TEXT,
    updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_queue ON applications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications (candidate_id, sent_at);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves existing tables alone,
// so databases created by older versions get these added on start-up.
const ADDED_COLUMNS: { table: string; column: string; definition: string; /** runs once, right after the column is added */ afterAdd?: string }[] = [
    // where apply_email came from: 'page' (written in the ad's text or a mailto link) or 'image' (read by OCR)
    { table: "jobs", column: "apply_email_source", definition: "TEXT" },
    // the address the user confirmed after checking it against the original ad image
    { table: "matches", column: "confirmed_email", definition: "TEXT" },
    // failed attempts to read the detail page; after a few the job is left alone
    { table: "jobs", column: "enrich_failures", definition: "INTEGER NOT NULL DEFAULT 0" },
    // owner of the resume; rows from before accounts existed stay NULL and belong to nobody until assigned
    { table: "candidates", column: "user_id", definition: "INTEGER REFERENCES users (id) ON DELETE CASCADE" },
    // Accounts that exist when verification is introduced could never have been verified; treating them as
    // verified (once, here) keeps their owners from being locked out of data they already have.
    { table: "users", column: "email_verified_at", definition: "TEXT", afterAdd: "UPDATE users SET email_verified_at = created_at" },
];

export function migrate(db: DatabaseSync) {
    for (const { table, column, definition, afterAdd } of ADDED_COLUMNS) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
        if (!columns.some((existing) => existing.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            if (afterAdd) db.exec(afterAdd);
        }
    }

    // after the loop: on an older database the column only exists from here on
    db.exec("CREATE INDEX IF NOT EXISTS idx_candidates_user ON candidates (user_id)");
}

export function getDatabase(): DatabaseSync {
    if (!database) {
        if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });

        database = new DatabaseSync(DB_PATH);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA foreign_keys = ON");
        database.exec(SCHEMA);
        migrate(database);
    }

    return database;
}
