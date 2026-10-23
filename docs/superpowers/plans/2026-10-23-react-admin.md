# React Admin Implementation Plan

**Goal:** Fully replace the native-JS Admin frontend with React + TypeScript + Ant Design.

**Spec:** ../specs/2026-10-23-react-admin-design.md

**Architecture:** Typed API/context and shared Ant Design controls, independent React page modules, Vite production bundle served by Manager. Existing backend lifecycle and plugin contracts stay unchanged.

**Constraints:** Node 24; synthetic tests only; no deployment; remove all legacy frontend runtime sources; preserve authenticated API and CSP boundaries.

## Tasks

- [x] Add build/type configuration, frontend contracts, localization, API context, application shell and model picker.
- [x] Port overview, chat, tasks/artifacts, plugins, schedules and configuration/password flows to React/Ant Design.
- [x] Replace static serving and Docker/CI/release packaging; remove legacy sources and update resource tests.
- [x] Adapt browser assertions to Ant Design controls; verify all existing behaviors, mobile layout and offline/model scenarios.
- [x] Review complete changes, resolve correctness findings, run final checks and document upgrade.

## Progress

Model configuration prerequisite complete. User chose React + TypeScript + Ant Design and explicitly authorized complete migration; no alternate framework or legacy fallback will be retained.

Final verification: strict TypeScript and Vite build passed; release check passed (61 modules, 2 JSON resources); 196 npm tests in Linux plus 1 host Compose test passed; 25 browser tests passed. Four Docker targets built with the documented temporary omission of unreachable Debian CA installation. Review findings were fixed with RED-to-GREEN browser regressions. Legacy frontend source and routes are removed.
