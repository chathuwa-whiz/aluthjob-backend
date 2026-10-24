import multure from "multer";

export const uploadResume = multure({
    storage: multure.memoryStorage(),

    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 1, // Only one file allowed
    },

    fileFilter: (_req, file, callback) => {
        const allowed = [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ];

        if (!allowed.includes(file.mimetype)) {
            return callback(
                new Error("Only PDF and Word documents are allowed."),
            )
        }

        callback(null, true);
    }
})