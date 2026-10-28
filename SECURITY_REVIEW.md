# Security review and remediation

Reviewed and fixed on 2026-10-28. Changes are local; nothing was deployed or committed.

## Findings and disposition

| Area | Validation and change |
| --- | --- |
| Concurrent authentication attempts | Confirmed check-before-await race. Attempts now reserve capacity before asynchronous work. Login starts are bounded, counter storage fails closed at capacity, and database transactions cap sessions at twenty per account. Regression tests cover parallel guessing and stale credentials. |
| Resume uploads | Confirmed rate checks happened after buffering. Checks now precede multipart parsing, reject unexpected fields, bound parts and bytes, and limit receiving requests globally and per user. Normal single-file forms still pass. |
| SMTP destinations | Confirmed hexadecimal IPv4-mapped IPv6 bypass. Canonical public-address validation handles mapped and NAT64 addresses, rejects private/reserved addresses, and pins the resolved destination. Local SMTP overrides cannot operate in production. |
| Resume ownership changes | Confirmed connected mailbox authority survived transfer. Transactional reassignment disconnects mailbox credentials, cancels pending work, withdraws approval, and refuses transfer during an active send. A slow mailbox verification cannot save credentials after ownership changes. |
| Expensive model/search work | Confirmed missing request/concurrency boundaries. Cover-letter work is shared while in progress, user budgets apply across resumes, and model/search/enrichment work has bounded concurrency. Mailbox verification is also bounded. Local model requests have a deadline. |
| Untrusted document processing | Source review established missing expansion/time bounds, not a demonstrated parser code-execution vulnerability. Parsing now runs in disposable child processes without application secrets, with a 192 MB V8 heap budget and 20-second deadline. Word archives have checked actual expansion (20 MB); PDFs are limited to 100 pages. Text/link counts and simultaneous parsers are bounded. This is resource isolation, not an operating-system security sandbox. |
| External HTTP downloads | Confirmed redirect destinations were not checked and body limits ran after allocation. Connections now pin public DNS answers, validate every redirect, drop credentials across origins, and bound decoded response bodies while receiving them. HTTP(S) scraping and live TopJobs retrieval were verified. |
| Sending quotas | Confirmed per-resume allowances multiplied mailbox/user limits, and reusing application rows lost send history. A durable database ledger reserves shared user, sender-address, and SMTP-login allowances, serializes claims across processes, and retains resend/deletion history within the rolling window. |

Additional confirmed fixes: atomic password/reset-token/session transitions; password confirmation checked again under lock; concurrent email-token issuance serialized; password policy normalized consistently with hashing; production SMTP requires TLS; private API responses use no-store; sending verifies the approved match version at claim time; worker recovery preserves live sends using heartbeats and stale-claim expiry.

The tracked `.env.test` values match the documented disposable localhost example. A production credential leak was not established. The local file and Git index were preserved; ignore rules now cover future untracked local test configuration.

## Verification

- Server: **320/320 tests pass**, including the real disposable Oracle database and local SMTP integration tests.
- Client: **136/136 tests pass**. Four existing progress tests were stabilized with explicitly controlled snapshots; product behavior was unchanged.
- Server, client, and admin production builds pass.
- Admin lint passes.
- `npm audit` against each project's lockfile reports **zero known advisories** for server, client, and admin (including development dependencies).
- Changed tracked files pass `git diff --check`.

The existing stopped `aluthjob-oracle-test` container was started for testing. The test harness uses the separate TEST_ORACLE configuration and refuses the application database. No live employer mail or application data was used in tests.

## Deployment and scope

- The API creates the additive `mail_send_events` table and indexes through its existing schema initialization. Existing application rows are considered when reserving allowances after an upgrade.
- Authentication counters and work pools remain process-local. Deploying multiple API processes requires shared edge throttling for aggregate authentication/work limits. Database session caps, send reservations, and ownership locks are shared across processes.
- Production startup rejects explicit insecure cookie/local-mail/unrestricted-proxy overrides. Local development settings remain supported outside production.
- Oversized or over-complex CVs are rejected intentionally. Older binary `.doc` files were already unsupported by the Mammoth parser; valid Word OOXML files and PDFs retain their working path.
- Zero dependency advisories and passing tests are evidence, not a guarantee of zero vulnerabilities. Production infrastructure, database privileges, historical secret exposure, and an independent penetration test remain outside this local code review.
