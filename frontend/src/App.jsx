import { useState, useEffect, useMemo, useRef } from "react";

function App() {
  const [mode, setMode] = useState("single");

  // Login
  const [authToken, setAuthToken] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // Single mode
  const [image, setImage] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [originalDimensions, setOriginalDimensions] = useState(null);
  const [processedDimensions, setProcessedDimensions] = useState(null);
  const [result, setResult] = useState(null);

  // Batch mode
  const [images, setImages] = useState([]);
  const [batchResults, setBatchResults] = useState([]);
  const [pendingFolderImages, setPendingFolderImages] = useState([]);
  const [showFolderConfirm, setShowFolderConfirm] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Common
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [zipLoading, setZipLoading] = useState(false);

  // Themed notice modal (replaces native browser alert() popups)
  const [notice, setNotice] = useState(null);
  const showNotice = (message) => setNotice(message);

  const dragCounter = useRef(0);

  // ==================================================
  // Parse a "1200 x 1800" style target size straight out of the prompt text.
  // Purely a UI convenience — never sent anywhere, never changes the prompt.
  // ==================================================
  const parsedTargetSize = useMemo(() => {
    const match = prompt.match(/(\d{2,5})\s*[x×X*]\s*(\d{2,5})/);
    if (!match) return null;
    return { width: match[1], height: match[2] };
  }, [prompt]);

  // ==================================================
  // Keep a single, revoked-on-change object URL for the selected image
  // instead of calling URL.createObjectURL on every render (memory leak fix).
  // ==================================================
  useEffect(() => {
    if (!image) {
      setImagePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // ==================================================
  // LOGIN
  const handleLogin = async (e) => {
    if (e) e.preventDefault();

    setLoginLoading(true);
    setLoginError("");

    try {
      const response = await fetch("http://127.0.0.1:8000/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: loginUsername,
          password: loginPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.access_token) {
        throw new Error(data.detail || "Login failed. Check your username and password.");
      }

      setAuthToken(data.access_token);
      setLoginPassword("");
    } catch (error) {
      setLoginError(error.message || "Could not connect to the backend.");
    } finally {
      setLoginLoading(false);
    }
  };

  // SINGLE IMAGE SELECT
  // ==================================================

  const handleSingleImageChange = (e) => {
    const selectedImage = e.target.files[0];

    if (selectedImage) {
      setImage(selectedImage);
      setResult(null);
      setOriginalDimensions(null);
      setProcessedDimensions(null);
    }
  };

  // ==================================================
  // SINGLE IMAGE PROCESS
  // ==================================================

  const handleProcess = async () => {
    if (!image) {
      showNotice("Please select an image.");
      return;
    }

    if (!prompt.trim()) {
      showNotice("Please enter a prompt.");
      return;
    }

    setLoading(true);
    setResult(null);
    setProcessedDimensions(null);

    const formData = new FormData();

    formData.append("image", image);
    formData.append("prompt", prompt);

    try {
      const response = await fetch(
        "http://127.0.0.1:8000/process",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Processing failed."
        );
      }

      setResult(data);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setLoading(false);
    }
  };

  // ==================================================
  // FOLDER SELECT (click-to-pick, existing logic unchanged)
  // ==================================================

  const scanFolder = async (directory, fileHandles) => {
    const entries = [];

    for await (const entry of directory.values()) {
      entries.push(entry);
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.kind === "directory") {
          await scanFolder(entry, fileHandles);
        } else if (entry.kind === "file") {
          fileHandles.push(entry);
        }
      })
    );
  };

  const handleFolderChange = async () => {
    if (!window.showDirectoryPicker) {
      showNotice("Folder selection needs the latest Chrome or Edge browser. You can also drag and drop a folder onto the box below.");
      return;
    }

    try {
      const folder = await window.showDirectoryPicker();
      const fileHandles = [];

      await scanFolder(folder, fileHandles);

      // Read files in small parallel groups to keep scanning responsive.
      const imageFiles = [];
      const chunkSize = 30;

      for (let i = 0; i < fileHandles.length; i += chunkSize) {
        const chunk = fileHandles.slice(i, i + chunkSize);
        const files = await Promise.all(chunk.map((handle) => handle.getFile()));

        imageFiles.push(
          ...files.filter((file) =>
            file.type.startsWith("image/") ||
            /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name)
          )
        );
      }

      if (imageFiles.length === 0) {
        showNotice("No image files found in this folder.");
        return;
      }

      setPendingFolderImages(imageFiles);
      setShowFolderConfirm(true);
    } catch (error) {
      if (error.name !== "AbortError") {
        showNotice(error.message || "Could not open the selected folder.");
      }
    }
  };

  // ==================================================
  // FOLDER DRAG & DROP
  // Traverses dropped folder entries the same way the picker does, so the
  // user can literally drag a folder onto the dropzone as the spec asked.
  // ==================================================

  const readAllEntries = (reader) =>
    new Promise((resolve, reject) => {
      let all = [];
      const readBatch = () => {
        reader.readEntries((entries) => {
          if (!entries.length) {
            resolve(all);
          } else {
            all = all.concat(entries);
            readBatch();
          }
        }, reject);
      };
      readBatch();
    });

  const traverseEntry = async (entry, fileList) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      fileList.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await readAllEntries(reader);
      for (const child of entries) {
        await traverseEntry(child, fileList);
      }
    }
  };

  const handleFolderDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    dragCounter.current = 0;

    const items = e.dataTransfer && e.dataTransfer.items;
    if (!items || items.length === 0) return;

    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    if (entries.length === 0) {
      showNotice("Your browser doesn't support folder drag-and-drop. Please click the box instead to select a folder.");
      return;
    }

    const fileList = [];
    for (const entry of entries) {
      await traverseEntry(entry, fileList);
    }

    const imageFiles = fileList.filter(
      (file) =>
        file.type.startsWith("image/") ||
        /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name)
    );

    if (imageFiles.length === 0) {
      showNotice("No image files found in the dropped folder.");
      return;
    }

    setPendingFolderImages(imageFiles);
    setShowFolderConfirm(true);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setIsDragOver(false);
      dragCounter.current = 0;
    }
  };

  const confirmFolderSelection = () => {
    setImages(pendingFolderImages);
    setBatchResults([]);
    setProgress(0);
    setCurrentBatch(0);
    setTotalBatches(Math.ceil(pendingFolderImages.length / 10));
    setPendingFolderImages([]);
    setShowFolderConfirm(false);
  };

  const cancelFolderSelection = () => {
    setPendingFolderImages([]);
    setShowFolderConfirm(false);
  };

  // ==================================================
  // REMOVE IMAGE
  // ==================================================

  const removeImage = (indexToRemove) => {
    setImages((currentImages) =>
      currentImages.filter(
        (_, index) => index !== indexToRemove
      )
    );

    setBatchResults([]);
    setProgress(0);
    setCurrentBatch(0);
  };

  const removeAllImages = () => {
    setImages([]);
    setBatchResults([]);
    setProgress(0);
    setCurrentBatch(0);
    setTotalBatches(0);
  };

  // ==================================================
  // PROCESS ONE BATCH
  // ==================================================

  const processBatch = async (batchImages) => {
    const formData = new FormData();

    batchImages.forEach((image) => {
      formData.append("images", image);
    });

    formData.append("prompt", prompt);

    const response = await fetch(
      "http://127.0.0.1:8000/process-batch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Batch processing failed."
      );
    }

    return data;
  };

  // ==================================================
  // PROCESS ALL IMAGES
  // ==================================================

  const handleProcessAll = async () => {
    if (images.length === 0) {
      showNotice(
        "Please select a folder containing images."
      );
      return;
    }

    if (!prompt.trim()) {
      showNotice("Please enter a prompt.");
      return;
    }

    setLoading(true);
    setBatchResults([]);
    setProgress(0);

    // Create batches of 10
    const batches = [];

    for (let i = 0; i < images.length; i += 10) {
      batches.push(
        images.slice(i, i + 10)
      );
    }

    setTotalBatches(batches.length);

    const allResults = [];

    try {
      // Process batches one by one
      for (
        let i = 0;
        i < batches.length;
        i++
      ) {
        const batchNumber = i + 1;

        setCurrentBatch(batchNumber);

        const data = await processBatch(
          batches[i]
        );

        allResults.push(...data.results);

        setBatchResults([...allResults]);

        // Calculate progress
        const completedImages = Math.min(
          (i + 1) * 10,
          images.length
        );

        setProgress(
          Math.round(
            (completedImages / images.length) * 100
          )
        );
      }
    } catch (error) {
      showNotice(error.message);
    } finally {
      setLoading(false);
    }
  };

  // ==================================================
  // DOWNLOAD ZIP
  // ==================================================

  const handleDownloadZip = async () => {
    const successfulResults =
      batchResults.filter(
        (item) => item.success
      );

    if (successfulResults.length === 0) {
      showNotice(
        "No successful images to download."
      );
      return;
    }

    setZipLoading(true);

    try {
      const response = await fetch(
        "http://127.0.0.1:8000/download-zip",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },

          body: JSON.stringify({
            results: successfulResults,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          "ZIP download failed."
        );
      }

      const blob = await response.blob();

      const url =
        window.URL.createObjectURL(blob);

      const link =
        document.createElement("a");

      link.href = url;

      link.download =
        "processed_images.zip";

      document.body.appendChild(link);

      link.click();

      link.remove();

      window.URL.revokeObjectURL(url);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setZipLoading(false);
    }
  };

  // ==================================================
  // MODE CHANGE
  // ==================================================

  const handleModeChange = (newMode) => {
    setMode(newMode);

    setResult(null);
    setBatchResults([]);
    setProgress(0);
    setCurrentBatch(0);
    setLoading(false);
  };

  // ==================================================
  // UI
  // ==================================================

  if (!authToken) {
    return (
      <div className="dmd-app">
        <div className="dmd-auth">
          {/* LEFT — sign-in panel */}
          <div className="dmd-auth-panel">
            <div className="dmd-brand">
              <img
                src="/de-maison-decor-logo.jpeg"
                alt="De Maison Decor"
                className="dmd-brand-mark dmd-brand-mark--lg"
              />
              <div className="dmd-brand-text">
                <span className="dmd-brand-name">De Maison Decor</span>
                <span className="dmd-brand-kicker">PRODUCT IMAGE STUDIO</span>
              </div>
            </div>

            <div className="dmd-auth-panel-body">
              <div className="dmd-auth-form-wrap">
                <p className="dmd-auth-eyebrow">Welcome back</p>
                <h1 className="dmd-auth-heading">Sign in to your studio</h1>
                <p className="dmd-auth-subtitle">
                  Prepare polished, on-brand product photography for your
                  home-decor catalogue.
                </p>

                <form onSubmit={handleLogin} className="dmd-auth-form">
                  <div className="dmd-field">
                    <label htmlFor="login-username">Username</label>
                    <input
                      id="login-username"
                      type="text"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      autoComplete="username"
                      placeholder="Enter your username"
                      required
                    />
                  </div>

                  <div className="dmd-field">
                    <label htmlFor="login-password">Password</label>
                    <input
                      id="login-password"
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      required
                    />
                  </div>

                  {loginError && (
                    <p className="dmd-error-text" style={{ marginBottom: 16 }}>
                      {loginError}
                    </p>
                  )}

                  <button type="submit" className="dmd-btn dmd-btn-primary" disabled={loginLoading}>
                    {loginLoading ? "Signing in..." : "Sign in to workspace"}
                  </button>
                </form>

                <div className="dmd-auth-footnote">
                  <span>Crafted for beautiful product imagery</span>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT — workflow showcase */}
          <div className="dmd-showcase">
            <div className="dmd-showcase-body">
              <p className="dmd-showcase-eyebrow">What this studio does</p>
              <h2 className="dmd-showcase-heading">
                Catalogue-ready photos, without the retouching queue
              </h2>
              <p className="dmd-showcase-copy">
                Upload a product photo — or a whole folder — and describe the
                result you want. The studio resizes, extends backgrounds, and
                keeps every subject true to scale.
              </p>

              <ul className="dmd-showcase-features">
                <li>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Precise, distortion-free resizing to your exact dimensions
                </li>
                <li>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Natural background extension that keeps subjects untouched
                </li>
                <li>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Batch processing, ten images at a time, with a ZIP export
                </li>
              </ul>

              <div className="dmd-mock">
                <div className="dmd-mock-head">
                  <span>PREVIEW</span>
                  <span className="dmd-mock-dot">Studio ready</span>
                </div>
                <div className="dmd-mock-row">
                  <div className="dmd-mock-block dmd-mock-block--before">
                    <span>Original</span>
                  </div>
                  <div className="dmd-mock-arrow">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </div>
                  <div className="dmd-mock-block dmd-mock-block--after">
                    <span>Studio ready</span>
                  </div>
                </div>
                <p className="dmd-mock-caption">
                  Example: resized to 1200 × 1800, background naturally extended
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dmd-app dmd-dashboard">
      {/* HEADER */}

      <header className="dmd-topbar">
        <div className="dmd-brand">
          <img
            src="/de-maison-decor-logo.jpeg"
            alt="De Maison Decor"
            className="dmd-brand-mark"
          />
          <div className="dmd-brand-text">
            <span className="dmd-brand-name">De Maison Decor</span>
            <span className="dmd-brand-kicker">PRODUCT IMAGE STUDIO</span>
          </div>
        </div>

        <p className="dmd-topbar-copy">
          Resize and prepare home-decor product photos for your online store.
        </p>

        <button
          type="button"
          className="dmd-btn dmd-btn-ghost"
          onClick={() => {
            setAuthToken("");
            setLoginError("");
            setLoginPassword("");
          }}
        >
          Logout
        </button>
      </header>

      <main className="dmd-workspace">
        {/* ==================================================
            INPUT PANEL
        ================================================== */}

        <section className="dmd-panel">
          {/* MODE SWITCH */}

          <div className="dmd-mode-switch">
            <button
              className={
                mode === "single"
                  ? "dmd-mode-btn dmd-mode-btn--active"
                  : "dmd-mode-btn"
              }
              onClick={() => handleModeChange("single")}
            >
              Single Image
            </button>

            <button
              className={
                mode === "batch"
                  ? "dmd-mode-btn dmd-mode-btn--active"
                  : "dmd-mode-btn"
              }
              onClick={() => handleModeChange("batch")}
            >
              Batch Processing
            </button>
          </div>

          {/* ==================================================
              SINGLE MODE
          ================================================== */}

          {mode === "single" && (
            <>
              <h2 className="dmd-panel-title">Upload Image</h2>

              <label className="dmd-dropzone">
                <div className="dmd-dropzone-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M12 4l-4 4M12 4l4 4" />
                    <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                  </svg>
                </div>

                {image ? (
                  <span className="dmd-dropzone-title">{image.name}</span>
                ) : (
                  <>
                    <span className="dmd-dropzone-title">Drop an image here or click to choose an image</span>
                    <span className="dmd-dropzone-hint">JPG, PNG or WEBP</span>
                  </>
                )}

                <input
                  type="file"
                  accept="image/*"
                  onChange={handleSingleImageChange}
                />
              </label>

              {image && imagePreviewUrl && (
                <div className="dmd-preview">
                  <div className="dmd-preview-frame">
                    <img
                      src={imagePreviewUrl}
                      alt="Selected"
                      onLoad={(e) =>
                        setOriginalDimensions({
                          width: e.target.naturalWidth,
                          height: e.target.naturalHeight,
                        })
                      }
                    />
                  </div>

                  <button
                    type="button"
                    className="dmd-preview-remove"
                    onClick={() => {
                      setImage(null);
                      setResult(null);
                      setOriginalDimensions(null);
                      setProcessedDimensions(null);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" />
                    </svg>
                    Delete Image
                  </button>

                  {originalDimensions && (
                    <div className="dmd-size-row">
                      <div className="dmd-size-card">
                        <span>Original Size</span>
                        <strong>
                          {originalDimensions.width}
                          {" " + String.fromCharCode(215) + " "}
                          {originalDimensions.height} px
                        </strong>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ==================================================
              BATCH MODE
          ================================================== */}

          {mode === "batch" && (
            <>
              <h2 className="dmd-panel-title">Select Image Folder</h2>

              <p className="dmd-batch-help">
                Select your complete folder. The tool automatically processes
                images in batches of 10.
              </p>

              <div
                className={
                  isDragOver
                    ? "dmd-dropzone dmd-dropzone--compact dmd-dropzone--drag"
                    : "dmd-dropzone dmd-dropzone--compact"
                }
                role="button"
                tabIndex={0}
                onClick={handleFolderChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleFolderChange();
                  }
                }}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleFolderDrop}
              >
                <div className="dmd-dropzone-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                </div>

                <span className="dmd-dropzone-title">
                  {images.length > 0
                    ? `${images.length} images selected`
                    : "Drop folder here or drag & drop folder"}
                </span>
                {images.length === 0 && (
                  <span className="dmd-dropzone-hint">or click to choose a folder</span>
                )}
              </div>

              {/* FOLDER INFO */}

              {images.length > 0 && (
                <div className="dmd-folder-info">
                  <div>
                    <strong>{images.length} images found</strong>
                    <span>
                      {Math.ceil(images.length / 10)} batches will be processed
                    </span>
                  </div>

                  <button
                    type="button"
                    className="dmd-remove-all-btn"
                    onClick={removeAllImages}
                    disabled={loading}
                  >
                    Remove All
                  </button>
                </div>
              )}

              {/* IMAGE LIST */}

              {images.length > 0 && (
                <div className="dmd-batch-list">
                  {images.map((image, index) => (
                    <div className="dmd-batch-item" key={`${image.name}-${index}`}>
                      <div className="dmd-batch-item-info">
                        <span className="dmd-batch-number">{index + 1}</span>
                        <span className="dmd-batch-name">{image.name}</span>
                      </div>

                      <button
                        type="button"
                        className="dmd-remove-btn"
                        aria-label={`Remove ${image.name}`}
                        title="Remove image"
                        onClick={() => removeImage(index)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* PROGRESS */}

              {loading && (
                <div className="dmd-progress">
                  <div className="dmd-progress-top">
                    <span>
                      Processing Batch {currentBatch} of {totalBatches}
                    </span>
                    <strong>{progress}%</strong>
                  </div>

                  <div className="dmd-progress-track">
                    <div
                      className="dmd-progress-fill"
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  <p className="dmd-progress-note">
                    {Math.min(currentBatch * 10, images.length)} / {images.length} images processed — please keep this page open.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ==================================================
              PROMPT
          ================================================== */}

          <h2 className="dmd-panel-title">Tell the AI what to do</h2>

          <textarea
            className="dmd-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Example: Make all images 1200x1800 and naturally extend the background. Do not stretch the subject."
          />

          {parsedTargetSize && (
            <div className="dmd-size-row">
              <div className="dmd-size-card dmd-size-card--target">
                <span>Target Size</span>
                <strong>
                  {parsedTargetSize.width}
                  {" " + String.fromCharCode(215) + " "}
                  {parsedTargetSize.height} px
                </strong>
              </div>
            </div>
          )}

          {/* ==================================================
              PROCESS BUTTON
          ================================================== */}

          {mode === "single" ? (
            <button
              className="dmd-btn dmd-btn-primary"
              onClick={handleProcess}
              disabled={loading}
              style={{ marginTop: 18 }}
            >
              {loading ? "Processing..." : "Process Image"}
            </button>
          ) : (
            <button
              className="dmd-btn dmd-btn-primary"
              onClick={handleProcessAll}
              disabled={loading || images.length === 0}
              style={{ marginTop: 18 }}
            >
              {loading ? "Processing..." : `Process ${images.length} Images`}
            </button>
          )}
        </section>

        {/* ==================================================
            SINGLE RESULT
        ================================================== */}

        {mode === "single" && result && (
          <section className="dmd-panel">
            <h2 className="dmd-panel-title">Processed Image</h2>

            <div className="dmd-compare-grid">
              {imagePreviewUrl && (
                <div className="dmd-compare-col">
                  <span className="dmd-compare-label">Original</span>
                  <div className="dmd-result-frame">
                    <img src={imagePreviewUrl} alt="Original" />
                  </div>
                </div>
              )}

              <div className="dmd-compare-col">
                <span className="dmd-compare-label">Processed</span>
                <div className="dmd-result-frame">
                  <img
                    src={result.processed_image}
                    alt="Processed result"
                    onLoad={(e) =>
                      setProcessedDimensions({
                        width: e.target.naturalWidth,
                        height: e.target.naturalHeight,
                      })
                    }
                  />
                </div>
              </div>
            </div>

            <div className="dmd-result-meta">
              <div>
                <span>Original</span>
                <strong>
                  {result.original.width}
                  {" " + String.fromCharCode(215) + " "}
                  {result.original.height}
                </strong>
              </div>

              <div>
                <span>Target</span>
                <strong>
                  {result.target.width}
                  {" " + String.fromCharCode(215) + " "}
                  {result.target.height}
                </strong>
              </div>

              {processedDimensions && (
                <div>
                  <span>Processed</span>
                  <strong>
                    {processedDimensions.width}
                    {" " + String.fromCharCode(215) + " "}
                    {processedDimensions.height}
                  </strong>
                </div>
              )}
            </div>

            <a
              href={result.processed_image}
              target="_blank"
              rel="noreferrer"
              className="dmd-btn-link"
            >
              Open / Download Result
            </a>
          </section>
        )}

        {/* ==================================================
            BATCH RESULTS
        ================================================== */}

        {mode === "batch" && batchResults.length > 0 && (
          <section className="dmd-panel">
            <div className="dmd-results-header">
              <h2 className="dmd-panel-title">Batch Results</h2>

              <button
                type="button"
                className="dmd-btn dmd-btn-secondary"
                onClick={handleDownloadZip}
                disabled={zipLoading}
                style={{ width: "auto" }}
              >
                {zipLoading ? "Creating ZIP..." : "Download ZIP"}
              </button>
            </div>

            {!loading && (
              <p className="dmd-batch-help" style={{ marginTop: -8, marginBottom: 18 }}>
                {batchResults.length} / {images.length} images processed &middot;{" "}
                {totalBatches} / {totalBatches} batches completed
              </p>
            )}

            {/* SUMMARY */}

            <div className="dmd-summary-grid">
              <div className="dmd-summary-card">
                <strong>{images.length}</strong>
                <span>Total Images</span>
              </div>

              <div className="dmd-summary-card">
                <strong>{batchResults.filter((item) => item.success).length}</strong>
                <span>Successful</span>
              </div>

              <div className="dmd-summary-card">
                <strong>{batchResults.filter((item) => !item.success).length}</strong>
                <span>Failed</span>
              </div>
            </div>

            {/* RESULTS */}

            <div className="dmd-batch-results-list">
              {batchResults.map((item, index) => (
                <div className="dmd-batch-result-card" key={`${item.filename}-${index}`}>
                  <div className="dmd-batch-result-head">
                    <strong>
                      {index + 1}. {item.filename}
                    </strong>

                    <span
                      className={
                        item.success
                          ? "dmd-status-pill dmd-status-pill--success"
                          : "dmd-status-pill dmd-status-pill--failed"
                      }
                    >
                      {item.success ? "Success" : "Failed"}
                    </span>
                  </div>

                  {item.success ? (
                    <>
                      <div className="dmd-batch-result-frame">
                        <img src={item.processed_image} alt={item.filename} />
                      </div>

                      <p>
                        <strong>Original:</strong>{" "}
                        {item.original.width}
                        {" " + String.fromCharCode(215) + " "}
                        {item.original.height}
                      </p>

                      <p>
                        <strong>Target:</strong>{" "}
                        {item.target.width}
                        {" " + String.fromCharCode(215) + " "}
                        {item.target.height}
                      </p>

                      <a
                        href={item.processed_image}
                        target="_blank"
                        rel="noreferrer"
                        className="dmd-btn-link"
                      >
                        Open / Download
                      </a>
                    </>
                  ) : (
                    <p className="dmd-error-text">Error: {item.error}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {showFolderConfirm && (
        <div
          className="dmd-modal-backdrop"
          role="presentation"
          onClick={cancelFolderSelection}
        >
          <section
            className="dmd-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dmd-modal-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
            </div>

            <h2 id="folder-confirm-title">Ready to prepare your photos?</h2>

            <p>
              You selected <strong>{pendingFolderImages.length} images</strong>.
              Continue with this folder? Your images will be processed in
              batches of 10 ({Math.ceil(pendingFolderImages.length / 10)} batches
              total).
            </p>

            <div className="dmd-modal-actions">
              <button
                type="button"
                className="dmd-btn dmd-btn-outline"
                onClick={cancelFolderSelection}
              >
                Cancel
              </button>

              <button
                type="button"
                className="dmd-btn dmd-btn-primary"
                onClick={confirmFolderSelection}
              >
                Continue
              </button>
            </div>
          </section>
        </div>
      )}

      {notice && (
        <div
          className="dmd-modal-backdrop"
          role="presentation"
          onClick={() => setNotice(null)}
        >
          <section
            className="dmd-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="notice-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dmd-modal-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16.5v.01" />
              </svg>
            </div>

            <h2 id="notice-title">Notice</h2>

            <p>{notice}</p>

            <div className="dmd-modal-actions">
              <button
                type="button"
                className="dmd-btn dmd-btn-primary"
                onClick={() => setNotice(null)}
              >
                OK
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;