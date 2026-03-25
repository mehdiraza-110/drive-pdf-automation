import "dotenv/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import { google } from "googleapis";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

const PORT = Number(process.env.PORT || 3001);
const FRONTEND_URL = process.env.FRONTEND_URL || "";
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
const STUDENT_ID_LABEL_REGEX =
  process.env.STUDENT_ID_LABEL_REGEX || "Std\\.?\\s*#\\s*:?";
const ID_REGEX = process.env.ID_REGEX || "\\b\\d{5,}\\b";
const TOKEN_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly"
];

// Vercel's serverless bundle can break pdf.js's runtime-relative fake worker import.
// Pre-registering the worker module lets pdf.js reuse it without importing "./pdf.worker.mjs".
if (!globalThis.pdfjsWorker) {
  globalThis.pdfjsWorker = pdfjsWorker;
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || !FRONTEND_URL || origin === FRONTEND_URL) {
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
  return FRONTEND_URL || `${getRequestOrigin(request)}/`;
}

function getStoredTokens(request) {
  return readEncryptedCookie(request, AUTH_COOKIE_NAME);
}

function storeTokens(response, tokens) {
  setEncryptedCookie(response, AUTH_COOKIE_NAME, tokens, TOKEN_COOKIE_MAX_AGE_MS);
}

function getAuthenticatedDrive(request, response) {
  const tokens = getStoredTokens(request);

  if (!tokens) {
    const error = new Error("Google Drive is not connected yet.");
    error.statusCode = 401;
    throw error;
  }

  const auth = createOAuthClient();
  auth.setCredentials(tokens);

  auth.on("tokens", (nextTokens) => {
    storeTokens(response, {
      ...tokens,
      ...nextTokens
    });
  });

  return google.drive({
    version: "v3",
    auth
  });
}

function getSharedDrive() {
  return createServiceAccountDrive();
}

function sanitizeFileName(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function stripOuterWordBoundaries(pattern) {
  return pattern.replace(/^\\b/, "").replace(/\\b$/, "");
}

async function extractTextFromPdfPage(pageBytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pageBytes),
    disableWorker: true
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();

  return content.items.map((item) => item.str).join(" ");
}

function resolveIdFromText(text, pageNumber) {
  const rawIdPattern = stripOuterWordBoundaries(ID_REGEX);
  const labeledMatcher = new RegExp(`(?:${STUDENT_ID_LABEL_REGEX})\\s*(${rawIdPattern})`, "i");
  const labeledMatch = text.match(labeledMatcher);

  if (labeledMatch?.[1]) {
    return sanitizeFileName(labeledMatch[1]);
  }

  const matcher = new RegExp(ID_REGEX, "i");
  const match = text.match(matcher);

  if (match?.[0]) {
    return sanitizeFileName(match[0]);
  }

  return `page-${String(pageNumber).padStart(3, "0")}`;
}

async function splitPdf(pdfBuffer) {
  const sourcePdf = await PDFDocument.load(pdfBuffer);
  const totalPages = sourcePdf.getPageCount();
  const pages = [];

  for (let index = 0; index < totalPages; index += 1) {
    const singlePagePdf = await PDFDocument.create();
    const [page] = await singlePagePdf.copyPages(sourcePdf, [index]);
    singlePagePdf.addPage(page);
    const pageBytes = await singlePagePdf.save();
    const pageText = await extractTextFromPdfPage(pageBytes);
    const idValue = resolveIdFromText(pageText, index + 1);

    pages.push({
      pageNumber: index + 1,
      idValue,
      pageBytes: Buffer.from(pageBytes)
    });
  }

  return {
    totalPages,
    pages
  };
}

async function uploadFileToDrive(drive, fileName, fileBuffer) {
  const response = await drive.files.create({
    requestBody: {
      name: `${fileName}.pdf`,
      parents: [GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(fileBuffer)
    },
    fields: "id, name, webViewLink"
  });

  return response.data;
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

    const drive = getAuthenticatedDrive(request, response);
    const { totalPages, pages } = await splitPdf(request.file.buffer);
    const uploadedFiles = [];
    const usedNames = new Map();

    for (const page of pages) {
      const previousCount = usedNames.get(page.idValue) || 0;
      usedNames.set(page.idValue, previousCount + 1);

      const uniqueName =
        previousCount === 0 ? page.idValue : `${page.idValue}-${previousCount + 1}`;

      const uploaded = await uploadFileToDrive(drive, uniqueName, page.pageBytes);

      uploadedFiles.push({
        fileId: uploaded.id,
        fileName: uploaded.name,
        pageNumber: page.pageNumber,
        webViewLink: uploaded.webViewLink
      });
    }

    return response.json({
      sourceName: request.file.originalname,
      totalPages,
      files: uploadedFiles
    });
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      error: error.message || "Failed to split and upload the PDF."
    });
  }
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

export default app;

export function startServer() {
  return app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

const runningThisFileDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runningThisFileDirectly && process.env.SKIP_SERVER_START !== "1") {
  startServer();
}
