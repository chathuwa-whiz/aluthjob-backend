import nodemailer, { type Transporter } from "nodemailer";
import { ConfigError } from "../errors.js";

// Messages the service itself sends (verify your address, reset your password). This is NOT the users' own
// mailboxes, which carry their job applications: it is one sender, configured by whoever runs the server.

export interface OutgoingMail {
    to: string;
    subject: string;
    /** Always present, and complete on its own: the HTML part is a prettier copy of it, never the only copy. */
    text: string;
    /** Optional styled version. Never contains tracking pixels or remote content; images are attached and referenced by cid. */
    html?: string;
    /** Extra headers, e.g. List-Unsubscribe. */
    headers?: Record<string, string>;
    /** Inline images referenced from the HTML as cid:<cid>. */
    attachments?: { filename: string; path: string; cid: string }[];
}

export interface SystemMailer {
    send(mail: OutgoingMail): Promise<void>;
}

let override: SystemMailer | undefined;
/** For tests: replaces whatever would otherwise be used. Pass nothing to go back to the configured one. */
export const setSystemMailer = (mailer?: SystemMailer) => {
    override = mailer;
};

const smtpConfigured = () => Boolean(process.env.SYSTEM_SMTP_HOST);
const isProduction = () => process.env.NODE_ENV === "production";

/** The most recent messages "sent" in development mode, newest last. Never filled in production. */
export const devOutbox: OutgoingMail[] = [];

// Development convenience: with no SMTP configured and not in production, messages are printed to the
// console, so the verification and reset links can be followed without any mail server.
const developmentMailer: SystemMailer = {
    async send(mail) {
        devOutbox.push(mail);
        if (devOutbox.length > 20) devOutbox.shift();

        console.log(`\n[development: email NOT sent, set SYSTEM_SMTP_HOST to send for real]\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    },
};

let smtp: { key: string; mailer: SystemMailer } | undefined;

function smtpMailer(): SystemMailer {
    const from = process.env.SYSTEM_MAIL_FROM;
    if (!from) throw new ConfigError('SYSTEM_MAIL_FROM must be set (for example: "AluthJob <no-reply@yourdomain.com>") when SYSTEM_SMTP_HOST is used');

    const port = Number(process.env.SYSTEM_SMTP_PORT ?? 587);
    const secure = process.env.SYSTEM_SMTP_SECURE ? process.env.SYSTEM_SMTP_SECURE === "true" : port === 465;
    const user = process.env.SYSTEM_SMTP_USER;
    const key = JSON.stringify([process.env.SYSTEM_SMTP_HOST, port, secure, user, process.env.SYSTEM_SMTP_PASS, from]);

    if (smtp?.key !== key) {
        const transport: Transporter = nodemailer.createTransport({
            host: process.env.SYSTEM_SMTP_HOST,
            port,
            secure,
            requireTLS: isProduction() && !secure,
            ...(user && { auth: { user, pass: process.env.SYSTEM_SMTP_PASS ?? "" } }),
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 30_000,
        });

        smtp = {
            key,
            mailer: {
                send: async (mail) =>
                    void (await transport.sendMail({
                        from,
                        to: mail.to,
                        subject: mail.subject,
                        text: mail.text,
                        ...(mail.html && { html: mail.html }),
                        ...(mail.headers && { headers: mail.headers }),
                        ...(mail.attachments && { attachments: mail.attachments.map((file) => ({ ...file, contentDisposition: "inline" as const })) }),
                    })),
            },
        };
    }

    return smtp.mailer;
}

/** Whether verification and reset emails can be sent at all on this server. */
export const systemMailAvailable = () => Boolean(override) || smtpConfigured() || !isProduction();

/** Throws a ConfigError (HTTP 503) with instructions when this server cannot send email. */
export function assertSystemMailAvailable(): void {
    if (!systemMailAvailable()) {
        throw new ConfigError(
            "This server is not set up to send email, so accounts cannot be verified. The operator must set SYSTEM_SMTP_HOST and SYSTEM_MAIL_FROM",
        );
    }
}

export function getSystemMailer(): SystemMailer {
    if (override) return override;
    if (smtpConfigured()) return smtpMailer();

    assertSystemMailAvailable();
    return developmentMailer;
}
