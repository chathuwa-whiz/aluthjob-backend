import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
    cleanOcrText, DnsUnavailableError, domainAcceptsMail, emailsFromOcr, hasPlausibleTld, MIN_EMAIL_CONFIDENCE, pickTrustedEmail,
    trustedEmails, type DnsLookup,
} from "./ocr-email.js";
import type { OcrResult } from "./ocr.service.js";

const ocr = (...words: [string, number][]): OcrResult => ({
    text: words.map(([text]) => text).join(" "),
    confidence: 80,
    words: words.map(([text, confidence]) => ({ text, confidence })),
});

/** A fake resolver: `mail` domains have MX records, `web` domains only an address record, all others do not exist. */
const dnsKnowing = (mail: string[], web: string[] = [], mxBroken = false): DnsLookup => ({
    resolveMx: async (domain) => {
        if (mxBroken) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        if (mail.includes(domain)) return [{ exchange: `mail.${domain}` }];
        throw Object.assign(new Error("x"), { code: web.includes(domain) ? "ENODATA" : "ENOTFOUND" });
    },
    lookup: async (domain) => {
        if (![...mail, ...web].includes(domain)) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
        // a mail-only domain (real example: bamholdings.com) has no address record at all
        if (!web.includes(domain)) throw Object.assign(new Error("nodata"), { code: "ENODATA" });
        return [{ address: "203.0.113.1" }];
    },
});

beforeEach(() => {
    delete process.env.OCR_MIN_EMAIL_CONFIDENCE;
});

describe("hasPlausibleTld", () => {
    it("accepts country codes and common generic domains, rejects misreads", () => {
        for (const ok of ["a@x.lk", "a@x.com", "a@x.com.au", "a@x.biz", "a@x.net", "a@x.org"]) assert.equal(hasPlausibleTld(ok), true, ok);
        for (const bad of ["a@x.blz", "a@x.c0m", "a@x.corn", "a@x.n3t", "a@x.l1"]) assert.equal(hasPlausibleTld(bad), false, bad);
    });
});

describe("domainAcceptsMail", () => {
    it("is yes for a domain with mail, no for one that does not exist", async () => {
        const dns = dnsKnowing(["real-company-a.lk"]);
        assert.equal(await domainAcceptsMail("real-company-a.lk", dns), "yes");
        assert.equal(await domainAcceptsMail("real-company-a.ne", dns), "no");
    });

    it("accepts a domain that only has an address record (mail then goes to it directly)", async () => {
        assert.equal(await domainAcceptsMail("web-only-example.lk", dnsKnowing([], ["web-only-example.lk"])), "yes");
    });

    it("accepts a mail-only domain with no address record (real case: bamholdings.com)", async () => {
        assert.equal(await domainAcceptsMail("mail-only-example.com", dnsKnowing(["mail-only-example.com"])), "yes");
    });

    it("rejects a misread domain that does not exist (real case: madgunasena.com for mdgunasena.com)", async () => {
        assert.equal(await domainAcceptsMail("madgunasena-example.com", dnsKnowing(["mdgunasena-example.com"])), "no");
    });

    it("says unknown, never no, when the MX lookup is broken and there is no address record to fall back on", async () => {
        // The machine this was written on refused every MX query; "cannot check" must not be reported as "does not exist"
        const dns = dnsKnowing(["mail-only-b.com"], [], true);
        assert.equal(await domainAcceptsMail("mail-only-b.com", dns), "unknown");
        assert.equal(await domainAcceptsMail("web-b.com", dnsKnowing([], ["web-b.com"], true)), "yes");
    });

    it("does not remember an outage as a verdict", async () => {
        let calls = 0;
        const dns: DnsLookup = {
            resolveMx: async () => { calls++; throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); },
            lookup: async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); },
        };

        assert.equal(await domainAcceptsMail("flaky-example.lk", dns), "unknown");
        assert.equal(await domainAcceptsMail("flaky-example.lk", dns), "unknown");
        assert.equal(calls, 2);
    });
});

describe("emailsFromOcr", () => {
    it("pairs each address with the engine's confidence in its word", () => {
        const found = emailsFromOcr(ocr(["Send", 95], ["your", 95], ["resume", 92], ["dulanjaleeuda@shaminigroup.com", 90]));
        assert.deepEqual(found, [{ email: "dulanjaleeuda@shaminigroup.com", confidence: 90 }]);
    });

    it("ignores the portals' own addresses", () => {
        assert.deepEqual(emailsFromOcr(ocr(["support@topjobs.lk", 95])), []);
    });

    it("keeps an address split across words but gives it no confidence", () => {
        const result: OcrResult = { text: "mail hr@company.lk now", confidence: 90, words: [{ text: "hr@", confidence: 90 }, { text: "company.lk", confidence: 90 }] };
        assert.deepEqual(emailsFromOcr(result), [{ email: "hr@company.lk", confidence: 0 }]);
    });
});

describe("pickTrustedEmail", () => {
    const dns = dnsKnowing(["acme.lk", "builtmech.net", "ugaresorts.com"]);

    it("returns a clean, confident address on a real domain", async () => {
        assert.deepEqual(await pickTrustedEmail([ocr(["careers@acme.lk", 92])], dns), { email: "careers@acme.lk", confidence: 92 });
    });

    it("rejects very low confidence, even for a real domain", async () => {
        assert.equal(await pickTrustedEmail([ocr(["careers@acme.lk", 25])], dns), null);
    });

    it("accepts the modest confidence real poster addresses get (hr-jp@ugaresorts.com scored 47)", async () => {
        assert.equal(MIN_EMAIL_CONFIDENCE(), 40);
        assert.equal((await pickTrustedEmail([ocr(["hr-jp@ugaresorts.com", 47])], dns))?.email, "hr-jp@ugaresorts.com");
    });

    it("honours a stricter configured threshold", async () => {
        process.env.OCR_MIN_EMAIL_CONFIDENCE = "75";
        assert.equal(await pickTrustedEmail([ocr(["careers@acme.lk", 60])], dns), null);
    });

    it("refuses to guess when DNS cannot be reached, so the ad is retried later", async () => {
        const down: DnsLookup = {
            resolveMx: async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); },
            lookup: async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); },
        };
        await assert.rejects(pickTrustedEmail([ocr(["careers@unreachable-dns-example.lk", 90])], down), DnsUnavailableError);
    });

    it("rejects a misread domain whatever the confidence (real case: builtmech.ne for builtmech.net)", async () => {
        assert.equal(await pickTrustedEmail([ocr(["wasantha@builtmech.ne", 95])], dns), null);
    });

    it("rejects the half-read 'a@' address from the same real ad", async () => {
        assert.equal(await pickTrustedEmail([ocr(["a@builtmech.net", 95])], dns), null);
    });

    it("rejects addresses whose top-level domain is not real", async () => {
        assert.equal(await pickTrustedEmail([ocr(["hr@acme.blz", 95])], dns), null);
    });

    it("picks nothing when the ad has several valid addresses, instead of guessing", async () => {
        const ad = ocr(["wasantha@builtmech.net", 90], ["mohamed@builtmech.net", 88]);
        assert.equal((await trustedEmails([ad], dns)).length, 2);
        assert.equal(await pickTrustedEmail([ad], dns), null);
    });

    it("treats the same address seen twice (two pictures) as one", async () => {
        const result = await pickTrustedEmail([ocr(["hr@acme.lk", 90]), ocr(["hr@acme.lk", 85])], dns);
        assert.equal(result?.email, "hr@acme.lk");
    });

    it("a garbled duplicate of the real address does not make the ad ambiguous", async () => {
        const result = await pickTrustedEmail([ocr(["hr@acme.lk", 90], ["hr@acme.Ik", 80], ["hr@acme.corn", 82])], dns);
        assert.equal(result?.email, "hr@acme.lk");
    });
});

describe("cleanOcrText", () => {
    it("removes the portal watermark and lines of stray symbols", () => {
        const cleaned = cleanOcrText("PURCHASING EXECUTIVE\n  ~~ ;; \ntopjobs.lk\nSource & evaluate   suppliers.\nt0pj0bs . Ik\n| |");
        assert.equal(cleaned, "PURCHASING EXECUTIVE\nSource & evaluate suppliers.");
    });
});
