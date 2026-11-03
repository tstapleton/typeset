# typeset

CLI that takes a TypeScript (Angular 20) feature directory, extracts its interfaces, type
aliases and enums with ts-morph, and renders a self-contained `index.html` showing model
cards grouped by directory, model → model references, and code → model usages.

## Key documents

- `README.md`: what it does, CLI flags, how to read the diagram
- `docs/design.md`: pipeline, graph schema and determinism rules, reference projects and
  licenses, rendering choice, known limitations
- `src/graph.ts`: the graph schema (the contract between extraction and rendering)

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run verify` | build + Biome + fallow audit + tests + sample drift check (pre-commit) |
| `npm run diagram:fixture` | Diagram the fixture into `dist/fixture` |
| `npm run docs:sample:generate` | Regenerate `docs/sample/` after an intentional rendering change |

## Layout

- `src/extract/`: the only code that touches TypeScript. Produces a `ModelGraph`.
- `src/render/`: reads `ModelGraph` only; never imports from `src/extract/`.
- `src/render/directories.ts`: the directory view's layout and SVG.
- `src/render/shared.ts`: the shared view's layout and SVG.
- `src/evidence.ts`: pure facts derived from the graph. No recommendations, no scores.
- `src/template.html`: the page; `src/render/html.ts` inlines the SVG and JSON into it.
- `fixtures/feature-app/`: the test feature (`src/app/features/orders`). Formatted with
  Prettier (Angular style), excluded from Biome.

## Always / Never

**Always:**
- Keep output deterministic: sort with `compareStrings`, no timestamps or absolute paths,
  ids built only from feature-relative paths and names.
- When rendering changes intentionally, run `npm run docs:sample:generate`, look at
  `docs/sample/index.html`, and commit the regenerated sample.
- When extraction behaviour changes, extend `fixtures/feature-app` so the case is covered.

**Never:**
- Add AI interpretation, similarity scores or "should merge" suggestions. The diagram
  shows evidence; people draw the conclusions.
- Copy code from TSDiagram (GPL-3.0) or AtomicViz (no license).
- Load anything from the network in `index.html`.
