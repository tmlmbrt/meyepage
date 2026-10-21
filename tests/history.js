/* Run by serving the repository and opening tests/history.html in a browser. */
(async () => {
  const source = await (await fetch("../index.html")).text();
  const results = document.getElementById("results");
  const viewer = document.getElementById("viewer");
  const images = ["red", "green", "blue"].map(color => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, 4, 4);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  let frame;
  let win;
  const tests = [];
  const test = (name, run) => tests.push({ name, run });
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const evaluate = code => win.eval(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(predicate, message) {
    for (let i = 0; i < 500; i++) {
      if (await predicate()) return;
      await sleep(10);
    }
    throw new Error(`Timed out: ${message}`);
  }

  function setup(imageData, storageUnavailable) {
    const state = window.testState = {
      requests: [], timers: new Map(), now: 0, nextTimer: 0,
      created: [], revoked: [], imageData
    };
    window.setTimeout = (callback, delay) => {
      const id = ++state.nextTimer;
      state.timers.set(id, { callback, at: state.now + delay, delay });
      return id;
    };
    window.clearTimeout = id => state.timers.delete(id);
    state.tick = ms => {
      state.now += ms;
      for (const [id, timer] of [...state.timers]) {
        if (timer.at <= state.now) {
          state.timers.delete(id);
          timer.callback();
        }
      }
    };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = create(blob);
      state.created.push(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      state.revoked.push(url);
      revoke(url);
    };
    window.fetch = (url, options) => new Promise((resolve, reject) => {
      const request = { url, options, resolve, reject };
      state.requests.push(request);
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    state.complete = (index, imageIndex = 0) => {
      const bytes = Uint8Array.from(atob(imageData[imageIndex]), character => character.charCodeAt(0));
      state.requests[index].resolve({
        ok: true, type: "cors", blob: async () => new Blob([bytes], { type: "image/jpeg" })
      });
    };
    if (storageUnavailable) {
      const original = window.indexedDB;
      state.restoreStorage = () => Object.defineProperty(window, "indexedDB", { value: original, configurable: true });
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get() { throw new DOMException("Storage disabled", "SecurityError"); }
      });
    }
  }

  async function dispose() {
    if (!frame) return;
    await evaluate("openArchive().then(db => db.close()).catch(() => {})");
    frame.remove();
    frame = null;
  }

  async function fixture({ reset = true, unavailable = false } = {}) {
    await dispose();
    if (reset) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase("camera-history");
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Test database is blocked"));
      });
    }
    frame = document.createElement("iframe");
    frame.width = "600";
    frame.height = "400";
    const loaded = new Promise(resolve => frame.onload = resolve);
    frame.srcdoc = source.replace("<script>", `<script>(${setup})(${JSON.stringify(images)}, ${unavailable});</script><script>`);
    viewer.append(frame);
    await loaded;
    win = frame.contentWindow;
  }

  async function storedFrames() {
    await evaluate("archiveQueue");
    return evaluate('archiveRequest("readonly", store => store.getAll())');
  }

  async function complete(index, imageIndex = 0) {
    evaluate(`testState.complete(${index}, ${imageIndex})`);
    await waitFor(async () => (await storedFrames()).length > 0, "archive commit");
    await evaluate("archiveQueue");
    await sleep(40);
  }

  function click(x, y, detail = 1) {
    win.document.dispatchEvent(new win.MouseEvent("click", { clientX: x, clientY: y, detail }));
  }

  function doubleClick(x, y) {
    click(x, y);
    click(x, y, 2);
    win.document.dispatchEvent(new win.MouseEvent("dblclick", { clientX: x, clientY: y, detail: 2 }));
  }

  async function startHistory() {
    const previous = evaluate("cam.src");
    doubleClick(500, 300);
    await waitFor(() => evaluate('historyStatus.textContent.startsWith("History:") && cam.src') !== previous &&
      evaluate('historyStatus.textContent.startsWith("History:")'), "playback frame");
  }

  test("Original JPEG bytes and source metadata survive a reload", async () => {
    await fixture();
    await complete(0, 1);
    const before = (await storedFrames())[0];
    assert(before.sourceUrl === evaluate("cameraUrls[0]"), "Source URL missing");
    assert(before.cameraIndex === 0 && before.id === 1, "Camera/order missing");
    assert(before.downloadedUrl.includes("?t="), "Download URL missing");
    const bytes = Array.from(new Uint8Array(await before.blob.arrayBuffer()));
    await fixture({ reset: false });
    const after = (await storedFrames())[0];
    assert(JSON.stringify(Array.from(new Uint8Array(await after.blob.arrayBuffer()))) === JSON.stringify(bytes), "JPEG bytes changed on reload");
    await complete(0);
    assert((await storedFrames())[1].id === 2, "Order did not persist across reload");
  });

  test("Overlapping downloads archive by completion, not request or decode order", async () => {
    await fixture();
    evaluate("activeIndex = 1; loadImageAndScheduleNext()");
    evaluate("activeIndex = 2; loadImageAndScheduleNext()");
    evaluate(`
      window.realImageLoaded = imageLoaded;
      window.releaseDecode = null;
      imageLoaded = source => new Promise(resolve => {
        releaseDecode = () => realImageLoaded(source).then(resolve);
      });
      testState.complete(2, 2);
    `);
    await waitFor(() => evaluate("!!releaseDecode"), "delayed decoding");
    evaluate("imageLoaded = realImageLoaded; testState.complete(0, 0); testState.complete(1, 1)");
    await sleep(40);
    assert((await evaluate('archiveRequest("readonly", store => store.getAll())')).length === 0, "Later decode overtook the queue");
    evaluate("releaseDecode()");
    await waitFor(async () => (await storedFrames()).length === 3, "all overlapping writes");
    const rows = await storedFrames();
    assert(rows.map(row => row.cameraIndex).join() === "2,0,1", "Completion order changed");
    assert(rows.map(row => row.id).join() === "1,2,3", "IDs are not monotonic");
  });

  test("Combined playback uses stored bytes, waits two seconds per displayed frame, and retains newest", async () => {
    await fixture();
    await complete(0);
    evaluate("activeIndex = 1; loadImageAndScheduleNext()");
    await complete(1, 1);
    evaluate("activeIndex = 2; loadImageAndScheduleNext()");
    await complete(2, 2);
    await startHistory();
    const first = evaluate("cam.src");
    assert(evaluate("historyStatus.textContent.includes(cameraUrls[0])"), "Playback did not start oldest");
    evaluate("testState.tick(1999)");
    assert(evaluate("cam.src") === first, "Frame changed before two seconds");
    evaluate("testState.tick(1)");
    await waitFor(() => evaluate("historyStatus.textContent.includes(cameraUrls[1])"), "second camera frame");
    const second = evaluate("cam.src");
    assert(second.startsWith("blob:") && second !== first, "Playback did not use saved bytes");
    evaluate("testState.tick(2000)");
    await waitFor(() => evaluate("historyStatus.textContent.includes(cameraUrls[2])"), "newest camera frame");
    const newest = evaluate("cam.src");
    evaluate("testState.tick(2000)");
    assert(!evaluate("playing"), "Playback did not finish");
    assert(evaluate("cam.src") === newest, "Final frame was not retained");
    assert(evaluate("testState.requests.length") === 3, "Playback downloaded remote images");
    assert(evaluate("[...testState.timers.values()].every(timer => timer.delay >= 60000 && timer.delay <= 120000)"), "Random refresh schedule lost");
    assert(evaluate("testState.created.filter(url => !testState.revoked.includes(url)).length") === 1, "Object URLs leaked");
    evaluate("testState.tick(120000)");
    assert(evaluate("testState.requests.length") === 4, "Live refresh did not resume");
  });

  test("Playback waits for display before starting the two-second timer", async () => {
    await fixture();
    await complete(0);
    evaluate("cam.decode = () => new Promise(resolve => window.finishDisplay = resolve)");
    doubleClick(500, 300);
    await waitFor(() => evaluate("typeof finishDisplay === 'function'"), "display decode");
    assert(evaluate("playbackTimer") === null, "Timer started before display");
    evaluate("testState.tick(5000); finishDisplay()");
    await waitFor(() => evaluate("playbackTimer !== null"), "post-display timer");
    evaluate("testState.tick(1999)");
    assert(evaluate("playing"), "Display duration shortened");
    evaluate("testState.tick(1)");
    assert(!evaluate("playing"), "Display duration exceeded two seconds");
  });

  test("Quadrant boundaries, left double clicks, zoom/pan rollback, and top-right refresh", async () => {
    await fixture();
    await complete(0);
    doubleClick(10, 10);
    doubleClick(10, 300);
    evaluate("testState.tick(350)");
    assert(evaluate("testState.requests.length === 1 && zoom === 1 && !playing"), "Left double click changed view");
    click(10, 10);
    evaluate("testState.tick(350)");
    assert(evaluate("zoom") === 1.25, "Left zoom was lost");
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    const pan = evaluate("panX");
    click(10, 10);
    evaluate("testState.tick(350)");
    click(10, 10, 2);
    win.document.dispatchEvent(new win.MouseEvent("dblclick", { clientX: 10, clientY: 10 }));
    assert(evaluate("zoom") === 1.25 && evaluate("panX") === pan, "Slow double click did not restore zoom/pan");
    doubleClick(300, 200);
    await waitFor(() => evaluate('historyStatus.textContent.startsWith("History:")'), "boundary bottom-right playback");
    doubleClick(300, 199);
    assert(evaluate("testState.requests.length === 2 && !playing"), "Boundary top-right did not refresh");
  });

  test("Slow right double click restores camera without downloading it before playback", async () => {
    await fixture();
    await complete(0);
    click(500, 300);
    evaluate("testState.tick(350)");
    assert(evaluate("activeIndex") === 4, "Right single-click cycle lost");
    click(500, 300, 2);
    win.document.dispatchEvent(new win.MouseEvent("dblclick", { clientX: 500, clientY: 300 }));
    await waitFor(() => evaluate('historyStatus.textContent.startsWith("History:")'), "slow double click playback");
    assert(evaluate("activeIndex === 0 && testState.requests.length === 2"), "Restoration made an extra download");
    assert(evaluate("testState.requests[1].options.signal.aborted"), "In-flight live load not canceled");
  });

  test("Restart/cancel guards stale sessions, timers, and late live completions", async () => {
    await fixture();
    await complete(0);
    evaluate("loadImageAndScheduleNext()");
    await startHistory();
    const first = evaluate("cam.src");
    evaluate("testState.complete(1, 2)");
    await sleep(40);
    assert(evaluate("cam.src") === first, "Late live load overwrote history");
    await startHistory();
    assert(evaluate("[...testState.timers.values()].filter(timer => timer.delay === 2000).length") === 1, "Restart leaked playback timer");
    click(500, 10);
    evaluate("testState.tick(350)");
    assert(!evaluate("playing"), "Camera cycling did not stop playback");
    assert(evaluate("[...testState.timers.values()].every(timer => timer.delay !== 2000)"), "Canceled playback timer survived");
    await complete(2, 1);
    const live = evaluate("cam.src");
    evaluate("testState.tick(2000)");
    await sleep(40);
    assert(evaluate("cam.src") === live, "Canceled session overwrote live view");
  });

  test("Playback snapshot drains already-completed archival writes", async () => {
    await fixture();
    evaluate(`
      window.realArchiveRequest = archiveRequest;
      window.releaseWrite = null;
      archiveRequest = (mode, action) => mode === "readwrite"
        ? new Promise(resolve => { releaseWrite = () => realArchiveRequest(mode, action).then(resolve); })
        : realArchiveRequest(mode, action);
      testState.complete(0);
    `);
    await waitFor(() => evaluate("!!releaseWrite"), "pending archive write");
    doubleClick(500, 300);
    await sleep(40);
    assert(evaluate("historyStatus.textContent") === "Loading image history…", "Snapshot skipped a pending write");
    evaluate("releaseWrite()");
    await waitFor(() => evaluate('historyStatus.textContent.startsWith("History:")'), "pending frame playback");
  });

  test("Restarting while an earlier playback image loads cannot overwrite the new session", async () => {
    await fixture();
    await complete(0);
    evaluate(`
      window.realImageLoaded = imageLoaded;
      window.releaseHistoryImage = null;
      imageLoaded = source => new Promise(resolve => {
        releaseHistoryImage = () => realImageLoaded(source).then(resolve);
      });
    `);
    doubleClick(500, 300);
    await waitFor(() => evaluate("!!releaseHistoryImage"), "older playback image load");
    evaluate("imageLoaded = realImageLoaded");
    await startHistory();
    const current = evaluate("cam.src");
    evaluate("releaseHistoryImage()");
    await sleep(80);
    assert(evaluate("cam.src") === current, "Older playback session overwrote the restarted session");
    assert(evaluate("[...testState.timers.values()].filter(timer => timer.delay === 2000).length") === 1, "Stale session scheduled a timer");
    assert(evaluate("testState.created.filter(url => !testState.revoked.includes(url)).length") === 1, "Stale playback URL leaked");
  });

  test("Empty history and unavailable storage return safely to scheduled live viewing", async () => {
    await fixture();
    doubleClick(500, 300);
    await waitFor(() => evaluate("historyStatus.textContent") === "No saved images yet.", "empty archive");
    assert(!evaluate("playing"), "Empty playback stayed active");
    await fixture({ unavailable: true });
    evaluate("testState.complete(0)");
    await waitFor(() => evaluate("cam.naturalWidth > 0 && archiveWarning.textContent.includes('could not be saved')"), "storage warning and live display");
    doubleClick(500, 300);
    await waitFor(() => evaluate("archiveWarning.textContent.includes('history is unavailable')"), "playback storage warning");
    assert(!evaluate("playing"), "Storage error did not restore live schedule");
  });

  test("Transient storage-open failures are retried on the next live download", async () => {
    await fixture({ unavailable: true });
    evaluate("testState.complete(0)");
    await waitFor(() => evaluate("archiveWarning.textContent.includes('could not be saved')"), "initial storage error");
    evaluate("testState.restoreStorage(); loadImageAndScheduleNext()");
    await complete(1, 1);
    assert((await storedFrames()).length === 1, "Storage open was permanently disabled");
  });

  test("Quota errors remain visible and do not prevent later archival attempts", async () => {
    await fixture();
    evaluate(`
      window.realArchiveRequest = archiveRequest;
      archiveRequest = (mode, action) => mode === "readwrite"
        ? Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError"))
        : realArchiveRequest(mode, action);
      testState.complete(0);
    `);
    await waitFor(() => evaluate("archiveWarning.textContent.includes('Quota exceeded') && cam.naturalWidth > 0"), "quota failure");
    assert((await storedFrames()).length === 0, "Failed write pretended success");
    evaluate("archiveRequest = realArchiveRequest; loadImageAndScheduleNext()");
    await complete(1, 1);
    assert((await storedFrames()).length === 1, "Later writes were lost");
    assert(evaluate("archiveWarning.textContent.includes('Quota exceeded')"), "Archival gap was silently hidden");
  });

  test("CORS fallback remains viewable without archiving remote URLs or invalid images", async () => {
    await fixture();
    evaluate(`
      window.realImageLoaded = imageLoaded;
      imageLoaded = source => source.startsWith("https:")
        ? realImageLoaded("data:image/jpeg;base64," + testState.imageData[0])
        : realImageLoaded(source);
      window.realDisplayImage = displayImage;
      displayImage = (source, objectUrl, current) => realDisplayImage(
        source.startsWith("https:") ? "data:image/jpeg;base64," + testState.imageData[0] : source,
        objectUrl, current);
      testState.requests[0].reject(new TypeError("Failed to fetch"));
    `);
    await waitFor(() => evaluate("cam.naturalWidth > 0"), "remote fallback display");
    assert(evaluate("archiveWarning.textContent.includes('CORS/network')"), "CORS failure hidden");
    assert((await storedFrames()).length === 0, "Unreadable remote URL archived");
    evaluate(`
      loadImageAndScheduleNext();
      testState.requests[1].resolve({ ok: true, type: "cors", blob: async () => new Blob(["not an image"]) });
    `);
    await waitFor(() => evaluate("archiveWarning.textContent.includes('invalid image')"), "invalid image warning");
    assert((await storedFrames()).length === 0, "Invalid image archived");
  });

  test("HTTP errors and opaque responses never enter the archive", async () => {
    await fixture();
    evaluate(`
      window.realImageLoaded = imageLoaded;
      imageLoaded = source => source.startsWith("https:")
        ? Promise.reject(new Error("Simulated fallback network failure"))
        : realImageLoaded(source);
    `);
    evaluate("testState.requests[0].resolve({ ok: false, type: 'cors', status: 503 })");
    await waitFor(() => evaluate("archiveWarning.textContent.includes('not readable')"), "HTTP error warning");
    assert((await storedFrames()).length === 0, "HTTP error archived");
    evaluate(`
      loadImageAndScheduleNext();
      archiveWarning.textContent = "";
      testState.requests[1].resolve({ ok: true, type: "opaque" });
    `);
    await waitFor(() => evaluate("archiveWarning.textContent.includes('not readable')"), "opaque response warning");
    assert((await storedFrames()).length === 0, "Opaque response archived");
  });

  const output = [];
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      output.push(`PASS ${name}`);
    } catch (error) {
      failures++;
      output.push(`FAIL ${name}\n${error.stack}`);
    }
    results.textContent = output.join("\n");
  }
  await dispose();
  window.testResults = { total: tests.length, failures };
  results.textContent += `\n\n${tests.length - failures}/${tests.length} passed`;
  document.title = failures ? "FAIL Camera history tests" : "PASS Camera history tests";
})();
