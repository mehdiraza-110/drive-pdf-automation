import "dotenv/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import { google } from "googleapis";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 80);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const FRONTEND_ORIGINS = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3010);
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-env";
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "drive_tokens";
const OAUTH_STATE_COOKIE_NAME = process.env.OAUTH_STATE_COOKIE_NAME || "oauth_state";
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || "lax";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const TOKEN_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15 * 60 * 1000);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 16 * 60 * 1000);
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75 * 1000);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 6 * 60 * 60 * 1000);
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(process.cwd(), "runtime");
const UPLOADS_DIR = path.join(RUNTIME_DIR, "uploads");
const DRIVE_UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.DRIVE_UPLOAD_CONCURRENCY || 6));
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly"
];
const uploadJobs = new Map();

mkdirSync(UPLOADS_DIR, {
  recursive: true
});

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      callback(null, UPLOADS_DIR);
    },
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname || ".pdf") || ".pdf";
      callback(null, `${Date.now()}-${randomBytes(8).toString("hex")}${extension}`);
    }
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES
  }
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || FRONTEND_ORIGINS.length === 0 || FRONTEND_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS origin not allowed."));
    },
    credentials: true
  })
);
app.use(express.json());
app.set("trust proxy", 1);

function assertOAuthConfig() {
  if (
    !GOOGLE_DRIVE_FOLDER_ID ||
    !GOOGLE_OAUTH_CLIENT_ID ||
    !GOOGLE_OAUTH_CLIENT_SECRET ||
    !GOOGLE_OAUTH_REDIRECT_URI ||
    !SESSION_SECRET
  ) {
    throw new Error("Google OAuth environment variables are not fully configured.");
  }
}

function assertServiceAccountConfig() {
  if (!GOOGLE_DRIVE_FOLDER_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    throw new Error("Google service account environment variables are not fully configured.");
  }
}

function createOAuthClient() {
  assertOAuthConfig();

  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI
  );
}

function createServiceAccountDrive() {
  assertServiceAccountConfig();

  const auth = new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  return google.drive({
    version: "v3",
    auth
  });
}

function getCookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: "/",
    maxAge
  };
}

function createEncryptionKey() {
  return createHash("sha256").update(SESSION_SECRET).digest();
}

function encodePayload(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decodePayload(value) {
  if (!value) {
    return null;
  }

  try {
    const [ivPart, tagPart, dataPart] = value.split(".");

    if (!ivPart || !tagPart || !dataPart) {
      return null;
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      createEncryptionKey(),
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const header = request.headers.cookie;

  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header.split(";").map((entry) => {
      const separatorIndex = entry.indexOf("=");
      const rawName = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
      const rawValue = separatorIndex === -1 ? "" : entry.slice(separatorIndex + 1);

      return [rawName.trim(), decodeURIComponent(rawValue.trim())];
    })
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  parts.push(`Path=${options.path || "/"}`);

  return parts.join("; ");
}

function appendSetCookie(response, cookieValue) {
  const currentValue = response.getHeader("Set-Cookie");

  if (!currentValue) {
    response.setHeader("Set-Cookie", cookieValue);
    return;
  }

  const nextValues = Array.isArray(currentValue)
    ? [...currentValue, cookieValue]
    : [currentValue, cookieValue];
  response.setHeader("Set-Cookie", nextValues);
}

function setEncryptedCookie(response, name, payload, maxAge) {
  appendSetCookie(
    response,
    serializeCookie(name, encodePayload(payload), getCookieOptions(maxAge))
  );
}

function clearCookie(response, name) {
  appendSetCookie(
    response,
    serializeCookie(name, "", {
      ...getCookieOptions(0),
      maxAge: 0
    })
  );
}

function readEncryptedCookie(request, name) {
  const cookies = parseCookies(request);
  return decodePayload(cookies[name]);
}

function getRequestOrigin(request) {
  const protocolHeader = request.headers["x-forwarded-proto"];
  const hostHeader = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : String(protocolHeader || request.protocol || "http").split(",")[0].trim();

  return `${protocol}://${hostHeader}`;
}

function getDefaultReturnTo(request) {
  return FRONTEND_ORIGINS[0] || `${getRequestOrigin(request)}/`;
}

function getStoredTokens(request) {
  return readEncryptedCookie(request, AUTH_COOKIE_NAME);
}

function storeTokens(response, tokens) {
  setEncryptedCookie(response, AUTH_COOKIE_NAME, tokens, TOKEN_COOKIE_MAX_AGE_MS);
}

function getSharedDrive() {
  return createServiceAccountDrive();
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFileByName(drive, fileName) {
  const response = await drive.files.list({
    q: [
      `'${GOOGLE_DRIVE_FOLDER_ID}' in parents`,
      "trashed = false",
      `name = '${escapeDriveQuery(fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`)}'`
    ].join(" and "),
    fields: "files(id, name, webViewLink, createdTime)",
    orderBy: "createdTime desc",
    pageSize: 1
  });

  return response.data.files?.[0] || null;
}

async function countFilesInFolder(drive) {
  let totalCount = 0;
  let pageToken;

  do {
    const response = await drive.files.list({
      q: [`'${GOOGLE_DRIVE_FOLDER_ID}' in parents`, "trashed = false"].join(" and "),
      fields: "nextPageToken, files(id)",
      pageSize: 1000,
      pageToken
    });

    totalCount += response.data.files?.length || 0;
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return totalCount;
}

function getAuthStatus(request) {
  const tokens = getStoredTokens(request);

  return {
    isAuthenticated: Boolean(tokens),
    hasRefreshToken: Boolean(tokens?.refresh_token)
  };
}

function createUploadJob(fileName, filePath) {
  const id = randomBytes(12).toString("hex");
  const job = {
    id,
    status: "queued",
    sourceName: fileName,
    sourcePath: filePath,
    totalPages: null,
    processedPages: 0,
    uploadedFiles: [],
    error: "",
    progressMessage: "Waiting to start upload processing...",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pendingTokens: null,
    workerPid: null
  };

  uploadJobs.set(id, job);
  cleanupExpiredJobs();
  return job;
}

function touchJob(job, patch = {}) {
  Object.assign(job, patch, {
    updatedAt: Date.now()
  });
}

function cleanupExpiredJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;

  for (const [jobId, job] of uploadJobs.entries()) {
    if (job.updatedAt < cutoff && job.status !== "processing" && job.status !== "queued") {
      uploadJobs.delete(jobId);
    }
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    sourceName: job.sourceName,
    totalPages: job.totalPages,
    processedPages: job.processedPages,
    files: job.uploadedFiles,
    error: job.error,
    progressMessage: job.progressMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function startUploadJob(job, tokens) {
  const workerPath = path.join(process.cwd(), "server", "upload-worker.js");
  const child = fork(workerPath, {
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });

  touchJob(job, {
    workerPid: child.pid,
    progressMessage: `Upload accepted. Starting worker with concurrency ${DRIVE_UPLOAD_CONCURRENCY}...`
  });

  child.on("message", (message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "progress") {
      touchJob(job, {
        status: "processing",
        totalPages: message.totalPages ?? job.totalPages,
        processedPages: message.processedPages ?? job.processedPages,
        progressMessage: message.progressMessage || job.progressMessage
      });
      return;
    }

    if (message.type === "fileUploaded") {
      job.uploadedFiles.push(message.file);
      touchJob(job, {
        status: "processing",
        totalPages: message.totalPages ?? job.totalPages,
        processedPages: message.processedPages ?? job.processedPages,
        progressMessage: message.progressMessage || job.progressMessage
      });
      return;
    }

    if (message.type === "tokens") {
      touchJob(job, {
        pendingTokens: message.tokens
      });
      return;
    }

    if (message.type === "completed") {
      touchJob(job, {
        status: "completed",
        totalPages: message.totalPages ?? job.totalPages,
        processedPages: message.processedPages ?? job.processedPages,
        progressMessage: message.progressMessage || job.progressMessage,
        workerPid: null
      });
      return;
    }

    if (message.type === "failed") {
      touchJob(job, {
        status: "failed",
        error: message.error || "Upload processing failed.",
        progressMessage: "Upload processing failed.",
        workerPid: null
      });
    }
  });

  child.on("exit", async (code, signal) => {
    if (job.status === "completed" || job.status === "failed") {
      return;
    }

    await fs.unlink(job.sourcePath).catch(() => {});
    touchJob(job, {
      status: "failed",
      error: `Upload worker stopped unexpectedly (code ${code ?? "unknown"}, signal ${signal || "none"}).`,
      progressMessage: "Upload worker stopped unexpectedly.",
      workerPid: null
    });
  });

  child.send({
    type: "start",
    job: {
      id: job.id,
      sourceName: job.sourceName,
      filePath: job.sourcePath,
      tokens
    }
  });
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/status", (request, response) => {
  response.json(getAuthStatus(request));
});

app.get("/api/auth/google", (request, response) => {
  const auth = createOAuthClient();
  const state = randomBytes(18).toString("base64url");
  const returnTo =
    typeof request.query.returnTo === "string" ? request.query.returnTo : getDefaultReturnTo(request);

  setEncryptedCookie(
    response,
    OAUTH_STATE_COOKIE_NAME,
    {
      state,
      returnTo
    },
    STATE_COOKIE_MAX_AGE_MS
  );

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state
  });

  response.redirect(authUrl);
});

app.get("/api/auth/google/callback", async (request, response) => {
  try {
    const auth = createOAuthClient();
    const { code, state } = request.query;
    const storedState = readEncryptedCookie(request, OAUTH_STATE_COOKIE_NAME);

    clearCookie(response, OAUTH_STATE_COOKIE_NAME);

    if (!code || typeof code !== "string") {
      return response.status(400).send("Missing Google OAuth code.");
    }

    if (!state || typeof state !== "string" || state !== storedState?.state) {
      return response.status(400).send("Invalid OAuth state.");
    }

    const { tokens } = await auth.getToken(code);
    storeTokens(response, tokens);

    return response.redirect(storedState.returnTo || getDefaultReturnTo(request));
  } catch (error) {
    return response.status(500).send(error.message || "Google OAuth callback failed.");
  }
});

app.post("/api/auth/logout", (_request, response) => {
  clearCookie(response, AUTH_COOKIE_NAME);
  clearCookie(response, OAUTH_STATE_COOKIE_NAME);
  response.json({ ok: true });
});

app.post("/api/upload-split", upload.single("pdf"), async (request, response) => {
  try {
    if (!request.file) {
      return response.status(400).json({ error: "No PDF file was uploaded." });
    }

    if (!request.file.path) {
      return response.status(500).json({ error: "Uploaded PDF could not be stored on the server." });
    }

    const tokens = getStoredTokens(request);

    if (!tokens) {
      return response.status(401).json({ error: "Google Drive is not connected yet." });
    }

    const job = createUploadJob(request.file.originalname, request.file.path);
    startUploadJob(job, tokens);

    return response.status(202).json({
      job: serializeJob(job)
    });
  } catch (error) {
    if (request.file?.path) {
      await fs.unlink(request.file.path).catch(() => {});
    }

    return response.status(error.statusCode || 500).json({
      error: error.message || "Failed to split and upload the PDF."
    });
  }
});

app.get("/api/upload-jobs/:jobId", (request, response) => {
  const tokens = getStoredTokens(request);

  if (!tokens) {
    return response.status(401).json({ error: "Google Drive is not connected yet." });
  }

  cleanupExpiredJobs();

  const job = uploadJobs.get(request.params.jobId);

  if (!job) {
    return response.status(404).json({ error: "Upload job not found." });
  }

  if (job.pendingTokens) {
    storeTokens(response, job.pendingTokens);
    touchJob(job, {
      pendingTokens: null
    });
  }

  return response.json({
    job: serializeJob(job)
  });
});

app.get("/api/admin/folder-stats", async (_request, response) => {
  try {
    const drive = getSharedDrive();
    const fileCount = await countFilesInFolder(drive);

    return response.json({ fileCount });
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      error: error.message || "Failed to load folder stats."
    });
  }
});

app.get("/api/files/:name", async (request, response) => {
  try {
    const drive = getSharedDrive();
    const file = await findFileByName(drive, request.params.name);

    if (!file) {
      return response.status(404).json({ error: "No matching PDF was found in Google Drive." });
    }

    return response.json({ file });
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      error: error.message || "Failed to search Google Drive."
    });
  }
});

app.get("/api/files/:id/download", async (request, response) => {
  try {
    const drive = getSharedDrive();
    const metadata = await drive.files.get({
      fileId: request.params.id,
      fields: "name"
    });

    const driveResponse = await drive.files.get(
      {
        fileId: request.params.id,
        alt: "media"
      },
      {
        responseType: "stream"
      }
    );

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${metadata.data.name || "download.pdf"}"`
    );

    driveResponse.data.on("error", () => {
      response.status(500).end("Download stream failed.");
    });

    driveResponse.data.pipe(response);
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      error: error.message || "Failed to download the PDF."
    });
  }
});

app.use((error, _request, response, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({
      error: `Uploaded PDF exceeds the ${MAX_UPLOAD_MB} MB limit.`
    });
  }

  if (error?.message === "CORS origin not allowed.") {
    return response.status(403).json({
      error: error.message
    });
  }

  return next(error);
});

export default app;

export function startServer() {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return server;
}

const runningThisFileDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runningThisFileDirectly && process.env.SKIP_SERVER_START !== "1") {
  startServer();
}
