import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const LAST_UPDATED = "March 18, 2026";

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function useAuth() {
  const [auth, setAuth] = useState({
    isAuthenticated: false,
    hasRefreshToken: false,
    loading: true
  });

  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/status`, {
          credentials: "include"
        });
        const data = await parseJsonResponse(response);

        if (!cancelled) {
          setAuth({
            ...data,
            loading: false
          });
        }
      } catch (_error) {
        if (!cancelled) {
          setAuth({
            isAuthenticated: false,
            hasRefreshToken: false,
            loading: false
          });
        }
      }
    }

    loadAuthStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  return [auth, setAuth];
}

function Shell({ auth, setAuth, children, showAppNavigation = true }) {
  const location = useLocation();

  function handleConnect() {
    const returnTo = encodeURIComponent(`${window.location.origin}${location.pathname}`);
    window.location.href = `${API_BASE_URL}/api/auth/google?returnTo=${returnTo}`;
  }

  async function handleLogout() {
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include"
    });

    setAuth({
      isAuthenticated: false,
      hasRefreshToken: false,
      loading: false
    });
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero__content">
          <p className="eyebrow">PDF + Google Drive Workflow</p>
          <h1>Split large PDFs, auto-name each page, and pull them back by file name.</h1>
          <p className="hero__text">
            Connect your Google account once, upload a multi-page PDF, save every page into
            your Drive folder, then search and download each saved PDF from the second page.
          </p>
        </div>

        <div className="auth-banner">
          <div>
            <p className="result-card__label">Google Drive Connection</p>
            <h2>{auth.isAuthenticated ? "Connected" : "Not connected yet"}</h2>
            <p>
              {auth.isAuthenticated
                ? "This browser session can upload to and read from your selected Drive folder."
                : "Connect your Google account before uploading or searching."}
            </p>
          </div>

          <div className="auth-banner__actions">
            {auth.isAuthenticated ? (
              <button className="action-button action-button--secondary" onClick={handleLogout}>
                Disconnect
              </button>
            ) : (
              <button className="action-button" onClick={handleConnect}>
                Connect Google Drive
              </button>
            )}
          </div>
        </div>

        <nav className="tabs" aria-label="Pages">
          {showAppNavigation ? (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
                Upload & Split
              </NavLink>
              <NavLink to="/search" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
                Search & Download
              </NavLink>
            </>
          ) : null}
          <NavLink to="/privacy-policy" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            Privacy Policy
          </NavLink>
          <NavLink to="/terms-of-service" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            Terms of Service
          </NavLink>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <p>Use of this app is subject to the published policy pages below.</p>
        <div className="site-footer__links">
          <NavLink to="/privacy-policy">Privacy Policy</NavLink>
          <NavLink to="/terms-of-service">Terms of Service</NavLink>
        </div>
      </footer>
    </div>
  );
}

function AuthRequired({ auth, children }) {
  if (auth.loading) {
    return (
      <div className="empty-state">
        <p>Checking Google Drive connection...</p>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="empty-state">
        <p>Connect Google Drive first to use this page.</p>
      </div>
    );
  }

  return children;
}

function UploadPage({ auth, setAuth }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!file) {
      setError("Choose a PDF before uploading.");
      return;
    }

    setLoading(true);
    setError("");
    setResults([]);
    setSummary(null);

    try {
      const formData = new FormData();
      formData.append("pdf", file);

      const response = await fetch(`${API_BASE_URL}/api/upload-split`, {
        method: "POST",
        body: formData,
        credentials: "include"
      });
      const data = await parseJsonResponse(response);

      setResults(data.files);
      setSummary({
        sourceName: data.sourceName,
        totalPages: data.totalPages
      });
    } catch (uploadError) {
      if (uploadError.message.includes("not connected")) {
        setAuth((current) => ({
          ...current,
          isAuthenticated: false
        }));
      }
      setError(uploadError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell auth={auth} setAuth={setAuth}>
      <section className="panel">
        <div className="panel__intro">
          <h2>Upload one PDF</h2>
          <p>
            Each page is split into its own PDF. The backend reads page text, extracts an ID,
            and saves that page into your Google Drive folder with the ID as the file name.
          </p>
        </div>

        <AuthRequired auth={auth}>
          <form className="upload-form" onSubmit={handleSubmit}>
            <label className="file-input">
              <span>Choose PDF</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>

            <button className="action-button" type="submit" disabled={loading}>
              {loading ? "Uploading..." : "Upload, Split, and Save"}
            </button>
          </form>

          {file ? <p className="info-line">Selected file: {file.name}</p> : null}
          {error ? <p className="error-line">{error}</p> : null}

          {summary ? (
            <div className="summary-card">
              <p>Source PDF: {summary.sourceName}</p>
              <p>Total pages processed: {summary.totalPages}</p>
              <p>Saved files: {results.length}</p>
            </div>
          ) : null}

          {results.length > 0 ? (
            <div className="results-grid">
              {results.map((result) => (
                <article className="result-card" key={result.fileId}>
                  <p className="result-card__label">Saved As</p>
                  <h3>{result.fileName}</h3>
                  <p>Page {result.pageNumber}</p>
                  <a href={result.webViewLink} target="_blank" rel="noreferrer">
                    Open in Drive
                  </a>
                </article>
              ))}
            </div>
          ) : null}
        </AuthRequired>
      </section>
    </Shell>
  );
}

function SearchPage({ auth, setAuth }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function handleSearch(event) {
    event.preventDefault();

    if (!query.trim()) {
      setError("Enter a PDF file name.");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/files/${encodeURIComponent(query.trim())}`,
        {
          credentials: "include"
        }
      );
      const data = await parseJsonResponse(response);

      setResult(data.file);
    } catch (searchError) {
      if (searchError.message.includes("not connected")) {
        setAuth((current) => ({
          ...current,
          isAuthenticated: false
        }));
      }
      setError(searchError.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!result) {
      return;
    }

    window.open(`${API_BASE_URL}/api/files/${result.id}/download`, "_blank", "noopener,noreferrer");
  }

  return (
    <Shell auth={auth} setAuth={setAuth}>
      <section className="panel">
        <div className="panel__intro">
          <h2>Search by file name</h2>
          <p>
            Enter the PDF name exactly as saved in Drive, without browsing the folder manually.
          </p>
        </div>

        <AuthRequired auth={auth}>
          <form className="search-form" onSubmit={handleSearch}>
            <input
              type="text"
              placeholder="Example: 123456789"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="action-button" type="submit" disabled={loading}>
              {loading ? "Searching..." : "Search"}
            </button>
          </form>

          {error ? <p className="error-line">{error}</p> : null}

          {result ? (
            <div className="search-result">
              <div>
                <p className="result-card__label">Match Found</p>
                <h3>{result.name}</h3>
                <p>Google Drive file ID: {result.id}</p>
              </div>
              <div className="search-result__actions">
                <a href={result.webViewLink} target="_blank" rel="noreferrer">
                  View in Drive
                </a>
                <button className="action-button action-button--secondary" onClick={handleDownload}>
                  Download
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p>Search results will appear here.</p>
            </div>
          )}
        </AuthRequired>
      </section>
    </Shell>
  );
}

function PolicyLayout({ auth, setAuth, title, summary, children }) {
  return (
    <Shell auth={auth} setAuth={setAuth} showAppNavigation={false}>
      <section className="panel legal-panel">
        <div className="panel__intro">
          <p className="eyebrow">Legal</p>
          <h2>{title}</h2>
          <p>{summary}</p>
          <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
        </div>
        <div className="legal-copy">{children}</div>
      </section>
    </Shell>
  );
}

function PrivacyPolicyPage({ auth, setAuth }) {
  return (
    <PolicyLayout
      auth={auth}
      setAuth={setAuth}
      title="Privacy Policy"
      summary="This page explains what data this app accesses, how it uses Google Drive data, and what happens to uploaded PDFs."
    >
      <section>
        <h3>Information We Access</h3>
        <p>
          When you connect your Google account, this app receives Google OAuth tokens that allow
          it to access the Google Drive folder you choose to use with the app.
        </p>
        <p>
          When you upload a PDF, the app reads the file content to split the document into
          separate pages and extract the student identifier used for naming each page.
        </p>
      </section>

      <section>
        <h3>How We Use Your Data</h3>
        <p>
          Your data is used only to authenticate you with Google Drive, split uploaded PDFs,
          name the resulting files, upload them to your selected Drive folder, search for saved
          files, and download files back to you on request.
        </p>
        <p>
          The app does not use your Google Drive data for advertising, profiling, resale, or any
          unrelated analytics purpose.
        </p>
      </section>

      <section>
        <h3>Storage and Retention</h3>
        <p>
          Uploaded PDFs and generated page PDFs are stored in your own Google Drive folder.
          Authentication data is stored in secure HTTP-only cookies to maintain your signed-in
          session.
        </p>
        <p>
          The app is designed to process files for the requested workflow and does not maintain a
          separate permanent database of your PDF content.
        </p>
      </section>

      <section>
        <h3>Google User Data</h3>
        <p>
          Access to Google user data is limited to the functionality required to upload, locate,
          and download files in Google Drive. The app requests Google Drive permissions only so it
          can perform these user-initiated actions.
        </p>
      </section>

      <section>
        <h3>Your Choices</h3>
        <p>
          You may stop using the app at any time, disconnect your account from the app interface,
          remove uploaded files from your Google Drive folder, or revoke the app&apos;s access from
          your Google Account permissions page.
        </p>
      </section>

      <section>
        <h3>Contact</h3>
        <p>
          If you publish this app publicly, replace this paragraph with your business or support
          email so users and Google reviewers have a clear contact method.
        </p>
      </section>
    </PolicyLayout>
  );
}

function TermsOfServicePage({ auth, setAuth }) {
  return (
    <PolicyLayout
      auth={auth}
      setAuth={setAuth}
      title="Terms of Service"
      summary="These terms describe the acceptable use of the PDF Drive Splitter application."
    >
      <section>
        <h3>Use of the Service</h3>
        <p>
          This application is provided to let you upload PDFs, split them into separate pages,
          name the generated PDFs using extracted identifiers, store them in your Google Drive,
          and search or download those stored files.
        </p>
      </section>

      <section>
        <h3>Your Responsibilities</h3>
        <p>
          You are responsible for the files you upload, the legality of the content, and your use
          of any student, personal, or confidential information contained in those PDFs.
        </p>
        <p>
          You must use the service only for lawful purposes and only with files and Google Drive
          content you are authorized to access and manage.
        </p>
      </section>

      <section>
        <h3>Google Account Access</h3>
        <p>
          By connecting your Google account, you authorize the app to perform the Google
          Drive-related actions required for the workflow you initiate. You may revoke that access
          at any time through your Google account settings.
        </p>
      </section>

      <section>
        <h3>Availability</h3>
        <p>
          The service is provided on an as-is and as-available basis. Availability may be affected
          by hosting limits, Google API limits, deployment changes, or maintenance.
        </p>
      </section>

      <section>
        <h3>Limitation of Liability</h3>
        <p>
          To the fullest extent allowed by law, the service provider is not liable for indirect,
          incidental, special, or consequential damages arising from use of the app, including data
          loss, interrupted service, or file-processing errors.
        </p>
      </section>

      <section>
        <h3>Termination</h3>
        <p>
          Access to the service may be limited or terminated if the app is misused, if security
          issues arise, or if the service is discontinued.
        </p>
      </section>

      <section>
        <h3>Changes to These Terms</h3>
        <p>
          These terms may be updated from time to time. Continued use of the app after changes are
          published means you accept the revised terms.
        </p>
      </section>
    </PolicyLayout>
  );
}

export default function App() {
  const [auth, setAuth] = useAuth();

  return (
    <Routes>
      <Route path="/" element={<UploadPage auth={auth} setAuth={setAuth} />} />
      <Route path="/search" element={<SearchPage auth={auth} setAuth={setAuth} />} />
      <Route path="/privacy-policy" element={<PrivacyPolicyPage auth={auth} setAuth={setAuth} />} />
      <Route path="/terms-of-service" element={<TermsOfServicePage auth={auth} setAuth={setAuth} />} />
    </Routes>
  );
}
