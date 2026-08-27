# Pravidhi — logo generation prompts (Gemini)

**Name:** Pravidhi (Sanskrit/Hindi प्रविधि — *method, technique, systematic process*).
**What it is:** The Element's internal operations platform — orders, delivery, inventory, purchasing, finance, support — one system that runs the business.
**Existing identity to honour (from the app):** deep indigo → violet gradients (#312e81 → #4f46e5 → #7c3aed), near-black navy grounds (#0b0f26 / #111536), soft indigo glow, an emerald (#10b981) success accent, rounded-square white tile for the app icon.

---

## 1 · Master prompt (wordmark + monogram, the one to start with)

```
Design a premium, modern logo for "Pravidhi" — an enterprise operations platform for an e-commerce
company. The name is Sanskrit for "method / systematic process". Spell the name EXACTLY as
"Pravidhi" (capital P, then lowercase), no other words, no typos.

Concept: a monogram mark built from a stylised letter "P" whose bowl is formed by three thin
concentric arcs that resolve into a single continuous stroke — suggesting a process that flows from
many steps into one clean outcome. The arcs are geometric and precise, like a fingerprint of order.
The mark should feel like it belongs to a serious operations tool, not a consumer app: calm,
authoritative, engineered.

Style: flat vector, clean geometry, generous negative space, optically balanced. No gradients inside
the letterforms; the ONLY gradient is on the monogram mark: deep indigo (#312e81) to violet
(#7c3aed), with a subtle inner glow. Wordmark set in a refined geometric sans-serif (in the spirit of
Inter / Söhne / Neue Haas Grotesk), medium weight, tight tracking, the "P" of the wordmark echoing
the monogram. Wordmark colour: near-white (#e0e7ff) on dark, or deep navy (#0b0f26) on light.

Composition: horizontal lockup — monogram on the left, "Pravidhi" wordmark to the right, aligned to
the cap-height, one clear-space unit between them. Centred on a plain dark navy background
(#0b0f26). Studio-lit, crisp edges, no shadows on the ground, no mockups, no 3D, no photographic
textures.

Quality bar: this should look like the work of a top-tier brand studio — Pentagram-level restraint.
Timeless rather than trendy. Balanced stroke weights. It must read perfectly at 24px as a favicon and
at 2 metres on a wall.

Avoid: shopping carts, boxes, trucks, arrows, globes, gears, cogs, generic "tech" swooshes, circuit
lines, clip-art, stock icons, more than two colours, drop shadows, bevels, chrome, glossy effects,
any text other than the word "Pravidhi", any Devanagari unless requested.

Output: one logo, high resolution, square canvas, the lockup occupying ~60% of the width.
```

## 2 · App-icon prompt (the square tile used in the dashboard, favicon, splash)

```
Design the app icon for "Pravidhi", an enterprise operations platform. Icon only — NO text.

A rounded square tile (corner radius ~22% of width) filled with a diagonal gradient from deep indigo
(#312e81) at top-left to violet (#7c3aed) at bottom-right, with a faint soft inner glow near the
top edge. Centred on the tile: a bold white monogram "P" whose bowl is formed by three thin
concentric arcs resolving into one continuous stroke — a process converging into a single outcome.
The mark is geometric, precise and optically centred, occupying ~55% of the tile.

Flat vector, crisp edges, no bevel, no gloss, no 3D, no drop shadow on the tile itself. Present it on
a plain white background AND once more on a plain dark navy (#0b0f26) background, side by side,
identical tile. It must remain legible at 16px.

Avoid: carts, boxes, arrows, gears, globes, swooshes, circuit patterns, stock icons, extra text.
```

## 3 · Variant prompt — bilingual / cultural depth (optional exploration)

```
Design a premium logo for "Pravidhi" (Sanskrit प्रविधि: method, systematic process), an enterprise
operations platform. Concept: a monogram where the Latin letter "P" and the Devanagari letter "प"
share one geometric stroke — two scripts, one system. Keep it abstract and elegant, never literal or
ornamental; a viewer should sense the Devanagari echo without it being loud.

Flat vector, deep indigo (#312e81) to violet (#7c3aed) gradient on the mark only, wordmark
"Pravidhi" in a refined geometric sans-serif, near-white (#e0e7ff), set to the right of the mark.
Optionally a small, quiet Devanagari "प्रविधि" in a light weight beneath the wordmark, 40% of its
size, letterspaced. Dark navy background (#0b0f26). Studio-quality, restrained, timeless.

Avoid: ornate calligraphy, mandalas, lotus motifs, religious symbols, gold/saffron palettes, carts,
boxes, arrows, gears, gloss, 3D, shadows, any typos in "Pravidhi".
```

## 4 · Follow-up refinement lines (paste after a result you like)

- "Keep everything, but make the monogram strokes 15% thinner and increase the gap between arcs."
- "Same logo, now give me the horizontal lockup on a pure white background, wordmark in #0b0f26."
- "Same logo, produce a monochrome single-colour version in white only, for embossing."
- "Same monogram, show it inside a rounded-square app icon tile at 512×512, centred, no text."
- "Tighten the wordmark tracking slightly and align the wordmark cap-height to the monogram's top arc."

## Deliverables to save into the app

Replace `app/static/assets/ecom-logo.png` (keep the filename — every splash, loader, login and confirm
dialog references it) with the square **app-icon** version at 512×512 PNG, transparent or white
background. Optionally add a horizontal lockup for the sidebar later.
