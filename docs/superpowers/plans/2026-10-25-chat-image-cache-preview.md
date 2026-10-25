# Chat image caching and in-page preview

**Goal:** Reuse private chat image bytes through browser caching, and preview uploaded/generated images inside the current page with standard image controls.

**Scope:** The user reported repeated image downloads and requested in-page zoom/close behavior. The current Manager route explicitly sends `no-store`; thumbnails open a new tab. Keep conversation ownership, authenticated routes, source URL filtering and downloads.

**Approach:** Reuse Ant Design PreviewGroup with keyboard-operable thumbnail buttons. Keep the viewer in the page, with native zoom, rotation, pan, image switching and Escape/close controls. Both uploaded and generated message images use the shared component. No additional dependencies or external image hosts.

**Caching:** Send `Cache-Control: private, no-cache`, a content-derived ETag and `Vary: Cookie`. Browser storage is allowed, but requests revalidate after session and image ownership checks. Matching conditional GET/HEAD requests return 304 without retransmitting image bytes. Unauthorized, foreign and deleted images must never return 304. Do not enable shared Nginx/CDN caching for authenticated Admin data.

The user also requested a global JS/CSS and other resource-cache check. Retain the existing immutable year-long policy for hashed assets and no-store HTML/API behavior; add conditional ETags to static resources, preserving distinct compressed representations and fresh HTML CSP nonces. Verify actual Chromium cache reuse for both JS and CSS.

## Tasks

- [x] Reproduce the missing browser cache and viewer behavior with failing tests.
- [x] Implement conditional private image responses, retaining authentication and ownership checks.
- [x] Add shared page-local previews and keep thumbnail layout/downloads.
- [x] Verify actual Chromium HTTP cache behavior without request interception, including deletion/logout. Private images revalidated with 304; hashed JS/CSS reused cached bytes with zero transfer and conditional reloads returned 304.
- [x] Verify gallery controls, keyboard and phone layouts; run application/browser/release checks and independent review.
- [x] Document proxy/cache behavior and prepare the verified changes for PR #7.

## Review focus

- Revalidation must not bypass revoked sessions, deletion or conversation ownership.
- Private responses and cookies must not be treated as public shared-cache entries.
- Uploaded/generated images retain stable authenticated URLs; unsafe URLs remain excluded.
- Preview operations stay in the current tab and do not affect chat drafts, streaming, navigation or deletion.
- Use synthetic account/image fixtures only. Keep temporary logs and captures in `.tmp/`.

## Verified results

- Final combined tree with the loading improvements: 293 application tests, 144 browser tests, TypeScript/Admin build and release validation passed (86 modules, 3 JSON resources). Whitespace checks passed.
- Native HTTP-cache tests observed initial 200 then underlying 304 while the browser reused private image bytes; hashed JS/CSS fresh hits transferred zero bytes. Revoked sessions, foreign/deleted images and fresh HTML retained their boundaries.
- Zoom in/out, rotation, image switching, keyboard opening/Escape and phone/landscape close controls passed. The independent review found a missing preview dialog label, reproduced and fixed; no review findings remain unresolved.
