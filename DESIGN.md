---
name: Wallpaper Companion
description: A quiet local workspace for exploring installed wallpapers and saved playlists.
colors:
  accent: "#b5d6be"
  selection-surface: "#29352e"
  selection-ink: "#d1e7d7"
  available-ink: "#c3d6c9"
  tag-surface: "#29302e"
  warning-ink: "#dec29f"
  focus: "#c5e8ff"
  surface: "#181a1b"
  rail: "#141617"
  raised: "#222526"
  ink: "#edeeed"
  muted: "#aeb5b5"
  line: "#363b3c"
  field-border: "#505859"
  control-hover: "#303536"
  control-active: "#3b4341"
  preview-surface: "#232829"
typography:
  headline:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "1.8rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "1rem"
    lineHeight: 1.55
  label:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "0.8rem"
  caption:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
  metadata:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "0.75rem"
  code:
    fontFamily: "Consolas, monospace"
    fontSize: "0.85rem"
    lineHeight: 1.6
rounded:
  tag: "4px"
  field: "5px"
  control: "6px"
  image: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
  section: "28px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-hover:
    backgroundColor: "{colors.control-hover}"
  button-active:
    backgroundColor: "{colors.control-active}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    padding: "4px 0"
  input:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "9px 12px"
  navigation:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
    width: "100%"
  navigation-selected:
    backgroundColor: "{colors.selection-surface}"
    textColor: "{colors.selection-ink}"
  wallpaper:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "0"
    rounded: "0"
  tag:
    backgroundColor: "{colors.tag-surface}"
    textColor: "{colors.available-ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.tag}"
    padding: "5px 8px"
---

# Design System: Wallpaper Companion

## Overview

**Creative North Star: "The Quiet Local Gallery"**

A charcoal workspace gives wallpaper imagery the visual lead. Familiar system typography, restrained sage selection, and compact native controls keep the interface calm and immediately usable.

The system favors useful density and progressive disclosure: titles and previews support scanning; additional metadata appears when requested. Surfaces are understated, with tonal differences and fine borders providing structure.

**Key Characteristics:**
- Charcoal surfaces with pale primary ink and readable secondary ink.
- Segoe UI and system sans throughout the interface.
- Restrained sage selection and distinct keyboard focus.
- Image-led content with flat captions and native controls.
- Optional details and disclosures that protect the scanning rhythm.

## Colors

The palette is neutral and quiet; imagery supplies most of the visual variety. Exact reusable values are owned by the frontmatter and extracted from `ui/src/style.css`.

### Primary

- **Sage** (`accent`): selected image outlines, text actions, input caret, and text selection.
- **Deep Sage / Pale Sage** (`selection-surface`, `selection-ink`): the selected navigation row.
- **Soft Sage Ink / Dark Sage Tag** (`available-ink`, `tag-surface`): availability text, selected counts, and descriptive tags.

### Secondary

- **Warm Sand** (`warning-ink`): missing or unsupported file status. Pair color with explicit text.

### Neutral

- **Charcoal Canvas** (`surface`): main workspace.
- **Deep Charcoal** (`rail`): header, navigation, fields, details, and code blocks.
- **Raised Charcoal** (`raised`): default controls.
- **Pale Ink / Secondary Ink** (`ink`, `muted`): primary content and supporting context.
- **Fine Divider / Field Stroke** (`line`, `field-border`): structural separators and control boundaries.
- **Control Hover / Pressed Charcoal** (`control-hover`, `control-active`): default button interaction states.
- **Preview Charcoal** (`preview-surface`): the image region while imagery is absent or unavailable.
- **Ice Focus** (`focus`): visible keyboard outlines, independent of selection.

**The State Has Meaning Rule.** Reserve sage for selection and small functional accents; availability and warning colors accompany readable status text.

## Typography

**Interface Font:** Segoe UI, with system-ui and sans-serif fallbacks.
**Code Font:** Consolas, with a monospace fallback.

**Character:** Familiar, direct, and quiet. A fixed rem scale separates headings, captions, labels, and metadata without decorative display typography.

### Hierarchy

- **Headline:** the current view heading; use the frontmatter headline role. Narrow views reduce it to (1.6rem).
- **Title:** secondary headings; empty states use (1.5rem), detail titles use (1.35rem), and narrow empty states use (1.3rem).
- **Body:** explanatory text, with a maximum reading measure of (70ch).
- **Caption:** wallpaper titles, kept to two lines with long words wrapping.
- **Label:** search, filters, result counts, timestamp, and detail context.
- **Metadata:** type, counts, tags, and supporting source information.
- **Code:** local scan commands. Wrap long commands and paths rather than forcing horizontal scrolling.

The brand uses a compact semibold treatment (1.05rem). Navigation and filter values use (0.875rem); playlist section labels use metadata size and medium weight. Counts, timestamps, and ordered positions use tabular numerals. These supporting labels remain sentence case.

**The Familiar Voice Rule.** Use the same system sans across controls and content; establish hierarchy through size, weight, and spacing.

## Layout

The app header is (76px) high on wide screens. The workspace places a (232px) navigation rail beside a flexible content region. Main content uses (34px 36px 28px) padding. The gallery surface's specific composition and success criteria remain in `.impeccable/surfaces/gallery.md`.

The image grid uses auto-filled columns with a minimum width of (230px), with row and column gaps of (24px 22px). Preview regions have a (16:10) aspect ratio; grid images cover their region. Captions sit below images with (12px) top spacing. Search grows to a maximum width of (480px), while filters disclose additional fields.

At (1200px) and above, an open detail region occupies a (360px) right column with its own reserved content space. Below that threshold, detail appears inline above the grid with image and copy side by side. At (760px) and below, the header stacks, the rail becomes a native View selector, main padding becomes (26px 20px), details stack vertically, filters use one column, and the gallery uses two columns with (24px 14px) gaps. At (360px) and below, the gallery uses one column.

Use the extracted spacing scale for recurring gaps and inset rhythm. Specific shell dimensions belong to this gallery implementation rather than every future surface.

**The Progressive Disclosure Rule.** Keep source paths, diagnostics, and secondary filters behind native disclosures until requested.

## Elevation & Depth

There are no decorative box shadows. Depth comes from the charcoal canvas, darker structural regions, fine borders, and controlled state outlines. The detail region shares the rail tone rather than floating above the workspace.

Keyboard focus uses a solid outline (2px) with an offset of (4px). Selected images use a sage outline (2px); their preview outline offset is (3px). Image hover uses a subtle neutral outline and a short outline-color transition (160ms ease-out). Reduced-motion preference removes transitions.

**The Tonal Structure Rule.** Separate regions through tone and spacing; keep gallery images on the canvas without enclosing raised cards.

## Shapes

Forms have modest rounded corners: tags, fields/navigation, controls, and imagery use their corresponding frontmatter radius tokens. Preview imagery is clipped to its region. The detail container shares the image corner language, while the image inside it has square edges against the container. Structural and field borders are thin (1px).

## Components

### Buttons

Compact and familiar. Default buttons use raised charcoal, fine divider borders, the control radius, and the frontmatter padding, with a minimum height of (42px). Hover and pressed states use their extracted sibling tokens. Disabled buttons reduce opacity to (0.55) and show a wait cursor.

Quiet buttons have a transparent resting surface and minimum height of (36px); they serve Refresh index and Close details. Text actions use sage ink with no border, a minimum height of (32px), and an underline on hover. All interactive controls retain visible keyboard focus.

### Inputs / Fields

Native search and select controls use deep charcoal, field strokes, and the field radius, with a minimum height of (42px). Search has a persistent visible label and muted placeholder; the caret uses sage. Native selects retain their platform affordance.

### Navigation

Flat rows use the field radius and compact padding. A selected row uses deep sage and pale sage ink; counts remain aligned at the row's end. Long playlist names wrap. At the narrow breakpoint, a labeled native selector replaces the rail list.

### Gallery Items

Images lead; captions rest directly on the canvas. The wallpaper button has no enclosing surface, border, padding, or radius. Its preview owns clipping, hover, and selected outlines. A keyboard focus outline remains visible on the item. Titles clamp to two lines with type below; ordered playlist entries add a quiet tabular sequence number.

Missing previews keep the same image region with explicit fallback text. Unresolved playlist entries retain their position and render as noninteractive items. Detail previews use contain rather than cover to show the complete image.

### Detail Region

A focused reading area, with a compact header and close action, large preview, title, availability text, definition list, and optional tags. Selecting an item focuses this region. Escape or Close details returns focus to the originating item. Paths remain in Local source details.

### Tags / Disclosures

Tags are descriptive labels, with dark sage surfaces and soft sage ink; they are not filter chips. Filters, Local source details, and Index details use native disclosure controls. Index details are separated from primary content by a fine divider and generous spacing.

### Feedback States

Loading uses static preview-shaped placeholders. Errors use an understated warm charcoal region with clear retry copy. Empty and no-match states use a heading, supporting text, and a relevant action where applicable. Unavailable files always retain readable status text.

## Do's and Don'ts

### Do:
- Do let wallpaper imagery lead while controls and metadata stay quiet.
- Do preserve native selects, disclosures, visible labels, and keyboard focus.
- Do pair state colors with explicit text and preserve unavailable image regions.
- Do use progressive disclosure for source paths, diagnostics, and secondary filters.
- Do preserve long-title wrapping and the narrow selector with inline details.

### Don't:
- Don't add decorative gradients, nested cards, or emojis.
- Don't turn library browsing into a metrics dashboard.
- Don't use sage as a large decorative fill.
- Don't expose all source metadata in the primary scanning view.
- Don't replace the approved system sans with decorative display typography.
