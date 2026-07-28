import multer from "multer";

const MIB = 1024 * 1024;

export const MEMORY_UPLOAD_LIMITS = Object.freeze({
  scoreImport: Object.freeze({
    fileSize: 40 * MIB,
    fieldSize: 64 * 1024,
    fieldNameSize: 100,
    fields: 6,
    files: 1,
    // Busboy emits partsLimit when the counter reaches the configured value,
    // so one spare slot is required for the valid 6-field + 1-file contract.
    parts: 8,
    headerPairs: 100,
  }),
  analysisAudio: Object.freeze({
    fileSize: 40 * MIB,
    fieldSize: 14 * MIB,
    fieldNameSize: 100,
    fields: 1,
    files: 1,
    parts: 3,
    headerPairs: 100,
  }),
  westernStudent: Object.freeze({
    fileSize: 40 * MIB,
    fieldSize: 14 * MIB,
    fieldNameSize: 100,
    fields: 1,
    files: 2,
    parts: 4,
    headerPairs: 100,
  }),
});

function createMemoryUpload(limits) {
  return multer({
    storage: multer.memoryStorage(),
    limits,
  });
}

export function createMemoryUploadProfiles() {
  return {
    scoreImport: createMemoryUpload(MEMORY_UPLOAD_LIMITS.scoreImport),
    analysisAudio: createMemoryUpload(MEMORY_UPLOAD_LIMITS.analysisAudio),
    westernStudent: createMemoryUpload(MEMORY_UPLOAD_LIMITS.westernStudent),
  };
}

export function uploadErrorHandler(error, req, res, next) {
  if (error?.name !== "MulterError") return next(error);
  const statusCode = error.code === "LIMIT_UNEXPECTED_FILE" ? 400 : 413;
  return res.status(statusCode).json({
    ok: false,
    error: statusCode === 413
      ? "The multipart request exceeds the configured upload limits."
      : "The multipart request contains an unexpected file field.",
  });
}
