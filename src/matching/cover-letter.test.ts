import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredJob } from "../jobs/job.repository.js";
import { buildSubject, describeDuration, templateBody, validateBody, type Facts } from "./cover-letter.service.js";

const SOURCE = [
    "Candidate: Test Dev",
    "Most recent role: Full Stack Developer Intern at Webminds",
    "Duties there: Built web applications with the MERN stack and Next.js",
    "Relevant skills: React, Node.js, TypeScript, PostgreSQL",
    "Education: BSc (Hons) Information Technology from SLIIT",
    "Job title: Software Engineer",
    "Employer: Acme Software (Pvt) Ltd",
].join("\n");

const sentence = "I build reliable web applications with React and enjoy working with a delivery team to ship useful features. ";
const goodBody = sentence.repeat(6).trim();

describe("validateBody", () => {
    it("accepts a plausible letter body", () => {
        assert.equal(validateBody(goodBody, SOURCE), null);
    });

    it("accepts names that come from the candidate's facts and the job", () => {
        const body = `${goodBody} At Webminds I used TypeScript and Next.js, and my studies at SLIIT support this. I would be glad to join Acme Software.`;
        assert.equal(validateBody(body, SOURCE), null);
    });

    it("rejects bodies that are too short or too long", () => {
        assert.match(validateBody("I would like this job.", SOURCE) ?? "", /too short/);
        assert.match(validateBody(sentence.repeat(30), SOURCE) ?? "", /too long/);
    });

    it("rejects claims about duration, however they are worded", () => {
        assert.match(validateBody(`${goodBody} I have over two years of experience.`, SOURCE) ?? "", /duration/);
        assert.match(validateBody(`${goodBody} I spent seven months there.`, SOURCE) ?? "", /duration/);
    });

    it("rejects numbers and number words that are not in the facts", () => {
        assert.match(validateBody(`${goodBody} I increased revenue by 45 percent.`, SOURCE) ?? "", /"45"/);
        assert.match(validateBody(`${goodBody} I led a team of five engineers.`, SOURCE) ?? "", /"five"/);
        assert.match(validateBody(`${goodBody} We targeted 99.99999 uptime.`, SOURCE) ?? "", /"99"/);
    });

    it("rejects employers, tools and places that are not in the facts", () => {
        assert.match(validateBody(`${goodBody} I also used AWS for deployment.`, SOURCE) ?? "", /"AWS"/);
        assert.match(validateBody(`${goodBody} I previously worked at Google.`, SOURCE) ?? "", /"Google"/);
        assert.match(validateBody(`${goodBody} I won a prize in Mathugama.`, SOURCE) ?? "", /"Mathugama"/);
    });

    it("rejects placeholders, markup, greetings and sign-offs", () => {
        assert.match(validateBody(`${goodBody} [Company Name]`, SOURCE) ?? "", /placeholders/);
        assert.match(validateBody(`Dear Sir, ${goodBody}`, SOURCE) ?? "", /greeting/);
        assert.match(validateBody(`${goodBody} Sincerely, Test`, SOURCE) ?? "", /sign-off/);
    });
});

describe("describeDuration", () => {
    it("uses months below a year and rounded years above", () => {
        assert.equal(describeDuration(0.6), "7 months");
        assert.equal(describeDuration(0.1), "1 month");
        assert.equal(describeDuration(1), "1 year");
        assert.equal(describeDuration(2.1), "2 years");
        assert.equal(describeDuration(2.6), "about 2.5 years");
    });
});

describe("templateBody", () => {
    const job = { title: "Software Engineer", company: "Acme Software" } as StoredJob;
    const facts: Facts = {
        name: "Test Dev",
        recentRole: { position: "Intern Developer", company: "Webminds", duties: [] },
        relatedYears: 0.6,
        skills: ["React", "Node.js"],
        education: "BSc (Hons) Information Technology from SLIIT",
        achievement: "Second place in a national award",
    };

    it("states related experience, not total career length", () => {
        const body = templateBody(facts, job);

        assert.match(body, /7 months of related work/);
        assert.match(body, /As an Intern Developer at Webminds/);
        assert.match(body, /My skills include React, Node.js\./);
        assert.match(body, /Second place in a national award\./);
    });

    it("omits the duration when no related experience is known", () => {
        assert.doesNotMatch(templateBody({ ...facts, relatedYears: null }, job), /related work/);
        assert.doesNotMatch(templateBody({ ...facts, relatedYears: 0 }, job), /related work/);
    });

    it("still reads sensibly without any work history", () => {
        const body = templateBody({ ...facts, recentRole: null }, { ...job, company: null } as StoredJob);
        assert.match(body, /Software Engineer position at your organisation/);
    });
});

describe("buildSubject", () => {
    const job = { title: "Software Engineer" } as StoredJob;
    const profile = { personalInfo: { fullName: "Test Dev" } } as Parameters<typeof buildSubject>[0];

    it("names the position and the applicant", () => {
        assert.equal(buildSubject(profile, job), "Application for Software Engineer - Test Dev");
    });
});
