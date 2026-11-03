# Design notes

## Goal of this first version

A **snapshot** of one feature directory's models, checked against a real feature
(birdseed's `src/app` and `src/app/features/recipes`) before anything else is built.
Base-versus-PR diffing is the next step, so the graph format is designed for it from
the start (stable ids, deterministic output) but no diffing exists yet.

## Pipeline

```
extract (ts-morph)  →  graph.json  →  evidence  →  layout (elkjs)  →  SVG  →  index.html
   src/extract/        src/graph.ts    src/evidence.ts  src/render/layout.ts  svg.ts   html.ts + template.html
```

- **Extraction** (`src/extract/`) is the only code that touches TypeScript. It produces
  a `ModelGraph` and nothing else.
- **Rendering** (`src/render/`) only reads the `ModelGraph` type. It never imports from
  `src/extract/` (`compareStrings` lives in `graph.ts` for that reason).
- **Evidence** (`src/evidence.ts`) is a pure function of the graph: repeated names,
  shared property names, overlapping models, unreferenced models. It is computed at
  render time and isn't stored in `graph.json`, so the graph stays a record of the code
  alone.

## Graph format (`src/graph.ts`)

| Entity | Id | Notes |
|---|---|---|
| Directory | `dir:<path>` (`dir:` = feature root) | Every directory holding an analyzed file, plus its ancestors |
| Model | `model:<file>#<name>` | `<name>` is qualified with namespaces (`Api.Dto`) |
| Relation | `rel:<from>-><to>@<member>` (`@extends`, `@alias`) | One per (source, member, target) |
| Usage | `use:<model>-><directory>` | With per-file sites: count, and `import` vs `local` |

Determinism rules, enforced by tests (`render.test.ts` runs the pipeline twice and
compares bytes):

- Paths are POSIX and relative to the feature directory, and `featureDir` is relative to
  the repo root, so two checkouts at different absolute paths produce identical output
  (verified on birdseed).
- No timestamps or machine data.
- Every list is sorted by id with a code-unit comparison (`localeCompare` would depend on
  the machine's locale). Members keep source order, which is itself deterministic and
  meaningful.
- The ELK layout is deterministic for identical input.

For a future diff: models, relations and usages match by id across base and head. A
moved file becomes a remove plus an add, which is the honest reading of an ownership
change. Content changes are visible by comparing `members` / `aliasOf` / `source`.

## Reference projects

| Project | License | Used for | Reused code? |
|---|---|---|---|
| [TSDiagram](https://github.com/3rd/tsdiagram) | GPL-3.0 | Visual reference: cards with a header and `name: type` rows, model names highlighted in types, edges leaving from the field row, ELK layered layout | No. GPL code can't be copied into this package; the cards are an independent implementation |
| [TsUML2](https://github.com/demike/TsUML2) | MIT | How it derives member-type associations (recursing through unions, arrays and type arguments to find referenced declarations) | No. Our walker is syntactic, unlike TsUML2's resolved-type approach, so `Unit[]` stays `Unit` instead of expanding to a literal union, and each reference records the path (`via`) that reaches it |
| [AtomicViz](https://github.com/briandiloreto/AtomicViz) | No license file (proprietary) | Grouping by folder, usage edges, click-to-focus, an outline panel beside the diagram | No; ideas only |
| [ts-morph](https://github.com/dsherret/ts-morph) | MIT | Dependency: declaration lookup, symbol and alias resolution | Dependency |
| [diff-diagram](https://github.com/tstapleton/diff-diagram) | n/a | Toolchain, CLI shape, ELK layout, self-contained HTML with inlined data, the composite action and `archive: false` artifact publishing | Patterns, not shared code |

## Rendering choice

The layout is precomputed in Node with **elkjs** (EPL-2.0, already used by diff-diagram
and TSDiagram). The renderer writes one SVG string that is used both as `diagram.svg`
and inline in `index.html`. The page adds only vanilla JS for pan/zoom, focus, search
and the side panel.

TSDiagram renders with React Flow. That suits an editor, but it would need a bundling
step and much more JavaScript in every artifact, and nothing here moves after layout.
Precomputing also makes the output byte-stable, which future diffs need.

Layout specifics:

- Directories are ELK compound nodes (`hierarchyHandling: INCLUDE_CHILDREN`), so edges
  route across directory boxes.
- Each card has fixed-position ports: one per row that references a model (east side)
  and one "in" port on the header (west side).
- Usage edges run from the directory's code card to the model, the same direction as
  model references (dependent → dependency). An earlier version pointed them the other
  way, and on birdseed's `src/app` that produced cycles and edges that wrapped around
  the whole diagram.
- Text width is estimated from a monospace advance width of 7.2px at 12px. Rows over 64
  characters are truncated with `…`; the full text is in the tooltip and detail panel.

## Known limitations / next steps

- **No base-vs-PR diff yet.** Next: run `extract` on both checkouts and diff the graphs
  by id. Layout could then keep base positions for unchanged cards.
- Classes are not models. Angular components and stores don't carry property types worth
  showing, but domain classes would; this could become an option.
- Types declared inside functions are not collected.
- `*.test.ts` is not excluded (only `*.spec.ts`, as specified for Angular).
- Usages are counted by identifier references, not import statements, so an imported
  but unused model doesn't count. Namespace imports (`models.Order`) and barrels resolve
  to the real declaration.
- Large features (`birdseed/src/app`: 36 models, 67 usages) are readable when zoomed in
  but busy at "Fit". Collapsing directories would need a re-layout per state; turning
  off usage edges is the current lever.
- No PR comment yet; the action writes a job summary with the artifact link.

## Test app: birdseed

Birdseed keeps its shared models in `core/api/models.ts`. Its features declare only
state and form types (`RecipesState`, `RecipeForm`, …) that reference core models, so a
single feature such as `features/recipes` gives a small diagram: 9 models, 3 internal
references, and the core types shown as outside names. Running on `src/app` gives the
interesting cross-directory picture: core models, feature state referencing them, and
usage from every feature. The evidence panel surfaces genuine overlaps there: `Recipe`
vs `RecipeForm` declare `servings`, `tags`, `cookMinutes` and `prepMinutes` with
different types, and `Ingredient` vs `IngredientRow` differ in `quantity` and `unit`.

The bundled fixture (`fixtures/feature-app`) covers what birdseed doesn't: nested
subdirectories, models at the feature root, barrels, namespace imports, generics, enums,
duplicate names and the excluded paths.
