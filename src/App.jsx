import { NavLink, Route, Routes, useLocation, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const LAST_UPDATED = "March 18, 2026";
const APP_NAME = "Fee Challan Generator by NGS";
const ADMIN_PIN = "625616";
const ADMIN_SESSION_KEY = "ngs-voucher-admin-unlocked";

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

function useAdminAccess() {
  const [isUnlocked, setIsUnlocked] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(ADMIN_SESSION_KEY) === "true";
  });

  function unlock(pin) {
    const normalizedPin = pin.trim();

    if (normalizedPin !== ADMIN_PIN) {
      return false;
    }

    window.localStorage.setItem(ADMIN_SESSION_KEY, "true");
    setIsUnlocked(true);
    return true;
  }

  function lock() {
    window.localStorage.removeItem(ADMIN_SESSION_KEY);
    setIsUnlocked(false);
  }

  return {
    isUnlocked,
    unlock,
    lock
  };
}

function Shell({
  auth,
  setAuth,
  children,
  showPublicNavigation = true,
  showPolicyLinks = true,
  showAuthBanner = false,
  heroTitle = "Fee Challan Generator by NGS",
  heroText = "Search and download saved fee challans quickly using the challan number or saved file name."
}) {
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
          <p className="eyebrow">NGS</p>
          <h1>{heroTitle}</h1>
          <p className="hero__text">{heroText}</p>
        </div>

        {showAuthBanner ? (
          <div className="auth-banner">
            <div>
              <p className="result-card__label">Google Drive Connection</p>
              <h2>{auth.isAuthenticated ? "Connected" : "Not connected yet"}</h2>
              <p>
                {auth.isAuthenticated
                  ? "This browser session is ready for admin challan uploads."
                  : "Connect Google Drive before using the admin upload page."}
              </p>
            </div>

            <div className="auth-banner__actions">
              {auth.isAuthenticated ? (
                <button className="action-button action-button--secondary" onClick={handleLogout}>
                  Disconnect
                </button>
              ) : (
                <button className="action-button" onClick={handleConnect}>
                  Connect Admin Drive
                </button>
              )}
            </div>
          </div>
        ) : null}

        <nav className="tabs" aria-label="Pages">
          {showPublicNavigation ? (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
                Search Challan
              </NavLink>
            </>
          ) : null}
          {showPolicyLinks ? (
            <>
              <NavLink to="/privacy-policy" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
                Privacy Policy
              </NavLink>
              <NavLink to="/terms-of-service" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
                Terms of Service
              </NavLink>
            </>
          ) : null}
        </nav>
      </header>
      <main>{children}</main>
      {showPolicyLinks ? (
        <footer className="site-footer">
          <p>Use of {APP_NAME} is subject to the published policy pages below.</p>
          <div className="site-footer__links">
            <NavLink to="/privacy-policy">Privacy Policy</NavLink>
            <NavLink to="/terms-of-service">Terms of Service</NavLink>
          </div>
        </footer>
      ) : null}
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
        <p>Connect the admin Google account first to use this page.</p>
      </div>
    );
  }

  return children;
}

function AdminGate({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event) {
    event.preventDefault();

    if (!/^\d{6}$/.test(pin.trim())) {
      setError("Enter the 6-digit admin PIN.");
      return;
    }

    if (!onUnlock(pin)) {
      setError("Incorrect PIN.");
      return;
    }

    setError("");
  }

  return (
    <section className="panel">
      <div className="panel__intro">
        <h2>Admin Access</h2>
        <p>Enter the 6-digit PIN to unlock the admin area for challan uploads.</p>
      </div>

      <form className="search-form" onSubmit={handleSubmit}>
        <input
          type="password"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="Enter 6-digit PIN"
          value={pin}
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, "").slice(0, 6));
            setError("");
          }}
        />
        <button className="action-button" type="submit">
          Unlock Admin
        </button>
      </form>

      {error ? <p className="error-line">{error}</p> : null}
    </section>
  );
}

function UploadPanel({ auth, setAuth }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [folderStatsLoading, setFolderStatsLoading] = useState(true);
  const [folderFileCount, setFolderFileCount] = useState(null);
  const [folderStatsError, setFolderStatsError] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFolderStats() {
      setFolderStatsLoading(true);
      setFolderStatsError("");

      try {
        const response = await fetch(`${API_BASE_URL}/api/admin/folder-stats`, {
          credentials: "include"
        });
        const data = await parseJsonResponse(response);

        if (!cancelled) {
          setFolderFileCount(data.fileCount);
        }
      } catch (statsError) {
        if (!cancelled) {
          setFolderStatsError(statsError.message);
        }
      } finally {
        if (!cancelled) {
          setFolderStatsLoading(false);
        }
      }
    }

    loadFolderStats();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!file) {
      setError("Choose a PDF before uploading.");
      return;
    }

    setLoading(true);
    setLoadingStep("Uploading and processing challan file...");
    setError("");
    setResults([]);
    setSummary(null);

    try {
      const formData = new FormData();
      formData.append("pdf", file);

      setLoadingStep("Uploading file to the server...");
      const response = await fetch(`${API_BASE_URL}/api/upload-split`, {
        method: "POST",
        body: formData,
        credentials: "include"
      });
      setLoadingStep("Splitting pages and saving challans...");
      const data = await parseJsonResponse(response);

      setResults(data.files);
      setSummary({
        sourceName: data.sourceName,
        totalPages: data.totalPages
      });
      setFolderFileCount((currentCount) =>
        typeof currentCount === "number" ? currentCount + data.files.length : currentCount
      );
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
      setLoadingStep("");
    }
  }

  return (
    <section className="panel">
      <div className="panel__intro">
        <h2>Upload Challan PDF</h2>
        <p>
          Upload the source challan PDF here. Each page is processed, named using the detected
          identifier, and saved for later search and download.
        </p>
      </div>

      <div className="summary-card">
        <p className="result-card__label">Current Folder Files</p>
        <h3>
          {folderStatsLoading ? "Loading..." : folderFileCount !== null ? folderFileCount : "--"}
        </h3>
        <p>
          {folderStatsError
            ? folderStatsError
            : "This is the current number of saved challan files in the configured folder."}
        </p>
      </div>

      <AuthRequired auth={auth}>
        <form className="upload-form" onSubmit={handleSubmit}>
          <label className="file-input">
            <span>Choose Challan PDF</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>

          <button className="action-button" type="submit" disabled={loading}>
            {loading ? "Uploading..." : "Upload and Save Challans"}
          </button>
        </form>

        {file ? <p className="info-line">Selected file: {file.name}</p> : null}
        {loading ? (
          <div className="loading-card" aria-live="polite" aria-busy="true">
            <div className="loading-card__spinner" />
            <div className="loading-card__content">
              <p className="result-card__label">Processing</p>
              <h3>Please wait while challans are being prepared.</h3>
              <p>{loadingStep}</p>
            </div>
          </div>
        ) : null}
        {error ? <p className="error-line">{error}</p> : null}

        {summary ? (
          <div className="summary-card">
            <p>Source file: {summary.sourceName}</p>
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
                  Open File
                </a>
              </article>
            ))}
          </div>
        ) : null}
      </AuthRequired>
    </section>
  );
}

function AdminPage({ auth, setAuth, adminAccess }) {
  return (
    <Shell
      auth={auth}
      setAuth={setAuth}
      showPublicNavigation={false}
      showPolicyLinks={false}
      showAuthBanner={adminAccess.isUnlocked}
      heroTitle="Fee Challan Generator by NGS"
      heroText="This admin page is for staff only. Unlock it with the PIN to connect the admin account and upload challan files."
    >
      {adminAccess.isUnlocked ? <UploadPanel auth={auth} setAuth={setAuth} /> : <AdminGate onUnlock={adminAccess.unlock} />}
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
      setError("Enter a challan file name.");
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
    <Shell auth={auth} setAuth={setAuth} showPolicyLinks={false}>
      <section className="panel">
        <div className="panel__intro">
          <h2>Search by file name</h2>
          <p>
            Enter the challan file name exactly as saved to find and download it instantly.
          </p>
        </div>

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
              <p>File ID: {result.id}</p>
            </div>
            <div className="search-result__actions">
              <a href={result.webViewLink} target="_blank" rel="noreferrer">
                View File
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
      summary="This page explains what data the Fee Challan Generator by NGS uses and how uploaded challan files are handled."
    >
      <section>
        <h3>Information We Access</h3>
        <p>
          When an administrator connects the Google account, this app receives OAuth tokens that
          allow the admin workflow to store and manage challan files used with {APP_NAME}.
        </p>
        <p>
          When a challan PDF is uploaded, the app reads file content to process pages and extract
          identifiers used for naming each generated file.
        </p>
      </section>

      <section>
        <h3>How We Use Your Data</h3>
        <p>
          Your data is used only to authenticate the administrator, process uploaded challan
          files, save generated files, search saved challans, and return files on request.
        </p>
        <p>
          {APP_NAME} does not use this data for advertising, profiling, resale, or unrelated
          analytics purposes.
        </p>
      </section>

      <section>
        <h3>Storage and Retention</h3>
        <p>
          Uploaded challan files and generated output files are stored in the configured storage
          location. Authentication data is stored in secure HTTP-only cookies for the admin
          session when needed.
        </p>
        <p>
          {APP_NAME} is designed to process files for the requested workflow and does not maintain
          a separate permanent database of file contents.
        </p>
      </section>

      <section>
        <h3>Google User Data</h3>
        <p>
          Access to Google user data is limited to the functionality required for admin uploads and
          file management. {APP_NAME} requests Google permissions only for these admin-initiated
          actions.
        </p>
      </section>

      <section>
        <h3>Your Choices</h3>
        <p>
          You may stop using {APP_NAME} at any time, disconnect the admin account from the app
          interface, remove uploaded files, or revoke the app&apos;s access from the Google Account
          permissions page.
        </p>
      </section>

      <section>
        <h3>Contact</h3>
        <p>
          If you publish {APP_NAME} publicly, replace this paragraph with your business or support
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
      summary={`These terms describe the acceptable use of the ${APP_NAME} application.`}
    >
      <section>
        <h3>Use of the Service</h3>
        <p>
          This application is provided to let authorized administrators upload challan files,
          process and save them, and let users search or download saved challans.
        </p>
      </section>

      <section>
        <h3>Your Responsibilities</h3>
        <p>
          You are responsible for the files you upload, the legality of their content, and your
          handling of any student, personal, or confidential information in those files.
        </p>
        <p>
          You must use the service only for lawful purposes and only with files and storage
          content you are authorized to access and manage.
        </p>
      </section>

      <section>
        <h3>Google Account Access</h3>
        <p>
          By connecting the admin Google account, you authorize {APP_NAME} to perform the
          storage-related actions required for the workflow you initiate. You may revoke that
          access at any time through the Google account settings.
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
          incidental, special, or consequential damages arising from use of {APP_NAME}, including
          data loss, interrupted service, or file-processing errors.
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
  const adminAccess = useAdminAccess();

  return (
    <Routes>
      <Route path="/" element={<SearchPage auth={auth} setAuth={setAuth} />} />
      <Route path="/search" element={<Navigate to="/" replace />} />
      <Route
        path="/admin"
        element={<AdminPage auth={auth} setAuth={setAuth} adminAccess={adminAccess} />}
      />
      <Route path="/privacy-policy" element={<PrivacyPolicyPage auth={auth} setAuth={setAuth} />} />
      <Route path="/terms-of-service" element={<TermsOfServicePage auth={auth} setAuth={setAuth} />} />
    </Routes>
  );
}
