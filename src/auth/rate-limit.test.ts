import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "./rate-limit.js";
import { assertProductionSecurity } from "./config.js";
import { assertAcceptablePassword } from "./password.js";

describe("atomic rate-limit reservations", () => {
    it("counts in-flight work and does not let a successful request release other requests", () => {
        const limiter = new RateLimiter(2, 60_000);
        const one = limiter.reserve("ip");
        const two = limiter.reserve("ip");
        assert.throws(() => limiter.reserve("ip"));
        one(true, true);
        const three = limiter.reserve("ip");
        assert.throws(() => limiter.reserve("ip"));
        two(false);
        three(false);
        assert.throws(() => limiter.reserve("ip"));
        one(true); // settling twice cannot release anything
        assert.throws(() => limiter.reserve("ip"));
    });

    it("keeps reservations bounded even when a window expires during work", () => {
        let now = 0;
        const limiter = new RateLimiter(1, 10, "tries", () => now);
        const complete = limiter.reserve("ip");
        now = 20;
        assert.throws(() => limiter.reserve("ip"));
        complete(true);
        assert.doesNotThrow(() => limiter.reserve("ip"));
    });

    it("bounds distinct counters without evicting active allowances", () => {
        let now = 0;
        const limiter = new RateLimiter(1, 10, "tries", () => now, 2);
        limiter.record("one");
        limiter.record("two");
        assert.throws(() => limiter.record("three"));
        assert.throws(() => limiter.assertAllowed("one"));
        now = 11;
        assert.doesNotThrow(() => limiter.record("three"));
    });
});

it("rejects explicit unsafe production overrides and accepts trusted subnet settings", () => {
    const names = ["NODE_ENV", "COOKIE_SECURE", "MAIL_ALLOW_LOCAL", "TRUST_PROXY"] as const;
    const before = names.map((name) => process.env[name]);
    try {
        process.env.NODE_ENV = "production";
        for (const name of names.slice(1)) delete process.env[name];
        assert.doesNotThrow(assertProductionSecurity);
        process.env.COOKIE_SECURE = "false";
        assert.throws(assertProductionSecurity);
        process.env.COOKIE_SECURE = "true";
        process.env.MAIL_ALLOW_LOCAL = "true";
        assert.throws(assertProductionSecurity);
        delete process.env.MAIL_ALLOW_LOCAL;
        process.env.TRUST_PROXY = "true";
        assert.throws(assertProductionSecurity);
        process.env.TRUST_PROXY = "loopback, 10.0.0.0/8";
        assert.doesNotThrow(assertProductionSecurity);
        process.env.TRUST_PROXY = "1";
        assert.doesNotThrow(assertProductionSecurity);
    } finally {
        names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
    }
});

it("applies password policy after the normalization used by hashing", () => {
    assert.throws(() => assertAcceptablePassword("ｐａｓｓｗｏｒｄ１２３", "owner@example.com"), /too common/);
    assert.throws(() => assertAcceptablePassword("ＡＡＡＡＡＡＡＡＡＡ", "owner@example.com"), /too common/);
    assert.doesNotThrow(() => assertAcceptablePassword("café au lait 2026", "owner@example.com"));
});
