import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { ConfigError } from "../errors.js";

const MIN_SECRET_LENGTH = 32;
const VERSION = "v1";

let cachedKey: { secret: string; key: Buffer } | undefined;

// The key comes from the environment, so a copy of the database file alone reveals no passwords
function key(): Buffer {
    const secret = process.env.MAIL_SECRET;

    if (!secret || secret.length < MIN_SECRET_LENGTH) {
        throw new ConfigError(
            `MAIL_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters ` +
                `(for example: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")`,
        );
    }

    if (cachedKey?.secret !== secret) cachedKey = { secret, key: scryptSync(secret, "aluthjob-mail-v1", 32) };
    return cachedKey.key;
}

/** AES-256-GCM; the result is "v1:iv:authTag:ciphertext" in base64 parts. */
export function encryptSecret(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);

    return [VERSION, iv, cipher.getAuthTag(), encrypted].map((part) => (typeof part === "string" ? part : part.toString("base64"))).join(":");
}

export function decryptSecret(stored: string): string {
    const [version, iv, tag, encrypted] = stored.split(":");
    if (version !== VERSION || !iv || !tag || !encrypted) throw new Error("Stored secret has an unknown format");

    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));

    try {
        return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
    } catch {
        // wrong MAIL_SECRET or tampered data: GCM refuses to return anything
        throw new Error("Could not decrypt the stored mailbox password; MAIL_SECRET may have changed");
    }
}
