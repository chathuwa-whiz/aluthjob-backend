import { allowedOrigins } from "../auth/origins.js";
import type { OutgoingMail } from "./system-mailer.js";

const APP_NAME = "AluthJob";

/** Where the links in emails point: the web front end. APP_URL, else the first allowed front-end origin. */
export function appUrl(): string {
    return (process.env.APP_URL ?? allowedOrigins()[0] ?? "http://localhost:3000").replace(/\/+$/, "");
}

// The token travels in the URL fragment (#token=...). Browsers never send a fragment to a server, so it
// stays out of access logs, proxies and Referer headers; the front end reads it and posts it to the API.
export const verificationLink = (token: string) => `${appUrl()}/verify-email#token=${token}`;
export const resetLink = (token: string) => `${appUrl()}/reset-password#token=${token}`;

const footer = `\n\n-- ${APP_NAME}\nThis message was sent automatically. Do not forward it: the link in it works for whoever holds it.`;

export function verificationMessage(to: string, token: string, hours: number): OutgoingMail {
    return {
        to,
        subject: `Confirm your email address for ${APP_NAME}`,
        text:
            `Welcome to ${APP_NAME}.\n\nTo finish creating your account, confirm that this is your email address:\n\n${verificationLink(token)}\n\n` +
            `The link works once and expires in ${hours} hours. If you did not sign up, ignore this message and nothing will happen.${footer}`,
    };
}

// Sent when somebody registers an address that already has an account. It tells the real owner, and reveals
// nothing to the person who typed the address: the web page answers identically either way.
export function alreadyRegisteredMessage(to: string): OutgoingMail {
    return {
        to,
        subject: `Someone tried to sign up to ${APP_NAME} with your address`,
        text:
            `Someone just tried to create a ${APP_NAME} account with this email address, but it already has one.\n\n` +
            `If that was you, sign in instead. If you forgot your password, you can reset it here:\n\n${appUrl()}/forgot-password\n\n` +
            `If it was not you, no action is needed: your account was not changed.${footer}`,
    };
}

export function passwordResetMessage(to: string, token: string, minutes: number): OutgoingMail {
    return {
        to,
        subject: `Reset your ${APP_NAME} password`,
        text:
            `We received a request to reset the password of your ${APP_NAME} account.\n\nChoose a new password here:\n\n${resetLink(token)}\n\n` +
            `The link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this message: your password stays as it is.${footer}`,
    };
}

export function passwordChangedMessage(to: string, how: "reset" | "change"): OutgoingMail {
    return {
        to,
        subject: `Your ${APP_NAME} password was changed`,
        text:
            `The password of your ${APP_NAME} account was just ${how === "reset" ? "reset using an emailed link" : "changed from within your account"}, ` +
            `and every other device was signed out.\n\nIf this was you, nothing more is needed.\n\n` +
            `If it was not you, reset your password immediately at ${appUrl()}/forgot-password and check the mailbox connected to your account.${footer}`,
    };
}
