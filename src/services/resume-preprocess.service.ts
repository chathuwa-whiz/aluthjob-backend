// CPU inference cost is proportional to prompt tokens and generated tokens, so this module
// removes everything the model does not need to see (and does not need to write) before
// the LLM call: skills are parsed deterministically and irrelevant sections are dropped.

type SectionKind = "skills" | "keep" | "drop" | "sparse";

interface Section {
    heading: string;
    kind: SectionKind;
    lines: string[];
}

export interface PreparedResume {
    /** Skills parsed straight from the text, or null when no skills section was found. */
    skills: string[] | null;
    /** Reduced text to send to the model. */
    promptText: string;
}

const HEADING_RE = /^[A-Z][A-Z &/,'-]{2,40}$/;

const SKILLS_RE = /skill|technolog|competenc|tech stack|tools/i;
const KEEP_RE = /experience|employment|career|work history|internship|education|academic|qualification|certif|licen[cs]e|award|achievement|honou?r|accomplishment|training|courses?/i;
const DROP_RE = /^(profile|summary|professional summary|objective|career objective|about( me)?|references?|referees|declaration|interests|hobbies)$/i;

// Sections like PROJECTS carry little schema data, but awards are often buried in them
const ACHIEVEMENT_LINE_RE = /\b(award|awards|place|winner|won|hackathon|champion|prize|competition|scholarship|recognition|certified|certificate|top \d+)\b/i;

const NOISE_LINE_RE = /\bpage \d+\b|^-- \d+ of \d+ --$/i;

function classify(heading: string): SectionKind | null {
    if (DROP_RE.test(heading)) return "drop";
    if (SKILLS_RE.test(heading)) return "skills";
    if (KEEP_RE.test(heading)) return "keep";
    return null;
}

function splitSections(lines: string[]): { header: string[]; sections: Section[] } {
    const header: string[] = [];
    const sections: Section[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        const isHeading = HEADING_RE.test(trimmed);
        const kind = isHeading ? classify(trimmed) : null;

        if (kind) {
            sections.push({ heading: trimmed, kind, lines: [] });
        } else if (isHeading && sections.length > 0) {
            // unrecognised heading after the first known one (PROJECTS, ADDITIONAL DELIVERY...)
            sections.push({ heading: trimmed, kind: "sparse", lines: [] });
        } else if (sections.length === 0) {
            header.push(line);
        } else {
            sections[sections.length - 1]!.lines.push(line);
        }
    }

    return { header, sections };
}

function splitTopLevel(value: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const char of value) {
        if (char === "(") depth++;
        if (char === ")") depth = Math.max(0, depth - 1);

        if (depth === 0 && /[,;|•]/.test(char)) {
            parts.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    parts.push(current);

    return parts;
}

export function parseSkills(lines: string[]): string[] {
    const groups: string[] = [];

    for (const raw of lines) {
        const line = raw.replace(/^[\s•\-*▪●]+/, "").trim();
        if (!line) continue;

        const labelled = line.match(/^[^:()]{1,40}:\s*(.*)$/);

        if (labelled) {
            groups.push(labelled[1]!);
        } else if (groups.length > 0) {
            // wrapped continuation of the previous line
            groups[groups.length - 1] += " " + line;
        } else {
            groups.push(line);
        }
    }

    const seen = new Set<string>();
    const skills: string[] = [];

    for (const part of groups.flatMap(splitTopLevel)) {
        const skill = part.replace(/\s+/g, " ").replace(/[.:]+$/, "").trim();
        const key = skill.toLowerCase();

        if (!skill || skill.length > 60 || seen.has(key)) continue;

        seen.add(key);
        skills.push(skill);
    }

    return skills;
}

function sparseExtract(lines: string[]): string[] {
    const keep = new Set<number>();

    lines.forEach((line, index) => {
        if (!ACHIEVEMENT_LINE_RE.test(line)) return;

        // neighbours cover sentences wrapped across lines
        for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i++) {
            keep.add(i);
        }
    });

    return lines.filter((_, index) => keep.has(index));
}

export function prepareResumeForExtraction(text: string): PreparedResume {
    const lines = text
        .split("\n")
        .filter((line) => !NOISE_LINE_RE.test(line.trim()));

    const { header, sections } = splitSections(lines);

    // Without recognisable structure, reducing the text risks losing data: send it all.
    const hasCoreSection = sections.some((section) => section.kind === "keep");
    if (!hasCoreSection) {
        return { skills: null, promptText: lines.join("\n").trim() };
    }

    const skillLines = sections
        .filter((section) => section.kind === "skills")
        .flatMap((section) => section.lines);

    const skills = skillLines.length > 0 ? parseSkills(skillLines) : [];

    const kept: string[] = [...header];

    const excerpts: string[] = [];

    for (const section of sections) {
        if (section.kind === "keep") kept.push(section.heading, ...section.lines);
        if (section.kind === "sparse") excerpts.push(...sparseExtract(section.lines));
    }

    // Own heading so excerpts are not mistaken for part of the preceding job or degree
    if (excerpts.length > 0) kept.push("AWARDS AND RECOGNITION (EXCERPTS)", ...excerpts);

    return {
        skills: skills.length > 0 ? skills : null,
        promptText: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    };
}
