import express from "express";
import cors from "cors";
import helmet from "helmet";

import { ZodError, z } from "zod";
import multer from "multer";

import { allowedOrigins, originGuard, requireAdmin, requireAuth, requireVerified } from "./auth/middleware.js";
import { BadRequestError, ConfigError, EmailNotVerifiedError, ForbiddenError, NotFoundError, RuleError, TooManyRequestsError, UnauthorizedError } from "./errors.js";
import authRoutes from "./routes/auth.routes.js";
import resumeRoutes from "./routes/resume.routes.js";
import jobRoutes from "./routes/job.routes.js";
import candidateRoutes from "./routes/candidate.routes.js";
import matchRoutes from "./routes/match.routes.js";
import applicationRoutes from "./routes/application.routes.js";
import adminRoutes from "./routes/admin.routes.js";

const app = express();

// Behind a reverse proxy (nginx, Caddy) the client's address and the https scheme come from forwarded
// headers; without this every visitor would share the proxy's address and its rate limit.
// TRUST_PROXY: a number of proxy hops (usually 1), or "true". Leave unset when the API faces the internet directly.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set("trust proxy", trustProxy === "true" ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

app.use(helmet());
// Only the configured front end may call the API from a browser, and only it may send the session cookie
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins().includes(origin)), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(originGuard);

// ---- public ----------------------------------------------------------------------------
app.get("/api/v1/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/v1/auth", authRoutes); // register and login are public; the rest of that router guards itself

// ---- everything below requires a signed-in user with a confirmed email address ---------
// Default deny: this guard sits in front of every route registered after it, so a new route is
// protected unless someone deliberately moves it above this line.
app.use("/api/v1", requireAuth, requireVerified);

app.use("/api/v1/resumes", resumeRoutes);
app.use("/api/v1/jobs", jobRoutes);
app.use("/api/v1/candidates", candidateRoutes);
app.use("/api/v1/matches", matchRoutes);
app.use("/api/v1/applications", applicationRoutes);
// The administrators' console: works across accounts, so the role check sits in front of the whole router
app.use("/api/v1/admin", requireAdmin, adminRoutes);

app.use((
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
) => {
    // `code` lets a front end react (show "check your inbox") without parsing messages
    if (error instanceof UnauthorizedError) return res.status(401).json({ success: false, code: "UNAUTHENTICATED", message: error.message });
    if (error instanceof EmailNotVerifiedError) return res.status(403).json({ success: false, code: "EMAIL_NOT_VERIFIED", message: error.message });
    if (error instanceof ForbiddenError) return res.status(403).json({ success: false, code: "FORBIDDEN", message: error.message });
    if (error instanceof BadRequestError) return res.status(400).json({ success: false, message: error.message });
    if (error instanceof TooManyRequestsError) {
        return res.status(429).set("Retry-After", String(error.retryAfterSeconds)).json({ success: false, code: "RATE_LIMITED", message: error.message });
    }
    if (error instanceof NotFoundError) return res.status(404).json({ success: false, message: error.message });
    if (error instanceof ConfigError) return res.status(503).json({ success: false, message: error.message });
    if (error instanceof RuleError) return res.status(409).json({ success: false, message: error.message });
    if ((error as { type?: string }).type === "entity.parse.failed") return res.status(400).json({ success: false, message: "The request body is not valid JSON" });
    if (error instanceof ZodError) return res.status(400).json({ success: false, message: z.prettifyError(error) });
    if (error instanceof multer.MulterError) return res.status(400).json({ success: false, message: error.message });

    console.error(error);

    res.status(500).json({
        success: false,
        message: "Request failed",
    });
});

export default app;
