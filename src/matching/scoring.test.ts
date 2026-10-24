import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobPosting } from "../jobs/types.js";
import type { Resume } from "../schemas/resume.schema.js";
import { buildCorpus, buildProfileModel, parseMonth, relevantYears, requiredYears, scoreJob, yearsOfExperience } from "./scoring.js";
import { skillKey, skillKeysIn, stem, titleTerms } from "./text-utils.js";

const NOW = new Date("2026-10-24");

const profile: Resume = {
    personalInfo: { fullName: "Test Dev", email: null, phone: null, location: "Colombo, Sri Lanka", linkedin: null, portfolio: null },
    skills: ["JavaScript", "TypeScript", "React", "Node.js", "PostgreSQL", "Docker", "C++"],
    education: [{ institution: "UoC", degree: "BSc in Computer Science", field: "Computer Science", startDate: "2020", endDate: "2024" }],
    experience: [
        {
            company: "Acme",
            position: "Software Engineer",
            startDate: "2023-01",
            endDate: "Present",
            responsibilities: ["Built REST APIs with Node.js", "Developed React dashboards"],
        },
    ],
    certifications: [],
    achievements: [],
};

const job = (overrides: Partial<JobPosting>): JobPosting => ({
    source: "xpress",
    externalId: "1",
    url: "https://example.com/1",
    title: "Job",
    company: null,
    location: "Colombo",
    description: null,
    jobType: null,
    salary: null,
    category: null,
    postedAt: null,
    closingAt: null,
    applyEmail: null,
    applyUrl: null,
    ...overrides,
});

const driver = job({ title: "Heavy Vehicle Driver", description: "Valid heavy vehicle licence. Deliver goods across the island." });
const sales = job({ title: "Sales Executive", description: "Meet monthly targets, visit customers, build relationships." });
const fullstack = job({
    title: "Senior Full Stack Engineer (React / Node.js)",
    description: "We need 2 years of experience building web apps with React, Node.js, TypeScript and PostgreSQL. Docker is a plus.",
});
const foreign = job({ ...fullstack, location: "Mumbai, India" });
const remote = job({ ...fullstack, location: "Remote" });

const corpus = buildCorpus([driver, sales, fullstack, foreign, remote]);
const model = buildProfileModel(profile, NOW);

describe("text utils", () => {
    it("treats spelling variants of a skill as the same skill", () => {
        assert.equal(skillKey("Node.js"), skillKey("NodeJS"));
        assert.equal(skillKey("React.js"), skillKey("react"));
        assert.equal(skillKey("JS"), skillKey("JavaScript"));
        assert.equal(skillKey(".NET"), skillKey("dotnet"));
    });

    it("finds multi-word skills and symbols inside ad text", () => {
        const keys = skillKeysIn("Experience with C++, C# and Machine Learning required. ASP.NET a plus");
        assert.ok(keys.has("c++"));
        assert.ok(keys.has("c#"));
        assert.ok(keys.has(skillKey("machine learning")));
    });

    it("stems related words to one term", () => {
        assert.equal(stem("developer"), stem("development"));
        assert.equal(stem("engineering"), stem("engineer"));
        assert.equal(stem("c++"), "c++");
    });

    it("drops seniority words from titles", () => {
        assert.deepEqual([...titleTerms("Senior Software Engineer")].sort(), [stem("software"), stem("engineer")].sort());
    });
});

describe("resume dates", () => {
    it("reads the formats models actually write", () => {
        const month = (year: number, m: number) => year * 12 + m - 1;

        assert.equal(parseMonth("2024-03", NOW), month(2024, 3));
        assert.equal(parseMonth("Dec 2024", NOW), month(2024, 12));
        assert.equal(parseMonth("September 2021", NOW), month(2021, 9));
        assert.equal(parseMonth("03/2022", NOW), month(2022, 3));
        assert.equal(parseMonth("Present", NOW), month(2026, 10));
        assert.equal(parseMonth("2019", NOW, "start"), month(2019, 1));
        assert.equal(parseMonth("2019", NOW, "end"), month(2019, 12));
        assert.equal(parseMonth("sometime", NOW), null);
        assert.equal(parseMonth(null, NOW), null);
    });
});

describe("relevant experience", () => {
    const career: Resume = {
        ...profile,
        experience: [
            { company: "Dev Co", position: "Software Engineer Intern", startDate: "Dec 2024", endDate: "Jun 2025", responsibilities: ["Built React apps with Node.js"] },
            { company: "Sail Co", position: "Sail Craft Technician", startDate: "May 2021", endDate: "Oct 2022", responsibilities: ["Maintained equipment and inventory"] },
        ],
    };
    const careerModel = buildProfileModel(career, NOW);
    const keys = new Set(["react", "node"]);

    it("counts all work as experience but only related work toward a job", () => {
        assert.equal(careerModel.yearsOfExperience, 2.1);
        assert.equal(relevantYears(careerModel, { title: "Software Engineer" }, keys), 0.6);
        assert.equal(relevantYears(careerModel, { title: "Boat Technician" }, new Set()), 1.5);
    });

    it("does not guess when no dates could be read", () => {
        const undated = buildProfileModel(
            { ...career, experience: career.experience.map((job) => ({ ...job, startDate: null, endDate: null })) },
            NOW,
        );
        assert.equal(relevantYears(undated, { title: "Software Engineer" }, keys), null);
    });

    it("ranks a fresher below a junior role asking for years of related experience only mildly, but far below a senior one", () => {
        const entry = job({ ...fullstack, title: "Software Engineer", description: "1 year of experience with React and Node.js" });
        const lead = job({ ...fullstack, title: "Lead Engineer", description: "10 years of experience with React and Node.js" });

        const fresherCorpus = buildCorpus([entry, lead, driver]);
        assert.ok(scoreJob(careerModel, entry, fresherCorpus).score >= 50);
        assert.ok(scoreJob(careerModel, lead, fresherCorpus).score <= 30);
    });
});

describe("experience", () => {
    it("counts overlapping jobs once", () => {
        const years = yearsOfExperience(
            [
                { company: "A", position: "x", startDate: "2020-01", endDate: "2021-12", responsibilities: [] },
                { company: "B", position: "y", startDate: "2021-01", endDate: "2022-12", responsibilities: [] },
            ],
            NOW,
        );
        assert.equal(years, 3);
    });

    it("reads the required years from an ad", () => {
        assert.equal(requiredYears({ title: "Engineer", description: "Minimum 3 years of experience in sales" }), 3);
        assert.equal(requiredYears({ title: "Engineer", description: "2-4 years experience" }), 2);
        assert.equal(requiredYears({ title: "Junior Engineer", description: null }), 0);
        assert.equal(requiredYears({ title: "Senior Engineer", description: null }), 4);
        assert.equal(requiredYears({ title: "Engineer", description: "Founded 1998, over 25 years in the market" }), null);
    });
});

describe("scoreJob", () => {
    it("ranks a relevant job far above unrelated ones", () => {
        const good = scoreJob(model, fullstack, corpus);
        const bad = scoreJob(model, driver, corpus);
        const other = scoreJob(model, sales, corpus);

        assert.ok(good.score >= 65, `relevant job scored ${good.score}`);
        assert.ok(bad.score <= 25, `unrelated job scored ${bad.score}`);
        assert.ok(other.score <= 35, `unrelated sales job scored ${other.score}`);
        assert.ok(good.score > other.score + 30);
    });

    it("reports which skills matched", () => {
        const result = scoreJob(model, fullstack, corpus);
        for (const skill of ["React", "Node.js", "TypeScript", "PostgreSQL", "Docker"]) {
            assert.ok(result.matchedSkills.includes(skill), `missing ${skill}`);
        }
        assert.ok(!result.matchedSkills.includes("C++"));
    });

    it("caps jobs in another country unless remote", () => {
        assert.ok(scoreJob(model, foreign, corpus).score <= 25);
        assert.ok(scoreJob(model, remote, corpus).score > scoreJob(model, foreign, corpus).score + 30);
    });

    it("caps jobs that ask for far more experience", () => {
        const senior = job({ ...fullstack, description: `${fullstack.description} Minimum 12 years of experience.` });
        const result = scoreJob(model, senior, corpus);

        assert.ok(result.score <= 30, `scored ${result.score}`);
        assert.ok(result.warnings.some((warning) => warning.includes("12 years")));
    });

    it("applies a milder cap for a moderate experience gap", () => {
        const gap = job({ ...fullstack, description: `${fullstack.description} Minimum 8 years of experience.` });
        const result = scoreJob(model, gap, corpus);

        assert.ok(result.score <= 45, `scored ${result.score}`);
        assert.ok(result.score > 30, `scored ${result.score}`);
    });

    it("still scores resumes that have no skills section", () => {
        const noSkills = buildProfileModel({ ...profile, skills: [] }, NOW);
        const result = scoreJob(noSkills, fullstack, corpus);

        assert.ok(result.score > scoreJob(noSkills, driver, corpus).score + 20);
    });
});
