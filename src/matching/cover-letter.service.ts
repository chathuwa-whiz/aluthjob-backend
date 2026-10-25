import type { StoredJob } from "../jobs/job.repository.js";
import type { Resume } from "../schemas/resume.schema.js";
import { chat } from "../services/llm.client.js";
import { buildProfileModel, relevantYears } from "./scoring.js";
import { skillKey } from "./text-utils.js";

export interface CoverLetter {
    subject: string;
    /** Complete letter: greeting, body and sign-off. */
    text: string;
    /** "model" when the LLM wrote the body, "template" when it was unavailable or unreliable. */
    writtenBy: "model" | "template";
}

// The model never sees the advert text: small models copy an ad's duties and figures into the
// candidate's mouth, and an advert is untrusted input. It knows the job only by title and employer.
const SYSTEM_PROMPT = [
    "You write the body of a job application cover letter for the candidate described by the user.",
    "Use only the facts listed under Candidate. Never invent employers, numbers, degrees, tools, projects, achievements or durations.",
    "Write tool, technology and organisation names exactly as they appear in the facts; do not expand, extend or add to them (for example, never turn \"CI\" into \"CI/CD\").",
    "You know the job only by its title and employer; do not guess what the job involves.",
    "Write 2 short paragraphs, 100 to 150 words in total, in the first person, professional and specific.",
    "Do not mention how long the candidate has worked. Do not write a greeting, a sign-off, a subject line, placeholders in brackets, or markdown.",
].join(" ");

const MAX_ATTEMPTS = 2;
const MIN_WORDS = 70;
const MAX_WORDS = 260;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export interface Facts {
    name: string;
    recentRole: { position: string | null; company: string | null; duties: string[] } | null;
    /** Years of work related to this job, null when the resume has no readable dates. */
    relatedYears: number | null;
    skills: string[];
    education: string | null;
    achievement: string | null;
}

function gatherFacts(profile: Resume, job: StoredJob, matchedSkills: string[]): Facts {
    const recent = profile.experience[0];
    const education = profile.education.find((entry) => !/\b(g\.?c\.?e|advanced level|ordinary level)\b/i.test(entry.degree ?? "")) ?? profile.education[0];

    return {
        name: profile.personalInfo.fullName ?? "the candidate",
        recentRole: recent
            ? { position: recent.position, company: recent.company, duties: recent.responsibilities.slice(0, 2) }
            : null,
        relatedYears: relevantYears(buildProfileModel(profile), job, new Set(matchedSkills.map(skillKey))),
        // skills the ad actually asks for come first
        skills: [...new Set([...matchedSkills, ...profile.skills])].slice(0, 6),
        education: education
            ? oneLine([education.degree, education.institution && `from ${education.institution}`].filter(Boolean).join(" ")) || null
            : null,
        achievement: profile.achievements[0]?.description ?? null,
    };
}

/** What the model may talk about. Durations and achievements are left out on purpose, see validateBody. */
function factsText(facts: Facts): string {
    const lines = [`Candidate: ${facts.name}`];

    if (facts.recentRole) {
        const { position, company, duties } = facts.recentRole;
        lines.push(`Most recent role: ${[position, company && `at ${company}`].filter(Boolean).join(" ")}`);
        if (duties.length) lines.push(`Duties there: ${duties.join("; ")}`);
    }
    if (facts.skills.length) lines.push(`Relevant skills: ${facts.skills.join(", ")}`);
    if (facts.education) lines.push(`Education: ${facts.education}`);

    return lines.join("\n");
}

const jobText = (job: StoredJob) => [`Job title: ${job.title}`, `Employer: ${job.company ?? "not stated"}`].join("\n");

// ---- validation ------------------------------------------------------------------------

const NUMBER_WORDS =
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|twice|dozen|hundred|thousand|million)\b/gi;
const DURATION_RE = /\b(years?|yrs?|months?|decade)\b/i;

const digitsIn = (text: string) => new Set(text.match(/\d+/g) ?? []);

/** Capitalised words mid-sentence and acronyms: names of employers, schools, places and technologies. */
function properNouns(text: string): string[] {
    const found: string[] = [];

    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
        const words = sentence.match(/[A-Za-z][A-Za-z0-9+#.\-/]*/g) ?? [];

        words.forEach((word, index) => {
            const trimmed = word.replace(/[.\-/]+$/, "");
            const isAcronym = /^[A-Z][A-Z0-9+#]+$/.test(trimmed);
            const isMidSentenceCapital = index > 0 && /^[A-Z]/.test(trimmed) && trimmed !== "I";
            const hasInnerCapital = /^[a-z]+[A-Z]/.test(trimmed);

            if (isAcronym || isMidSentenceCapital || hasInnerCapital) found.push(trimmed);
        });
    }

    return found;
}

/**
 * Small models like to embellish, so the body may only contain what the candidate's own facts
 * contain: no durations, no numbers or number words that are not in the facts, no names of
 * employers, schools, places or technologies that are not in the facts, and no placeholders.
 */
export function validateBody(body: string, allowedSource: string): string | null {
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < MIN_WORDS) return `too short (${words} words)`;
    if (words > MAX_WORDS) return `too long (${words} words)`;
    if (/[\[\]{}<>]/.test(body)) return "contains placeholders or markup";
    if (/^\s*(dear|subject)\b/i.test(body) || /\b(sincerely|yours faithfully|kind regards)\b/i.test(body)) {
        return "contains a greeting or sign-off";
    }
    if (DURATION_RE.test(body)) return "states a duration, which cannot be checked";

    const allowed = digitsIn(allowedSource);
    for (const number of digitsIn(body)) {
        if (!allowed.has(number)) return `mentions "${number}", which is not in the resume`;
    }

    const lowerSource = allowedSource.toLowerCase();
    for (const word of body.match(NUMBER_WORDS) ?? []) {
        if (!lowerSource.includes(word.toLowerCase())) return `mentions "${word}", which is not in the resume`;
    }

    for (const noun of properNouns(body)) {
        if (!lowerSource.includes(noun.toLowerCase())) return `names "${noun}", which is not in the resume`;
    }

    return null;
}

function cleanModelOutput(raw: string): string {
    return raw
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/[*_#`]+/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ---- generation ------------------------------------------------------------------------

async function generateBody(facts: Facts, job: StoredJob, temperature: number): Promise<string> {
    const { content } = await chat({
        system: SYSTEM_PROMPT,
        user: `${factsText(facts)}\n\n${jobText(job)}\n\nWrite the two-paragraph letter body now.`,
        temperature,
        maxTokens: 400,
    });

    return cleanModelOutput(content);
}

/** "7 months", "about 2 years" */
export function describeDuration(years: number): string {
    const months = Math.round(years * 12);
    if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;

    const rounded = Math.round(months / 6) / 2;
    return `${Number.isInteger(rounded) ? rounded : `about ${rounded}`} ${rounded === 1 ? "year" : "years"}`;
}

/** Deterministic letter built from the same facts; used whenever the model cannot be trusted. */
export function templateBody(facts: Facts, job: StoredJob): string {
    const employer = job.company ?? "your organisation";
    const role = facts.recentRole?.position;
    const related = facts.relatedYears !== null && facts.relatedYears >= 0.25 ? describeDuration(facts.relatedYears) : null;

    const opening = role
        ? `I am writing to apply for the ${job.title} position at ${employer}. As ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}${facts.recentRole?.company ? ` at ${facts.recentRole.company}` : ""}, I have built practical experience that fits this role${related ? `, including ${related} of related work` : ""}.`
        : `I am writing to apply for the ${job.title} position at ${employer}, and I believe my background suits what the role requires.`;

    const strengths = [
        facts.skills.length ? `My skills include ${facts.skills.join(", ")}.` : null,
        facts.education ? `I hold ${facts.education}.` : null,
        facts.achievement ? `${facts.achievement.replace(/\.$/, "")}.` : null,
    ].filter(Boolean);

    const closing = `I would welcome the opportunity to discuss how I can contribute to ${employer}. Thank you for considering my application; my CV is attached.`;

    return [opening, strengths.join(" "), closing].filter(Boolean).join("\n\n");
}

function assemble(profile: Resume, body: string): string {
    const { fullName, email, phone } = profile.personalInfo;

    return [
        "Dear Hiring Manager,",
        body,
        ["Sincerely,", fullName, phone, email].filter(Boolean).join("\n"),
    ].join("\n\n");
}

export function buildSubject(profile: Resume, job: StoredJob): string {
    const name = profile.personalInfo.fullName;
    return `Application for ${job.title}${name ? ` - ${name}` : ""}`;
}

export async function draftCoverLetter(profile: Resume, job: StoredJob, matchedSkills: string[]): Promise<CoverLetter> {
    const facts = gatherFacts(profile, job, matchedSkills);
    const allowedSource = `${factsText(facts)}\n${jobText(job)}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const body = await generateBody(facts, job, attempt === 0 ? 0.3 : 0.6);
            const problem = validateBody(body, allowedSource);

            if (!problem) return { subject: buildSubject(profile, job), text: assemble(profile, body), writtenBy: "model" };
            console.warn(`Cover letter attempt ${attempt + 1} rejected: ${problem}`);
        } catch (error) {
            // Model down, out of keys or misconfigured: no point retrying, the template keeps the pipeline moving
            console.warn("Cover letter model unavailable:", error instanceof Error ? error.message : error);
            break;
        }
    }

    return { subject: buildSubject(profile, job), text: assemble(profile, templateBody(facts, job)), writtenBy: "template" };
}
