# Complete React Admin migration

The user explicitly requests finishing model settings, then completely replacing the Admin frontend with React, TypeScript and Ant Design, leaving no legacy frontend implementation. Model settings verification before migration: 190 isolated Linux tests, 20 browser flows and release-source validation passed. The unchanged production Docker base build encountered an external Debian mirror failure; isolated tests used a temporary image with Node's public CA roots.

Replace all seven surfaces (sign-in plus six authenticated views), including shared form fields, model/effort selectors, notices, navigation, tables, task artifacts and management chat. Preserve all existing API contracts, authentication, origin checks, prompt ownership, schedules, result semantics, language preferences, mobile access, unsaved drafts and model inheritance. Do not add a second frontend, native DOM rendering bridge, legacy fallback or CDN dependencies.

Use React with strict TypeScript, Ant Design and Vite. Split pages and typed API/contracts from shared React context/components and localization. Existing interface translations move into TypeScript; business data remains untranslated. React state owns drafts, not captured DOM values. Ant Design provides visible application controls; custom CSS handles layout and branding only.

Bundle assets at build time into src/manager/web-dist (ignored generated output). Manager serves this single production bundle, rejects traversal and unknown assets, and applies a CSP nonce to Ant Design's dynamic styles. Keep authentication cookies and same-origin APIs. Remove the former src/manager/web application, picker, CSS, HTML and localization resources after migration.

Docker builds the frontend in a dedicated stage and copies only its production output into runtime images. Frontend build dependencies remain development dependencies. npm test builds Admin first; browser tests target the same production bundle. Release validation checks referenced bundled assets and rejects obsolete frontend files. Update CI, packaging and documentation accordingly.

Verification: TypeScript, production Vite build, existing/new unit checks, browser tests for every workflow and language, mobile geometry, model controls, offline catalog, drafts, polling, artifacts, password/session behavior, static routes and CSP, plus all Docker targets where network allows. No real account, model turn or local platform deployment.
