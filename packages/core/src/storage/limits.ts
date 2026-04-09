/**
 * Maximum file size (in bytes) that stores will accept before JSON parsing.
 * Files exceeding this limit are backed up and the store resets to empty,
 * guarding against memory exhaustion from corrupted or maliciously large files.
 */
export const MAX_STORE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
