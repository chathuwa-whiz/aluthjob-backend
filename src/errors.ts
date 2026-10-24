/** The requested record does not exist -> HTTP 404. */
export class NotFoundError extends Error {}

/** The request is valid but not allowed in the record's current state -> HTTP 409. */
export class RuleError extends Error {}

/** The server itself is not set up for this feature (missing secret, ...) -> HTTP 503. */
export class ConfigError extends Error {}

/** No valid session -> HTTP 401. */
export class UnauthorizedError extends Error {}

/** Signed in, but not allowed to do this -> HTTP 403. */
export class ForbiddenError extends Error {}

/** Too many attempts -> HTTP 429. `retryAfterSeconds` goes into the Retry-After header. */
export class TooManyRequestsError extends Error {
    constructor(message: string, readonly retryAfterSeconds: number) {
        super(message);
    }
}

/** The request itself is unusable (bad or expired link, ...) -> HTTP 400. */
export class BadRequestError extends Error {}

/** Signed in, but the email address has not been verified yet -> HTTP 403 with code EMAIL_NOT_VERIFIED. */
export class EmailNotVerifiedError extends ForbiddenError {
    constructor() {
        super("Verify your email address to continue. Check your inbox, or ask for a new link");
    }
}
