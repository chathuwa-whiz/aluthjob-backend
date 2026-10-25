/**
 * Imported first by every test that touches the database. The tests delete every row of every table, so they
 * run only against the database named in TEST_ORACLE_*, never the one in ORACLE_* that the app uses.
 *
 * TEST_ORACLE_* come from the environment or from server/.env.test (see .env.test.example).
 * Remote databases are refused unless TEST_ORACLE_ALLOW_REMOTE=true, so a pasted production connection
 * string cannot be wiped by accident.
 */
try {
    process.loadEnvFile(".env.test");
} catch {
    // no .env.test: the variables may come from the shell
}

const { TEST_ORACLE_USER, TEST_ORACLE_PASSWORD, TEST_ORACLE_CONNECT_STRING } = process.env;

if (!TEST_ORACLE_USER || !TEST_ORACLE_PASSWORD || !TEST_ORACLE_CONNECT_STRING) {
    throw new Error(
        "The database tests need an Oracle database to run against. Copy .env.test.example to .env.test and fill it in " +
            "(a local Oracle Free container works; see the file). These tests delete all data in that database.",
    );
}

const isLocal = /(^|[@/(=])(localhost|127\.0\.0\.1)\b/i.test(TEST_ORACLE_CONNECT_STRING);
if (!isLocal && process.env.TEST_ORACLE_ALLOW_REMOTE !== "true") {
    throw new Error("TEST_ORACLE_CONNECT_STRING is not a local database. The tests wipe every table; set TEST_ORACLE_ALLOW_REMOTE=true only for a database that holds nothing you need.");
}
if (TEST_ORACLE_CONNECT_STRING === process.env.ORACLE_CONNECT_STRING && TEST_ORACLE_USER === process.env.ORACLE_USER) {
    throw new Error("TEST_ORACLE_* points at the same database as ORACLE_*. Use a separate one for tests.");
}

process.env.ORACLE_USER = TEST_ORACLE_USER;
process.env.ORACLE_PASSWORD = TEST_ORACLE_PASSWORD;
process.env.ORACLE_CONNECT_STRING = TEST_ORACLE_CONNECT_STRING;
process.env.ORACLE_POOL_MAX = "4";
