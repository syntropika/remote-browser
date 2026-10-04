# Remote Browser

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and Purpose

The owner and their agent share one persistent Chromium session. The owner observes the browser, takes control to browse or sign in, then returns control to the agent through MCP.

## Operating Context

The application runs in a custom Docker image on a Linux container host. The dashboard supports desktop and mobile browsers, including iOS password managers. Local access uses HTTP on loopback; remote deployments can use an SSH tunnel or an HTTPS reverse proxy.

## Capabilities and Constraints

- First-time setup creates one username/password account. The browser profile persists across container replacement.
- Desktop gives the remote display the full viewport and combines history, native address entry, tabs, control ownership, and More options in one rounded floating bottom dock. Its popovers open upward.
- Desktop uses the physical keyboard directly and automatically fits the display; Zoom and Keyboard controls are hidden there.
- Mobile keeps navigation, zoom, and control ownership actions in the top toolbar. A native keyboard input with an adjacent Enter action remains visible at the bottom.
- The mobile keyboard bridge activates only after the owner takes control and focuses the input; layout changes must never summon the keyboard automatically. An inline dismiss control appears on focus; the native keyboard handles deletion.
- Ownership and connection text remain available in More options on both layouts. Mobile icon actions retain accessible labels and 44px touch targets.
- More options includes API key management: named keys, one-time secret display, last-use metadata, and individual revocation. Management uses the dashboard session without taking browser control. Existing MCP access migrates as a revocable Initial key.
- More options includes a Files gallery with screenshot previews, native video playback, authenticated downloads, and confirmed deletion. Browser downloads and human uploads appear as document entries, up to 20 MiB each. Uploads can be attached by an agent when requested. A visible recording indicator opens the gallery and lets the owner stop an active recording. Files persist across container replacement.
- Agent automation uses MCP tools for documentation, task tab reservations, and code execution with explicit background tab targeting, with native Playwright, optional CDP sessions, compact accessibility snapshots, native element references, stable task-labelled tabs, annotated captures, and visible-browser video recording. Live documentation is also exposed as MCP resources, with an optional client skill for the workflow. No connection-time instructions are injected.
- Observation is read-only. Human control and agent operations must remain mutually exclusive.
- Password-manager hints and synchronous native input focus must survive visual changes.
- The frontend uses HTML, CSS, and TypeScript modules with noVNC. Server workflows use TypeScript and Effect.

## Brand Commitments

Use familiar, restrained interface conventions and consistent component vocabulary inspired by shadcn/ui.

Use softer, rounder shapes inspired by Apple interfaces: capsule controls, circular icon buttons, and generously rounded panels while preserving the shared-browser workflows.

## Product Principles

- Keep the shared browser central.
- Make control ownership explicit.
- Preserve browser sessions and account data.
- Support direct touch and keyboard interaction.

## Evidence on Hand

The running application, README, and integration tests establish the behavior. Mobile touch has been tested in Chromium emulation; physical iPhone keyboard behavior remains unverified.
