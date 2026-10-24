import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import { EmailNotVerifiedError, ForbiddenError, UnauthorizedError } from "../errors.js";
import { authenticate } from "./auth.service.js";
import { allowedOrigins } from "./origins.js";
import type { User } from "./user.repository.js";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Set by requireAuth. */
            user?: User;
            /** The raw session token the request came with, kept so logout and password change can name it. */
            sessionToken?: string;
        }
    }
}

export { allowedOrigins };
export const SESSION_COOKIE = "aj_session";

// ---- reading the session ---------------------------------------------------------------

function cookieValue(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? "").split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0 && part.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(part.slice(separator + 1).trim());
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

/** A browser sends the cookie; scripts and other servers send `Authorization: Bearer <token>`. */
export function sessionTokenOf(req: Request): string | undefined {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim() || undefined;

    return cookieValue(req.headers.cookie, SESSION_COOKIE);
}

/** Rejects the request unless it carries a live session. Mounted once, in front of every route that is not public. */
export const requireAuth: RequestHandler = (req, _res, next) => {
    const token = sessionTokenOf(req);
    const user = token ? authenticate(token) : undefined;
    if (!token || !user) throw new UnauthorizedError("Sign in to continue");

    req.user = user;
    req.sessionToken = token;
    next();
};

/**
 * After requireAuth: an account whose email address is not confirmed can sign in but not use the service.
 * Everything under /api/v1 except /auth sits behind this, so confirming the address is a precondition for
 * uploading a resume, matching, connecting a mailbox or sending anything.
 */
export const requireVerified: RequestHandler = (req, _res, next) => {
    if (!req.user?.emailVerified) throw new EmailNotVerifiedError();
    next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
    if (req.user?.role !== "admin") throw new ForbiddenError("Only administrators can do this");
    next();
};

/** The signed-in user. Routes sit behind requireAuth, so a missing user means the guard was bypassed: fail loudly. */
export function currentUser(req: Request): User {
    if (!req.user) throw new UnauthorizedError("Sign in to continue");
    return req.user;
}

// ---- the cookie ------------------------------------------------------------------------

export function sessionCookieOptions(): CookieOptions {
    return {
        httpOnly: true, // not readable by page scripts, so an XSS bug cannot steal the session
        sameSite: "lax", // not sent on cross-site POSTs
        secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
        path: "/",
        maxAge: Number(process.env.SESSION_DAYS ?? 30) * 24 * 60 * 60 * 1000,
    };
}

export const setSessionCookie = (res: Response, token: string) => res.cookie(SESSION_COOKIE, token, sessionCookieOptions());

export function clearSessionCookie(res: Response) {
    const { maxAge: _maxAge, ...options } = sessionCookieOptions();
    res.clearCookie(SESSION_COOKIE, options);
}

// ---- cross-site request protection -----------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Blocks state-changing requests that a browser sends on behalf of another website. Sessions live in
 * a cookie the browser attaches automatically, so without this a malicious page could submit a form
 * to this API as the signed-in user. Requests without an Origin header (scripts, curl) are not
 * browser-driven cross-site requests and pass, unless the browser itself says they are cross-site.
 */
export function originGuard(req: Request, _res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get("origin");

    if (origin) {
        const own = `${req.protocol}://${req.get("host")}`;
        if (origin !== own && !allowedOrigins().includes(origin)) throw new ForbiddenError("Request from an untrusted origin was blocked");
    } else if (req.get("sec-fetch-site") === "cross-site") {
        throw new ForbiddenError("Cross-site request blocked");
    }

    next();
}
