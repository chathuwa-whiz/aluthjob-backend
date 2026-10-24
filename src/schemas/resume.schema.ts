import { z } from "zod";

const date = "Format YYYY-MM, or YYYY if the month is not given, or 'Present' if ongoing. null if absent.";

export const ResumeSchema = z.object({
    personalInfo: z.object({
        fullName: z.string().nullable().describe("The candidate's full name as written at the top of the resume."),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        location: z.string().nullable().describe("City and/or country of the candidate, e.g. 'Colombo, Sri Lanka'."),
        linkedin: z.string().nullable(),
        portfolio: z.string().nullable(),
    }),

    skills: z.array(z.string()).describe("Individual technical and professional skills, one per item, as written in the resume. No sentences."),

    education: z.array(
        z.object({
            institution: z.string().nullable(),
            degree: z.string().nullable().describe("Degree or qualification name, e.g. 'BSc in Computer Science'."),
            field: z.string().nullable().describe("Field of study."),
            startDate: z.string().nullable().describe(date),
            endDate: z.string().nullable().describe(date),
        })
    ),

    experience: z.array(
        z.object({
            company: z.string().nullable(),
            position: z.string().nullable().describe("Job title."),
            startDate: z.string().nullable().describe(date),
            endDate: z.string().nullable().describe(date),
            responsibilities: z.array(z.string()).describe("At most 3 short one-line items summarising the main duties for this job."),
        })
    ),

    certifications: z.array(z.string()),

    achievements: z.array(
        z.object({
            description: z.string().describe("One short line describing a measurable accomplishment, award or notable result."),
        })
    )
});

export type Resume = z.infer<typeof ResumeSchema>;

// What the model is asked to produce. Contact fields are extracted with regex instead:
// it is faster, always accurate, and saves output tokens on a CPU-only model.
export const ResumeExtractionSchema = ResumeSchema.extend({
    personalInfo: ResumeSchema.shape.personalInfo.pick({
        fullName: true,
        location: true,
    }),
});

export type ResumeExtraction = z.infer<typeof ResumeExtractionSchema>;

// Variant used when skills were already parsed deterministically from the resume text,
// so the model does not spend generation time copying them out.
export const ResumeExtractionWithoutSkillsSchema = ResumeExtractionSchema.omit({ skills: true });
