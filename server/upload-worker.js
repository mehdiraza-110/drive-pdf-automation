import "dotenv/config";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { PDFDocument } from "pdf-lib";
import { promises as fs } from "node:fs";

const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";
const STUDENT_ID_LABEL_REGEX = process.env.STUDENT_ID_LABEL_REGEX || "Std\\.?\\s*#\\s*:?";
const ID_REGEX = process.env.ID_REGEX || "\\b\\d{5,}\\b";
const DRIVE_UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.DRIVE_UPLOAD_CONCURRENCY || 6));

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function sanitizeFileName(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function stripOuterWordBoundaries(pattern) {
  return pattern.replace(/^\\b/, "").replace(/\\b$/, "");
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

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI
  );
}

function createAuthenticatedDrive(tokens, onTokens) {
  const auth = createOAuthClient();
  auth.setCredentials(tokens);

  if (onTokens) {
    auth.on("tokens", (nextTokens) => {
      onTokens({
        ...tokens,
        ...nextTokens
      });
    });
  }

  return google.drive({
    version: "v3",
    auth
  });
}

async function extractTextFromPdfPage(pageBytes) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pageBytes),
    disableWorker: true
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();

  return content.items.map((item) => item.str).join(" ");
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

function createLimiter(limit) {
  let activeCount = 0;
  const queue = [];

  function runNext() {
    if (activeCount >= limit || queue.length === 0) {
      return;
    }

    activeCount += 1;
    const { task, resolve, reject } = queue.shift();

    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        activeCount -= 1;
        runNext();
      });
  }

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
}

async function processJob(job) {
  const fileBuffer = await fs.readFile(job.filePath);
  const sourcePdf = await PDFDocument.load(fileBuffer);
  const totalPages = sourcePdf.getPageCount();
  const usedNames = new Map();
  const limit = createLimiter(DRIVE_UPLOAD_CONCURRENCY);
  let uploadedCount = 0;

  send({
    type: "progress",
    totalPages,
    progressMessage: `Preparing ${totalPages} pages for upload...`
  });

  const drive = createAuthenticatedDrive(job.tokens, (nextTokens) => {
    send({
      type: "tokens",
      tokens: nextTokens
    });
  });

  const tasks = [];

  for (let index = 0; index < totalPages; index += 1) {
    const singlePagePdf = await PDFDocument.create();
    const [page] = await singlePagePdf.copyPages(sourcePdf, [index]);
    singlePagePdf.addPage(page);
    const pageBytes = Buffer.from(await singlePagePdf.save());
    const pageText = await extractTextFromPdfPage(pageBytes);
    const idValue = resolveIdFromText(pageText, index + 1);
    const previousCount = usedNames.get(idValue) || 0;
    usedNames.set(idValue, previousCount + 1);

    const uniqueName = previousCount === 0 ? idValue : `${idValue}-${previousCount + 1}`;
    const pageNumber = index + 1;

    send({
      type: "progress",
      totalPages,
      processedPages: uploadedCount,
      progressMessage: `Prepared page ${pageNumber} of ${totalPages}. Uploading with ${DRIVE_UPLOAD_CONCURRENCY} workers...`
    });

    tasks.push(
      limit(async () => {
        const uploaded = await uploadFileToDrive(drive, uniqueName, pageBytes);
        uploadedCount += 1;

        send({
          type: "fileUploaded",
          totalPages,
          processedPages: uploadedCount,
          file: {
            fileId: uploaded.id,
            fileName: uploaded.name,
            pageNumber,
            webViewLink: uploaded.webViewLink
          },
          progressMessage: `Uploaded ${uploadedCount} of ${totalPages} pages to Google Drive...`
        });
      })
    );
  }

  await Promise.all(tasks);

  send({
    type: "completed",
    totalPages,
    processedPages: uploadedCount,
    progressMessage: `Completed ${uploadedCount} uploads successfully.`
  });
}

process.on("message", async (message) => {
  if (message?.type !== "start") {
    return;
  }

  try {
    await processJob(message.job);
    await fs.unlink(message.job.filePath).catch(() => {});
    process.exit(0);
  } catch (error) {
    await fs.unlink(message.job.filePath).catch(() => {});
    send({
      type: "failed",
      error: error.message || "Failed to split and upload the PDF."
    });
    process.exit(1);
  }
});
