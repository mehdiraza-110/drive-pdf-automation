# PDF Drive Splitter

This app gives you a two-page workflow:

- Page 1 uploads one multi-page PDF.
- The backend splits it into one-page PDFs.
- Each page is scanned for the `Std. #` value first.
- Every one-page PDF is uploaded into one Google Drive folder with that ID as the file name.
- Page 2 searches by file name and downloads the matching PDF from Drive.

## Local Run

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the OAuth consent screen.
4. Create an OAuth client ID for a web application.
5. Add this redirect URI:
   - `http://localhost:3001/api/auth/google/callback`
6. Copy `.env.example` to `.env` and fill in the values.
7. Run `npm install`.
8. Run `npm run dev`.
9. Open `http://localhost:5173`.

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
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
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

- This version uses OAuth 2.0 for a personal Google Drive account instead of a service account.
- The app first looks for a number after the `Std. #` label, then falls back to `ID_REGEX` if needed.
- Default ID matching uses `\\b\\d{5,}\\b`.
- If no ID is found on a page, the file falls back to `page-001.pdf`, `page-002.pdf`, and so on.
- Duplicate IDs are saved with a numeric suffix such as `12345-2.pdf`.
