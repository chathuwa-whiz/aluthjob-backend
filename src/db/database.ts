import oracledb from "oracledb";

// CLOBs and BLOBs arrive as plain strings and Buffers, the way the rest of the code expects them
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

/**
 * Oracle Autonomous Database. The driver runs in "thin" mode (pure JavaScript, nothing to install).
 * ORACLE_CONNECT_STRING is the TLS connection string of the database; with "Require mutual TLS" switched
 * off in the Oracle console no wallet is needed.
 */
const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set. See .env.example for the Oracle database settings.`);
    return value;
};

type Binds = readonly unknown[] | Record<string, unknown>;
type Row = Record<string, unknown>;

/** Oracle has no `?` placeholders and no `undefined`; named binds that the statement does not use are an error. */
function prepare(sql: string, binds: Binds): { sql: string; binds: Record<string, unknown> } {
    const clean = (value: unknown) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value);

    if (Array.isArray(binds)) {
        let index = 0;
        const named: Record<string, unknown> = {};
        const text = sql.replace(/\?/g, () => {
            const name = `p${++index}`;
            named[name] = clean(binds[index - 1]);
            return `:${name}`;
        });
        if (index !== binds.length) throw new Error(`Statement has ${index} placeholders but ${binds.length} values were given`);
        return { sql: text, binds: named };
    }

    const used = new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]!));
    const named: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(binds)) if (used.has(name)) named[name] = clean(value);
    return { sql, binds: named };
}

/** Oracle returns column names in capitals; the code reads them as written in the schema. */
const lowerKeys = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));

export interface Db {
    all<T = Row>(sql: string, binds?: Binds): Promise<T[]>;
    get<T = Row>(sql: string, binds?: Binds): Promise<T | undefined>;
    /** INSERT/UPDATE/DELETE; `changes` is the number of rows touched. */
    run(sql: string, binds?: Binds): Promise<{ changes: number }>;
    /** INSERT that returns the new row's generated id. */
    insert(sql: string, binds?: Binds, idColumn?: string): Promise<number>;
    /** UPDATE ... RETURNING: the listed columns of the (single) updated row, or undefined when no row matched. */
    update<T>(sql: string, binds: Binds, returning: Record<string, "string" | "number">): Promise<T | undefined>;
    /** Runs `work` on one connection and commits when it finishes, or rolls back when it throws. */
    transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}

class Executor implements Db {
    constructor(
        private readonly lease: <T>(use: (connection: oracledb.Connection) => Promise<T>) => Promise<T>,
        private readonly autoCommit: boolean,
    ) {}

    all<T = Row>(sql: string, binds: Binds = []): Promise<T[]> {
        const prepared = prepare(sql, binds);
        return this.lease(async (connection) => {
            const result = await connection.execute<Row>(prepared.sql, prepared.binds as oracledb.BindParameters, { autoCommit: this.autoCommit, outFormat: oracledb.OUT_FORMAT_OBJECT });
            return (result.rows ?? []).map(lowerKeys) as T[];
        });
    }

    async get<T = Row>(sql: string, binds: Binds = []): Promise<T | undefined> {
        return (await this.all<T>(sql, binds))[0];
    }

    run(sql: string, binds: Binds = []): Promise<{ changes: number }> {
        const prepared = prepare(sql, binds);
        return this.lease(async (connection) => {
            const result = await connection.execute(prepared.sql, prepared.binds as oracledb.BindParameters, { autoCommit: this.autoCommit });
            return { changes: result.rowsAffected ?? 0 };
        });
    }

    insert(sql: string, binds: Binds = [], idColumn = "id"): Promise<number> {
        const prepared = prepare(`${sql} RETURNING ${idColumn} INTO :newid`, binds);
        return this.lease(async (connection) => {
            const result = await connection.execute(
                prepared.sql,
                { ...prepared.binds, newid: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } } as oracledb.BindParameters,
                { autoCommit: this.autoCommit },
            );
            return Number((result.outBinds as { newid: number[] }).newid[0]);
        });
    }

    update<T>(sql: string, binds: Binds, returning: Record<string, "string" | "number">): Promise<T | undefined> {
        const columns = Object.keys(returning);
        const prepared = prepare(`${sql} RETURNING ${columns.join(", ")} INTO ${columns.map((column) => `:out_${column}`).join(", ")}`, binds);
        const outs = Object.fromEntries(
            columns.map((column) => [
                `out_${column}`,
                returning[column] === "number"
                    ? { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
                    : { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 4000 },
            ]),
        );

        return this.lease(async (connection) => {
            const result = await connection.execute(prepared.sql, { ...prepared.binds, ...outs } as oracledb.BindParameters, { autoCommit: this.autoCommit });
            const out = result.outBinds as Record<string, unknown[]>;
            if (!out[`out_${columns[0]}`]?.length) return undefined;
            return Object.fromEntries(columns.map((column) => [column, out[`out_${column}`]![0]])) as T;
        });
    }

    async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
        if (!this.autoCommit) return work(this); // already inside one

        return this.lease(async (connection) => {
            try {
                const result = await work(new Executor((use) => use(connection), false));
                await connection.commit();
                return result;
            } catch (error) {
                await connection.rollback().catch(() => {});
                throw error;
            }
        });
    }
}

// ---- schema ----------------------------------------------------------------------------------

// Dates are stored as ISO-8601 text, which sorts and compares correctly. Oracle treats an empty string
// as NULL, so NOT NULL text columns must never be given "".
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS jobs (
        id                  NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source              VARCHAR2(50)   NOT NULL,
        external_id         VARCHAR2(400)  NOT NULL,
        url                 VARCHAR2(2000) NOT NULL,
        title               VARCHAR2(1000) NOT NULL,
        company             VARCHAR2(1000),
        location            VARCHAR2(1000),
        description         CLOB,
        job_type            VARCHAR2(200),
        salary              VARCHAR2(500),
        category            VARCHAR2(500),
        posted_at           VARCHAR2(40),
        closing_at          VARCHAR2(40),
        apply_email         VARCHAR2(320),
        -- where apply_email came from: 'page' (written in the ad's text or a mailto link) or 'image' (read by OCR)
        apply_email_source  VARCHAR2(10),
        apply_url           VARCHAR2(2000),
        enriched_at         VARCHAR2(40),
        -- failed attempts to read the detail page; after a few the job is left alone
        enrich_failures     NUMBER DEFAULT 0 NOT NULL,
        first_seen_at       VARCHAR2(40) NOT NULL,
        last_seen_at        VARCHAR2(40) NOT NULL,
        CONSTRAINT jobs_source_external_uq UNIQUE (source, external_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs (last_seen_at)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_closing ON jobs (closing_at)",

    `CREATE TABLE IF NOT EXISTS users (
        id                 NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        email              VARCHAR2(320) NOT NULL,
        password_hash      VARCHAR2(500) NOT NULL,
        role               VARCHAR2(20) DEFAULT 'user' NOT NULL,
        created_at         VARCHAR2(40) NOT NULL,
        last_login_at      VARCHAR2(40),
        -- set when the owner proved control of the address (verification link or password-reset link)
        email_verified_at  VARCHAR2(40),
        CONSTRAINT users_email_uq UNIQUE (email)
    )`,

    // One-time links sent by email. Only a hash of the token is stored; a used or expired row is useless.
    // purpose: 'verify' (confirm the address) or 'reset' (choose a new password)
    `CREATE TABLE IF NOT EXISTS email_tokens (
        id          NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id     NUMBER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        purpose     VARCHAR2(20) NOT NULL,
        token_hash  VARCHAR2(200) NOT NULL,
        -- the address the link was sent to; a verification only counts while it is still the account's address
        email       VARCHAR2(320) NOT NULL,
        created_at  VARCHAR2(40) NOT NULL,
        expires_at  VARCHAR2(40) NOT NULL,
        used_at     VARCHAR2(40),
        CONSTRAINT email_tokens_hash_uq UNIQUE (token_hash)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, purpose)",

    // Only a hash of the session token is stored, so a copy of the database cannot be used to sign in
    `CREATE TABLE IF NOT EXISTS sessions (
        id          NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id     NUMBER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash  VARCHAR2(200) NOT NULL,
        created_at  VARCHAR2(40) NOT NULL,
        expires_at  VARCHAR2(40) NOT NULL,
        user_agent  VARCHAR2(400),
        CONSTRAINT sessions_hash_uq UNIQUE (token_hash)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)",

    `CREATE TABLE IF NOT EXISTS candidates (
        id             NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        -- the account that owns this resume; deleting the account deletes everything below it
        user_id        NUMBER REFERENCES users (id) ON DELETE CASCADE,
        resume_hash    VARCHAR2(200) NOT NULL,
        file_name      VARCHAR2(500) NOT NULL,
        mime_type      VARCHAR2(200) NOT NULL,
        -- the original upload, attached to applications later
        file_data      BLOB NOT NULL,
        profile_json   CLOB NOT NULL,
        created_at     VARCHAR2(40) NOT NULL,
        updated_at     VARCHAR2(40) NOT NULL,
        CONSTRAINT candidates_hash_uq UNIQUE (resume_hash)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_candidates_user ON candidates (user_id)",

    // One row per (candidate, job) suggestion. status: suggested -> approved | rejected
    `CREATE TABLE IF NOT EXISTS matches (
        id               NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        candidate_id     NUMBER NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
        job_id           NUMBER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        score            NUMBER NOT NULL,
        details_json     CLOB NOT NULL,
        status           VARCHAR2(20) DEFAULT 'suggested' NOT NULL,
        subject          VARCHAR2(1000),
        cover_letter     CLOB,
        drafted_at       VARCHAR2(40),
        decided_at       VARCHAR2(40),
        -- the address the user confirmed after checking it against the original ad image
        confirmed_email  VARCHAR2(320),
        created_at       VARCHAR2(40) NOT NULL,
        updated_at       VARCHAR2(40) NOT NULL,
        CONSTRAINT matches_candidate_job_uq UNIQUE (candidate_id, job_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_matches_candidate_score ON matches (candidate_id, score DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matches_job ON matches (job_id)",

    // The applicant's own SMTP mailbox. The password is AES-256-GCM encrypted, never stored in clear.
    `CREATE TABLE IF NOT EXISTS mail_accounts (
        candidate_id  NUMBER PRIMARY KEY REFERENCES candidates (id) ON DELETE CASCADE,
        email         VARCHAR2(320) NOT NULL,
        from_name     VARCHAR2(500),
        host          VARCHAR2(500) NOT NULL,
        port          NUMBER NOT NULL,
        secure        NUMBER(1) NOT NULL,
        username      VARCHAR2(500) NOT NULL,
        password_enc  VARCHAR2(2000) NOT NULL,
        verified_at   VARCHAR2(40) NOT NULL,
        created_at    VARCHAR2(40) NOT NULL,
        updated_at    VARCHAR2(40) NOT NULL
    )`,

    // Send queue and audit trail: one application per approved match.
    // status: queued -> sending -> sent | failed ; queued -> cancelled
    `CREATE TABLE IF NOT EXISTS applications (
        id               NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        match_id         NUMBER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
        candidate_id     NUMBER NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
        to_email         VARCHAR2(320) NOT NULL,
        status           VARCHAR2(20) DEFAULT 'queued' NOT NULL,
        attempts         NUMBER DEFAULT 0 NOT NULL,
        next_attempt_at  VARCHAR2(40) NOT NULL,
        error            VARCHAR2(4000),
        message_id       VARCHAR2(500),
        -- exactly what was sent, kept for the audit trail
        sent_subject     VARCHAR2(1000),
        sent_body        CLOB,
        queued_at        VARCHAR2(40) NOT NULL,
        sent_at          VARCHAR2(40),
        updated_at       VARCHAR2(40) NOT NULL,
        CONSTRAINT applications_match_uq UNIQUE (match_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_applications_queue ON applications (status, next_attempt_at)",
    "CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications (candidate_id, sent_at)",
];

// ---- connection ------------------------------------------------------------------------------

let ready: Promise<oracledb.Pool> | undefined;

async function open(): Promise<oracledb.Pool> {
    const pool = await oracledb.createPool({
        user: process.env.ORACLE_USER || "ADMIN",
        password: required("ORACLE_PASSWORD"),
        connectString: required("ORACLE_CONNECT_STRING"),
        poolMin: 1,
        // the Always Free database allows only a handful of sessions
        poolMax: Number(process.env.ORACLE_POOL_MAX ?? 4),
        poolIncrement: 1,
        // idle connections to a cloud database get dropped; check them before handing one out
        poolPingInterval: 30,
    });

    try {
        const connection = await pool.getConnection();
        try {
            for (const statement of SCHEMA) await connection.execute(statement);
        } finally {
            await connection.close();
        }
    } catch (error) {
        await pool.close(0).catch(() => {});
        throw error;
    }

    return pool;
}

async function lease<T>(use: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
    ready ??= open();

    let pool: oracledb.Pool;
    try {
        pool = await ready;
    } catch (error) {
        ready = undefined; // allow a later call to try again, e.g. after the database was started
        throw error;
    }

    const connection = await pool.getConnection();
    try {
        return await use(connection);
    } finally {
        await connection.close();
    }
}

const database = new Executor(lease, true);

/** Connects on first use and creates any missing tables. */
export function getDatabase(): Db {
    return database;
}

/** Closes the connection pool. Scripts call this when done, otherwise the process would not exit. */
export async function closeDatabase(): Promise<void> {
    const pool = ready;
    ready = undefined;
    if (pool) await (await pool.catch(() => undefined))?.close(5);
}

/** True when an INSERT/UPDATE broke a UNIQUE constraint (ORA-00001). */
export const isUniqueViolation = (error: unknown): boolean => (error as { errorNum?: number } | null)?.errorNum === 1;
