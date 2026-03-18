import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

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

function Shell({ auth, setAuth, children }) {
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
          <NavLink to="/" end className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            Upload & Split
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            Search & Download
          </NavLink>
        </nav>
      </header>
      <main>{children}</main>
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

export default function App() {
  const [auth, setAuth] = useAuth();

  return (
    <Routes>
      <Route path="/" element={<UploadPage auth={auth} setAuth={setAuth} />} />
      <Route path="/search" element={<SearchPage auth={auth} setAuth={setAuth} />} />
    </Routes>
  );
}
