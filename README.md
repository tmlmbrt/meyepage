# meyepage
Starter static web page with JavaScript for hosting on GitHub Pages.

## Camera controls and history

- Single-click the left top/bottom half to zoom in/out; arrow keys pan.
- Single-click the right top/bottom half to cycle cameras forwards/backwards.
- Double-click the top-right quadrant to refresh the current camera immediately.
- Double-click the bottom-right quadrant to start/restart saved history, oldest
  first across all five cameras. Each displayed frame stays for two seconds.
  Left-side double-clicks do not refresh or play history.

Successful, browser-readable image downloads are saved as original image Blobs,
with source/camera metadata and download-completion order, in **IndexedDB**.
This is browser-local storage that survives reloads on the same origin/profile.
It is used instead of `localStorage` because binary JPEG archives quickly exceed
its small string quota. There is no application-imposed rolling cap or deletion.
Browser quotas still apply, and browsers/users can clear or evict site data;
this is not a guaranteed permanent backup. Storage failures appear on screen,
leave existing history untouched, and do not disable live viewing.

Playback uses saved bytes, not changing remote URLs, and reads one frame at a
time. It pauses automatic refresh and cancels stale live display updates.
Completed archival writes are included before taking the playback snapshot.
At completion the newest saved frame remains visible until the next randomized
1–2 minute live refresh or a deliberate camera/refresh action. Camera cycling
and top-right double-clicks cancel playback.

### Cross-origin deployment limitation

The external camera servers must permit CORS reads from the deployed page's
origin (for example, its GitHub Pages origin). A successful remote `<img>` display
does **not** prove that JavaScript can read its bytes. If CORS or the network
prevents a readable download, the viewer attempts ordinary remote image display
and visibly warns that the frame cannot be archived. Such frames are absent
from playback. No opaque `no-cors` response, proxy, or URL-only substitute is
stored. Permissions must be verified on the actual deployment; this static page
cannot grant itself permission to read another server's images.

### Browser tests

There are no build dependencies. From the repository root, run
`python3 -m http.server 8000` and open
`http://localhost:8000/tests/history.html`. The dependency-free tests use real
browser IndexedDB and JPEG decoding, controlled download completions, and a
virtual refresh/playback clock. They cover reload persistence, ordering,
playback timing and cancellation, quadrant controls, and storage/CORS failures.
Camera responses are simulated in these tests; they do not establish that the
external servers grant CORS access in production.
