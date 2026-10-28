import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import { RuleError } from "../errors.js";
import { isPublicAddress } from "../network/public-address.js";

export interface SmtpSettings {
    host: string;
    port: number;
    /** true: TLS from the first byte (port 465). false: plain connection upgraded with STARTTLS. */
    secure: boolean;
    username: string;
    password: string;
}

// Only well-known mail submission ports. Accepting any port would let a user make this server
// probe arbitrary services.
const ALLOWED_PORTS = new Set([465, 587, 2525]);

const PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
    "gmail.com": { host: "smtp.gmail.com", port: 465, secure: true },
    "googlemail.com": { host: "smtp.gmail.com", port: 465, secure: true },
    "outlook.com": { host: "smtp-mail.outlook.com", port: 587, secure: false },
    "hotmail.com": { host: "smtp-mail.outlook.com", port: 587, secure: false },
    "live.com": { host: "smtp-mail.outlook.com", port: 587, secure: false },
    "yahoo.com": { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    "zoho.com": { host: "smtp.zoho.com", port: 465, secure: true },
};

/** Server settings for well-known providers, so most users only type their address and password. */
export function presetFor(email: string) {
    return PRESETS[email.split("@")[1]?.toLowerCase() ?? ""];
}

// Development and tests talk to a mail catcher on localhost; production never sets this
const allowLocal = () => process.env.NODE_ENV !== "production" && process.env.MAIL_ALLOW_LOCAL === "true";

/**
 * Resolves the host once and refuses internal addresses. The connection is then made to the
 * resolved IP (with the hostname kept for TLS), so a second DNS answer cannot redirect it.
 */
async function resolveSafely(host: string, port: number): Promise<string> {
    if (!allowLocal() && !ALLOWED_PORTS.has(port)) {
        throw new RuleError(`Port ${port} is not allowed; use 465 or 587`);
    }

    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (addresses.length === 0) throw new RuleError(`Could not find the mail server "${host}"`);

    if (!allowLocal() && addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new RuleError("The mail server must be a public address");
    }

    return addresses[0]!.address;
}

export async function createTransport(settings: SmtpSettings): Promise<Transporter> {
    const address = await resolveSafely(settings.host, settings.port);

    return nodemailer.createTransport({
        host: address,
        port: settings.port,
        secure: settings.secure,
        requireTLS: !settings.secure && !allowLocal(),
        auth: { user: settings.username, pass: settings.password },
        tls: { servername: settings.host },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
    });
}

/** Logs in without sending anything. Throws a user-readable RuleError when the mailbox is unusable. */
export async function verifySmtp(settings: SmtpSettings): Promise<void> {
    const transport = await createTransport(settings);

    try {
        await transport.verify();
    } catch (error) {
        throw new RuleError(describeSmtpError(error));
    } finally {
        transport.close();
    }
}

export interface SmtpFailure {
    message: string;
    /** false: the server refused the message or login, retrying cannot help. */
    retryable: boolean;
}

export function describeSmtpError(error: unknown): string {
    const err = error as { code?: string; responseCode?: number; response?: string; message?: string };

    if (err.code === "EAUTH" || err.responseCode === 535) {
        return "The mail server rejected the login. For Gmail and similar services use an app password, not your normal password";
    }
    if (err.code === "ETIMEDOUT" || err.code === "ESOCKET" || err.code === "ECONNECTION" || err.code === "ECONNREFUSED") {
        return "Could not reach the mail server";
    }
    return (err.response ?? err.message ?? "Mail server error").toString().slice(0, 300);
}

export function classifySmtpError(error: unknown): SmtpFailure {
    const err = error as { code?: string; responseCode?: number };
    const message = describeSmtpError(error);

    // Wrong login or a permanent 5xx refusal (bad recipient, blocked content) will not fix itself
    if (err.code === "EAUTH" || err.code === "EENVELOPE") return { message, retryable: false };
    if (err.responseCode !== undefined && err.responseCode >= 500) return { message, retryable: false };

    // connection trouble and 4xx (temporary) replies are worth another attempt later
    return { message, retryable: true };
}
