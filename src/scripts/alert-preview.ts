import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAlertMail, LOGO_CID, type AlertJob } from "../alerts/alert-email.js";
import { linksFor } from "../alerts/alert.service.js";

// usage: npm run alerts:preview [-- --weekly] [--more=7] [--out=data/alert-preview.html]
// Renders the job-alert email with sample jobs to a file you can open in a browser. Sends nothing, touches no database.
const flags = process.argv.slice(2);
const flag = (name: string) => flags.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

process.env.MAIL_SECRET ??= "preview-only-secret-preview-only-secret";

const day = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * day).toISOString();

const jobs: AlertJob[] = [
    {
        matchId: 101,
        title: "Software Engineer (React / Node.js)",
        company: "Lanka Digital Solutions",
        location: "Colombo 03",
        score: 91,
        jobType: "Full time",
        salary: "LKR 180,000 - 260,000",
        closingAt: inDays(2),
        reasons: ["Asks for 5 of your skills, including React, TypeScript and Node.js", "Title is close to your last role"],
        matchedSkills: ["React", "TypeScript", "Node.js", "REST APIs", "Git"],
        warnings: [],
        applyMethod: "email",
    },
    {
        matchId: 102,
        title: "Full Stack Developer",
        company: "Ceylon Commerce (Pvt) Ltd",
        location: "Remote (Sri Lanka)",
        score: 74,
        jobType: "Contract",
        salary: null,
        closingAt: inDays(9),
        reasons: ["Remote role; you listed Node.js and MongoDB"],
        matchedSkills: ["Node.js", "MongoDB", "JavaScript"],
        warnings: ["Asks for 4+ years of experience; your CV shows about 3"],
        applyMethod: "portal",
    },
    {
        matchId: 103,
        title: "Associate Software Engineer, Trainee Programme for Recent Graduates in Computer Science and Related Fields",
        company: null,
        location: "Kandy",
        score: 62,
        jobType: null,
        salary: null,
        closingAt: null,
        reasons: ["Matches your degree and 3 of your skills"],
        matchedSkills: ["Java", "SQL", "Spring Boot"],
        warnings: [],
        applyMethod: "email",
    },
];

const input = {
    to: "nimal@example.com",
    firstName: "Nimal",
    jobs,
    moreCount: Number(flag("more") ?? 4),
    frequency: flags.includes("--weekly") ? ("weekly" as const) : ("daily" as const),
    links: linksFor(42),
    logo: true,
};

const logoPath = resolve(process.cwd(), "assets", "aluthjob-logo.png");
const mail = buildAlertMail(input, logoPath);

// In a browser there is no attachment to resolve cid: against, so the preview inlines the image
const logo = existsSync(logoPath) ? `data:image/png;base64,${readFileSync(logoPath).toString("base64")}` : "";
const html = mail.html!.replaceAll(`cid:${LOGO_CID}`, logo);

const out = resolve(flag("out") ?? "data/alert-preview.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
writeFileSync(out.replace(/\.html$/, ".txt"), `Subject: ${mail.subject}\n\n${mail.text}\n`);

console.log(`Subject: ${mail.subject}\nHTML:  ${out}\nText:  ${out.replace(/\.html$/, ".txt")}`);
