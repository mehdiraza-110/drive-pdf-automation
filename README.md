# NGS Voucher

This app gives you a two-page workflow:

- Page 1 uploads one multi-page PDF.
- The backend splits it into one-page PDFs.
- Each page is scanned for the `Std. #` value first.
- Every one-page PDF is uploaded into one Google Drive folder with that ID as the file name.
- Page 2 searches by file name and downloads the matching PDF from that shared folder without requiring Google login.

## Local Run

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Create a service account and generate a JSON key.
4. Share the destination Google Drive folder with the service account email so it can search and download files.
5. Configure the OAuth consent screen.
6. Create an OAuth client ID for a web application.
7. Add this redirect URI:
   - `http://localhost:3001/api/auth/google/callback`
8. Copy `.env.example` to `.env` and fill in the values, including the service account email and private key.
9. Run `npm install`.
10. Run `npm run dev`.
11. Open `http://localhost:5173`.

## Deploy On Vercel

This project is prepared for a single Vercel deployment:

- Vite frontend served from the main site
- Express backend served through `/api/index.js`
- Google OAuth stored in encrypted HTTP-only cookies so it works with Vercel Functions

### Vercel steps

1. Push the project to GitHub, GitLab, or Bitbucket.
2. Import the repo into Vercel.
3. In Vercel project settings, add these environment variables:
   - `GOOGLE_DRIVE_FOLDER_ID`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_PRIVATE_KEY`
   - `GOOGLE_OAUTH_REDIRECT_URI`
   - `SESSION_SECRET`
   - `COOKIE_SECURE=true`
4. Set `GOOGLE_OAUTH_REDIRECT_URI` to:
   - `https://your-project-name.vercel.app/api/auth/google/callback`
5. In Google Cloud OAuth settings, add that same production callback URL.
6. Deploy.

### Optional Vercel env vars

- `FRONTEND_URL`
- `VITE_API_BASE_URL`
- `AUTH_COOKIE_NAME`
- `OAUTH_STATE_COOKIE_NAME`
- `COOKIE_SAME_SITE`
- `STUDENT_ID_LABEL_REGEX`
- `ID_REGEX`

For a normal single-domain Vercel deploy, you usually do not need `FRONTEND_URL` or `VITE_API_BASE_URL`.

## Notes

- Upload uses OAuth 2.0, while search and download use a shared service account that must have access to the target folder.
- The app first looks for a number after the `Std. #` label, then falls back to `ID_REGEX` if needed.
- Default ID matching uses `\\b\\d{5,}\\b`.
- If no ID is found on a page, the file falls back to `page-001.pdf`, `page-002.pdf`, and so on.
- Duplicate IDs are saved with a numeric suffix such as `12345-2.pdf`.
