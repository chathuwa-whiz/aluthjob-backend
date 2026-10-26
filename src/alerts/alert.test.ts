import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildAlertMail, closingLabel, renderAlertHtml, type AlertEmailInput, type AlertJob } from "./alert-email.js";
import { signAlertToken, verifyAlertToken } from "./alert-token.js";
import { effectiveFrequency, isDue, linksFor } from "./alert.service.js";
import type { Recipient } from "./alert.repository.js";

process.env.MAIL_SECRET = "test-secret-".repeat(4);
process.env.FRONTEND_URL = "http://localhost:3000";
delete process.env.APP_URL;
delete process.env.ALERT_SECRET;
delete process.env.API_URL;

const NOW = new Date("2026-10-26T04:00:00.000Z");
const DAY = 86_400_000;

const job = (overrides: Partial<AlertJob> = {}): AlertJob => ({
    matchId: 7,
    title: "Software Engineer",
    company: "Acme",
    location: "Colombo",
    score: 88,
    jobType: "Full time",
    salary: null,
    closingAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    reasons: ["Asks for 4 of your skills"],
    matchedSkills: ["React", "Node.js"],
    warnings: [],
    applyMethod: "email",
    ...overrides,
});

const input = (overrides: Partial<AlertEmailInput> = {}): AlertEmailInput => ({
    to: "person@example.com",
    firstName: "Nimal",
    jobs: [job()],
    moreCount: 0,
    frequency: "daily",
    links: linksFor(42),
    logo: true,
    now: NOW,
    ...overrides,
});

describe("alert tokens", () => {
    it("round-trips and carries only what it names", () => {
        const payload = verifyAlertToken(signAlertToken({ userId: 42, action: "hide", matchId: 7 }));
        assert.deepEqual(payload, { userId: 42, action: "hide", matchId: 7 });

        assert.deepEqual(verifyAlertToken(signAlertToken({ userId: 42, action: "off" })), { userId: 42, action: "off" });
    });

    it("rejects a changed body, a changed signature, junk and extra parts", () => {
        const token = signAlertToken({ userId: 42, action: "pause" });
        const [body, signature] = token.split(".") as [string, string];

        const other = Buffer.from(JSON.stringify({ u: 1, a: "pause", e: 9_999_999_999 })).toString("base64url");
        assert.equal(verifyAlertToken(`${other}.${signature}`), undefined);
        assert.equal(verifyAlertToken(`${body}.${signature.slice(0, -2)}AA`), undefined);
        assert.equal(verifyAlertToken(`${token}.x`), undefined);
        assert.equal(verifyAlertToken("not a token"), undefined);
        assert.equal(verifyAlertToken(""), undefined);
    });

    it("expires: 'hide' after weeks, the others after a year", () => {
        const hide = signAlertToken({ userId: 1, action: "hide", matchId: 2 }, NOW.getTime());
        assert.ok(verifyAlertToken(hide, NOW.getTime() + 40 * DAY));
        assert.equal(verifyAlertToken(hide, NOW.getTime() + 50 * DAY), undefined);

        const unsubscribe = signAlertToken({ userId: 1, action: "off" }, NOW.getTime());
        assert.ok(verifyAlertToken(unsubscribe, NOW.getTime() + 300 * DAY));
        assert.equal(verifyAlertToken(unsubscribe, NOW.getTime() + 400 * DAY), undefined);
    });

    it("is not valid under another secret", () => {
        const token = signAlertToken({ userId: 1, action: "off" });
        process.env.MAIL_SECRET = "another-secret-".repeat(4);
        try {
            assert.equal(verifyAlertToken(token), undefined);
        } finally {
            process.env.MAIL_SECRET = "test-secret-".repeat(4);
        }
    });
});

describe("alert email", () => {
    it("escapes scraped text so an advert cannot inject markup", () => {
        const html = renderAlertHtml(input({ jobs: [job({ title: `<script>alert(1)</script> & "Dev"`, company: "<b>Evil</b>", reasons: ["<img src=x onerror=1>"] })] }));

        assert.ok(!html.includes("<script>alert"));
        assert.ok(!html.includes("<b>Evil</b>"));
        assert.ok(!html.includes("<img src=x"));
        assert.ok(html.includes("&lt;script&gt;"));
    });

    it("has no remote content or tracking: the only image is the attached logo", () => {
        const html = renderAlertHtml(input());
        const images = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((match) => match[1]);

        assert.deepEqual(images, ["cid:aluthjob-logo"]);
        assert.ok(!/url\(http/i.test(html));
        assert.ok(!/<link[^>]+href/i.test(html));
    });

    it("gives every job a review link and a one-tap hide link, and the footer its controls", () => {
        const html = renderAlertHtml(input({ jobs: [job({ matchId: 7 }), job({ matchId: 8 })] }));

        for (const id of [7, 8]) {
            assert.ok(html.includes(`http://localhost:3000/matches/${id}`));
        }
        assert.equal([...html.matchAll(/Not for me/g)].length, 2);
        // two hide links + pause, weekly, unsubscribe (today's "Daily" is the selected pill, so it is not a link)
        assert.equal([...html.matchAll(/email-action#token=/g)].length, 2 + 3);
        assert.ok(html.includes("Unsubscribe"));
    });

    it("marks the current frequency and links to the other", () => {
        const daily = renderAlertHtml(input({ frequency: "daily" }));
        assert.match(daily, /pill-on[^>]*>Daily &#10003;/);
        assert.match(daily, /pill-off"[^>]*>Weekly</);

        const weekly = renderAlertHtml(input({ frequency: "weekly" }));
        assert.match(weekly, /pill-on[^>]*>Weekly &#10003;/);
    });

    it("builds a multipart mail with one-click unsubscribe headers and a short, plain subject", () => {
        const mail = buildAlertMail(input({ moreCount: 3 }), "/tmp/logo.png");

        assert.ok(mail.html && mail.text);
        assert.match(mail.headers!["List-Unsubscribe"]!, /^<http:\/\/localhost:3000\/api\/v1\/alerts\/unsubscribe\?t=[^>]+>$/);
        assert.equal(mail.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
        assert.equal(mail.attachments?.[0]?.cid, "aluthjob-logo");

        assert.match(mail.subject, /^4 new matches: Software Engineer at Acme \(88%\)$/);
        assert.ok(mail.subject.length <= 90);
        assert.ok(!/[A-Z]{6,}|!{2,}/.test(mail.subject) && !/\b(free|urgent|act now)\b/i.test(mail.subject), "no spam-trigger wording");
    });

    it("the text version stands on its own", () => {
        const { text } = buildAlertMail(input({ jobs: [job({ warnings: ["Needs 5 years"] })], moreCount: 2 }));

        assert.match(text, /Review & apply: http:\/\/localhost:3000\/matches\/7/);
        assert.match(text, /Not for me:\s+http:\/\/localhost:3000\/email-action#token=/);
        assert.match(text, /Check first: Needs 5 years/);
        assert.match(text, /Unsubscribe: /);
        assert.match(text, /\+ 2 more matches waiting/);
    });

    it("says a single match in the singular", () => {
        assert.match(buildAlertMail(input()).subject, /^New match: /);
        assert.match(renderAlertHtml(input()), /A new job matches your CV/);
    });

    it("describes closing dates", () => {
        assert.equal(closingLabel(new Date(NOW.getTime() + 0.5 * DAY).toISOString(), NOW)?.text, "Closes tomorrow");
        assert.equal(closingLabel(new Date(NOW.getTime() + 2.2 * DAY).toISOString(), NOW)?.urgent, true);
        assert.equal(closingLabel(new Date(NOW.getTime() + 10 * DAY).toISOString(), NOW)?.urgent, false);
        assert.equal(closingLabel(new Date(NOW.getTime() - DAY).toISOString(), NOW), null);
        assert.equal(closingLabel(null, NOW), null);
    });
});

describe("who gets an email", () => {
    let person: Recipient;
    beforeEach(() => {
        person = {
            userId: 1,
            email: "person@example.com",
            frequency: "daily",
            minScore: 55,
            pausedUntil: null,
            lastCheckedAt: null,
            lastSentAt: null,
            createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
            lastLoginAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        };
    });

    it("leaves people alone who switched off or paused", () => {
        assert.equal(effectiveFrequency({ ...person, frequency: "off" }, NOW), null);
        assert.equal(effectiveFrequency({ ...person, pausedUntil: new Date(NOW.getTime() + DAY).toISOString() }, NOW), null);
        assert.equal(effectiveFrequency({ ...person, pausedUntil: new Date(NOW.getTime() - DAY).toISOString() }, NOW), "daily");
    });

    it("slows down and then stops for people who stopped coming back", () => {
        const away = (days: number) => ({ ...person, lastLoginAt: new Date(NOW.getTime() - days * DAY).toISOString() });

        assert.equal(effectiveFrequency(away(10), NOW), "daily");
        assert.equal(effectiveFrequency(away(45), NOW), "weekly");
        assert.equal(effectiveFrequency(away(120), NOW), null);
    });

    it("paces the checks: not twice in a day, not twice in a week", () => {
        const checked = (hoursAgo: number, frequency: "daily" | "weekly") => ({ ...person, frequency, lastCheckedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });

        assert.equal(isDue(person, NOW), "daily"); // never checked: due (the first check only records a baseline)
        assert.equal(isDue(checked(5, "daily"), NOW), null);
        assert.equal(isDue(checked(23, "daily"), NOW), "daily");
        assert.equal(isDue(checked(24 * 3, "weekly"), NOW), null);
        assert.equal(isDue(checked(24 * 7, "weekly"), NOW), "weekly");
    });
});
