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

## Deploy Frontend On Vercel

This project now expects:

- Vite frontend on Vercel
- Express backend on your own server such as an Ubuntu Lightsail instance
- `VITE_API_BASE_URL` pointing the frontend at the external backend

### Vercel steps

1. Push the project to GitHub, GitLab, or Bitbucket.
2. Import the repo into Vercel.
3. In Vercel project settings, add:
   - `VITE_API_BASE_URL=https://api.your-domain.com`
4. Deploy.

## Deploy Backend On Ubuntu / Lightsail

1. Point a backend domain such as `api.your-domain.com` to your Lightsail instance.
2. Install Node.js 20+ on the instance.
3. Copy the project to the server.
4. Run `npm install`.
5. Create a production `.env` with values like these:
   - `PORT=3001`
   - `FRONTEND_URL=https://your-frontend.vercel.app`
   - `FRONTEND_URLS=https://your-frontend.vercel.app,https://your-custom-frontend-domain.com`
   - `GOOGLE_DRIVE_FOLDER_ID=...`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL=...`
   - `GOOGLE_OAUTH_CLIENT_ID=...`
   - `GOOGLE_OAUTH_CLIENT_SECRET=...`
   - `GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"`
   - `GOOGLE_OAUTH_REDIRECT_URI=https://api.your-domain.com/api/auth/google/callback`
   - `SESSION_SECRET=long-random-secret`
   - `COOKIE_SAME_SITE=none`
   - `COOKIE_SECURE=true`
   - `MAX_UPLOAD_MB=80`
6. In Google Cloud OAuth settings, add this authorized redirect URI:
   - `https://api.your-domain.com/api/auth/google/callback`
7. Start the backend with:
   - `npm start`
8. Put the Node app behind Nginx or another reverse proxy and enable HTTPS.

### Notes for cross-site auth

- The frontend already sends requests with `credentials: "include"`.
- Because Vercel and Lightsail will be on different origins, production cookies should use `COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true`.
- `FRONTEND_URLS` can contain a comma-separated allowlist if you want both your Vercel domain and your custom frontend domain to work.
- If you keep only one frontend origin, setting `FRONTEND_URL` alone is enough.

### Optional backend env vars

- `AUTH_COOKIE_NAME`
- `OAUTH_STATE_COOKIE_NAME`
- `STUDENT_ID_LABEL_REGEX`
- `ID_REGEX`

## Notes

- Upload uses OAuth 2.0, while search and download use a shared service account that must have access to the target folder.
- Upload processing happens on the backend server, so it is no longer limited by Vercel Function request size.
- The app first looks for a number after the `Std. #` label, then falls back to `ID_REGEX` if needed.
- Default ID matching uses `\\b\\d{5,}\\b`.
- If no ID is found on a page, the file falls back to `page-001.pdf`, `page-002.pdf`, and so on.
- Duplicate IDs are saved with a numeric suffix such as `12345-2.pdf`.
