import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { RuleError } from "../errors.js";

// scrypt is memory-hard, so guessing passwords from a stolen database is expensive on GPUs too.
// The parameters are stored inside every hash, which lets them be raised later while old hashes keep working.
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const R = 8;
const P = 1;

// 2^15 uses about 32 MB and takes roughly 100 ms. Tests lower it through the environment to stay fast.
const cost = () => Number(process.env.AUTH_SCRYPT_COST ?? 32768);

const derive = (password: string, salt: Buffer, options: ScryptOptions) =>
    new Promise<Buffer>((resolve, reject) => {
        scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...options, maxmem: 256 * options.N! * options.r! }, (error, key) =>
            error ? reject(error) : resolve(key),
        );
    });

/** "scrypt$N$r$p$salt$hash" */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const N = cost();
    const key = await derive(password, salt, { N, r: R, p: P });

    return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;

    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p) });

    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A hash nobody knows the password of. Checking a login against it when the account does not exist
 * makes "no such user" take as long as "wrong password", so response time reveals nothing.
 */
let decoy: Promise<string> | undefined;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(24).toString("base64")));

// ---- policy ----------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

// The passwords attackers try first; length alone does not stop "password123"
const COMMON = new Set(
    [
        "password", "password1", "password12", "password123", "passw0rd123", "1234567890", "12345678910", "0123456789",
        "qwertyuiop", "qwerty12345", "qwerty123456", "iloveyou123", "letmein1234", "welcome1234", "admin12345", "abcdefghij",
        "abc1234567", "1q2w3e4r5t", "asdfghjkl1", "changeme123", "sunshine123", "princess123", "football123", "monkey12345",
    ].map((password) => password.toLowerCase()),
);

/** Throws a RuleError that explains what is wrong; passwords are never logged or echoed back. */
export function assertAcceptablePassword(password: string, email: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) throw new RuleError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
    if (password.length > MAX_PASSWORD_LENGTH) throw new RuleError(`Use a password of at most ${MAX_PASSWORD_LENGTH} characters`);

    const lower = password.toLowerCase();
    const local = email.split("@")[0]?.toLowerCase() ?? "";

    if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw new RuleError("That password is too common; choose something less guessable");
    if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) {
        throw new RuleError("The password must not contain your email address");
    }
}
