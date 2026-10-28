import { ConfigError } from "../errors.js";

/** Refuse explicit development-only overrides when starting a production server. */
export function assertProductionSecurity(): void {
    if (process.env.NODE_ENV !== "production") return;
    if (process.env.COOKIE_SECURE && process.env.COOKIE_SECURE !== "true") {
        throw new ConfigError("Production requires secure session cookies; remove COOKIE_SECURE or set it to true");
    }
    if (process.env.MAIL_ALLOW_LOCAL === "true") throw new ConfigError("MAIL_ALLOW_LOCAL must not be enabled in production");
    if (process.env.TRUST_PROXY === "true") {
        throw new ConfigError("Production TRUST_PROXY must name trusted proxy addresses or an exact hop count, rather than true");
    }
}
