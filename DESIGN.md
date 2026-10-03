---
name: Remote Browser
description: A shared browser with clear, compact controls.
colors:
  background: "#09090b"
  foreground: "#fafafa"
  card: "#18181b"
  popover: "#18181b"
  primary: "#fafafa"
  primary-foreground: "#18181b"
  secondary: "#27272a"
  muted-foreground: "#a1a1aa"
  border: "#3f3f46"
  input: "#52525b"
  ring: "#d4d4d8"
  success: "#86efac"
  warning: "#fcd34d"
  destructive: "#fca5a5"
typography:
  headline:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  field:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    lineHeight: 1.4
  caption:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  control: "16px"
  pill: "999px"
  panel: "24px"
  toolbar: "30px"
spacing:
  compact: "4px"
  control: "8px"
  inset: "12px"
  panel: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.destructive}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  text-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  navigation:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.toolbar}"
    padding: "10px"
  tab-row-active:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
  floating-panel:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "16px"
---

# Design System: Remote Browser

## Overview

**Creative North Star: "Shared browser, clear controls"**

The system combines shadcn/ui-style component consistency with softer, rounder forms. Capsule actions, circular icon controls, and rounded groups bring an Apple-inspired shape language to the existing dark zinc palette, restrained outlines, and compact system typography. Components use native HTML and CSS without a React or shadcn/ui dependency.

The live browser is the main surface. Navigation and control ownership remain easy to find while secondary actions sit in popovers. Desktop combines navigation and session actions in one rounded dock floating at the bottom, leaving the remote display to fill the viewport. On mobile, navigation and session actions sit above the display while a native keyboard input with an adjacent Enter action remains visible below it.

**Key Characteristics:**

- Quiet neutral surfaces with a high-contrast primary action.
- Capsule actions and rounded groups with consistent nested corners.
- Explicit ownership and connection state.
- Shared components across sign-in, navigation, and session tools.
- Native input behavior with touch-sized mobile controls and a persistent bottom keyboard input.

## Colors

The palette progresses from near-black canvas through zinc surfaces to white actions and text. CSS custom properties in `public/styles.css` are the implementation source for the frontmatter tokens.

### Primary

- **White action:** `primary` and `primary-foreground` identify the next main action, including taking or returning control.

### Neutral

- **Canvas:** `background` frames the remote display and provides field interiors.
- **Raised surface:** `card` and `popover` define the toolbar, control dock, and transient panels.
- **Selected surface:** `secondary` marks active tabs, pressed controls, and hover states.
- **Text:** `foreground` carries primary labels; `muted-foreground` carries supporting detail.
- **Edges:** `border` separates surfaces, `input` defines fields, and `ring` marks keyboard focus.

Success green, warning amber, and destructive red communicate state. Status also has a text label; color alone does not identify control ownership.

## Typography

Use the system sans-serif stack throughout with optical sizing enabled where supported. Sign-in and account settings use larger headings. Workspace headings, labels, and descriptions stay compact so the remote page receives most of the space.

- **Headline:** sign-in and settings titles.
- **Body:** descriptions and form labels; form labels use medium weight.
- **Label:** actions and tab titles.
- **Field:** native form inputs, the address field, and the bottom mobile keyboard input.
- **Caption:** connection state, tab URLs, and short supporting text.

Address and keyboard inputs retain field sizing to avoid automatic input zoom.

## Layout

The desktop remote display fills the visual viewport. One rounded bottom dock contains history, a native address field, tabs, the ownership action, and More options. It is centered, up to 1000px wide with at least 16px side clearance, and offset by 20px or the bottom safe-area inset, whichever is greater. The outer card has a 1px border, 30px corners, and 10px padding; the inner toolbar is transparent with an 8px gap and no extra padding. Branding, Zoom, and Keyboard controls stay out of the desktop dock. The display automatically fits when switching to desktop, and a physical keyboard types directly into the focused remote field. The authentication form is centered with a maximum width of 384px.

At widths up to 760px, the top toolbar, remote display, and persistent bottom keyboard input form a vertical stack. The same arrangement applies to coarse-pointer screens up to 960px wide and 520px tall. The top toolbar includes history, tabs, zoom, and control ownership actions; zoom and ownership use plain icons with 44px touch targets and accessible labels. Ownership and connection text remain available in More options. Native keyboard resize updates the workspace height, and compact mode reduces the bottom input padding to preserve display space.

Desktop tabs and More options open upward above the dock. Tabs align to the dock's right edge with a 12px gap; More options opens above its trigger. The tab list is scrollable and bounded by the available height. On mobile, tabs use a sheet above the bottom input. Safe-area insets protect controls at screen edges. The spacing vocabulary is compact and consistent; larger gaps separate distinct tasks rather than individual controls.

One-finger swipes scroll the remote page in the fitted mobile view. In actual-size zoom, one finger pans the display and two fingers scroll the page. Taps retain their click behavior. These gestures obey control ownership.

## Elevation & Depth

Depth comes from opaque tonal surfaces and thin borders. The current system uses no box shadows or backdrop blur. Layer ordering separates navigation, control tools, tab panels, and notices.

Panels enter with a small upward movement and fade over 160ms. Control colors transition over the same duration. Enabled buttons scale to 0.97 on press with a 120ms ease-out transition. Reduced-motion preference removes animations, transitions, and press scaling.

## Shapes

Buttons and the address group use a 999px pill radius; square icon controls become circles. Fields, menu items, notices, and tab rows use 16px corners. Popovers use 24px corners and the floating desktop control dock uses 30px corners. The selected tab button uses 15px corners inside its 16px row. Brand marks use 14px corners at 40px and 11px corners at 32px; menu items retain the shared 16px corner treatment.

On mobile, the top toolbar retains 24px lower corners and the bottom stack retains 24px upper corners on the card surface. Flush edges stay square so the controls remain part of the viewport layout. Compact state dots remain circular. Outline icons use consistent rounded strokes and remain secondary to text labels.

## Components

### Buttons

Default buttons have a white fill and dark text. Outline buttons use a thin border, while ghost buttons keep secondary tools quiet. Destructive actions use red text. Hover and pressed states change the surface, and a small press scale provides tactile feedback; disabled controls reduce opacity. Keyboard focus uses a visible outer ring.

### Inputs / Fields

Fields have dark interiors, visible borders, and native labels. The capsule address group contains a native input and circular submit button with a shared focus outline. The mobile keyboard input stays visible with Enter beside it, but remains disabled without human control. Native input focus activates the bridge without autofocus and reveals an inline dismiss control. Dismissal clears and blurs the input while keeping it visible. Preserve autocomplete attributes, native focus behavior, and synchronous focus in user gestures when changing markup.

### Navigation

Circular history controls, the capsule address field, and tab management form one compact navigation group. Desktop places that group, the ownership action, and More options in the same rounded bottom dock. More options contains ownership and connection text on both layouts, alongside occasional session actions. Mobile keeps the address field above history, tabs, zoom, and ownership controls. The same toolbar and ownership elements move between the desktop dock and mobile top bar so state and event handlers stay shared. Zoom is visible only on mobile; accessible action labels remain available on both layouts.

Mobile zoom and ownership actions use transparent backgrounds and borders at rest, matching the history controls. Zoom state changes its icon, while the ownership action retains its state color and accessible action label. Hover and press feedback change the icon color without adding a circular background.

### Tabs

Each tab row contains a title, a muted URL, and an independent close action. The active row uses the selected surface and border. Long titles and URLs truncate; the list scrolls inside its panel.

### Floating Panels

Tabs and clipboard tools share outlined opaque surfaces and clear headings. Desktop tabs and More options open upward from the bottom dock; clipboard tools sit above it. Desktop uses direct physical keyboard input. On mobile, the keyboard panel remains a persistent bottom input on the card surface, with an inline dismiss control revealed by focus. Clipboard tools open above it; the containing stack retains its rounded upper corners.

### Control Dock

Desktop has one floating dock for history, address entry, tabs, a prominent Take control or Return to agent action, and More options. It has no separate top app bar. Ownership and connection text live in More options on both layouts. Mobile retains its top toolbar and persistent bottom keyboard input, with Zoom available in the top toolbar.

### API Key Settings

More options opens a dedicated API keys view with a Back to browser action. The
settings view fills the viewport while preserving the live display's geometry;
browser controls become inert until settings close. Content is centered within
744px including 32px side padding on desktop and uses 20px side padding on
mobile. The panel scrolls independently and respects safe areas.

A rounded connection panel contains the MCP URL and authorization instructions.
A labeled name field and primary Create key action precede the active key list.
Names wrap, prefixes use monospace text, and creation and last-use dates remain
secondary. New secrets appear once in a copyable native field and are cleared
when settings close, the session ends, or the page unloads. Copy has a native
selection fallback for HTTP. Revocation uses inline confirmation with Cancel
and Revoke key actions, and returns focus to the refresh control on success.

### Files Gallery

Files shares the full-viewport settings layout with API keys. Saved screenshots
and videos use a two-column gallery on desktop and one column on mobile. Media
previews preserve their aspect ratio without cropping; images open at full size
and videos use native playback controls with inline mobile playback. Each item
shows its name, type, size, date, Download action, and a Delete action with inline
confirmation. The empty state explains how agent-created files appear here.

An active recording appears in a compact card above the gallery with its name
and Stop recording action. A small labeled recording indicator sits above the
browser's bottom controls and opens the gallery. Both layouts retain usable
touch targets, safe-area spacing, and the existing zinc palette.

## Do's and Don'ts

### Do:

- Do use the shared button variants, field treatment, and panel surfaces.
- Do preserve the radius hierarchy: capsule actions, 16px fields, 24px panels, and a 30px desktop dock.
- Do preserve text labels for connection and ownership state.
- Do retain native inputs, visible focus, safe areas, and touch targets.
- Do keep the bottom mobile input visible without automatically focusing it.
- Do keep desktop navigation and session actions in one bottom dock and open its popovers upward.
- Do keep the live browser central when adding controls.

### Don't:

- Don't introduce a second accent palette for routine actions.
- Don't replace native form fields with canvas-only interactions.
- Don't change authentication or control ownership behavior as a visual adjustment.
- Don't rely on color alone to explain state.
