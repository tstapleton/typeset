# typeset

A CLI that reads a TypeScript feature directory (written for Angular 20 codebases) and
draws its **models**: every `interface`, `type` alias and `enum` declared there. Each one
is a card showing its definition, grouped in boxes that mirror the directory tree. Lines
show which models reference which, and which directories' code uses them.

It is for people reviewing how a feature's types are owned, named and connected. The
analysis is plain TypeScript name resolution (via [ts-morph](https://ts-morph.com)). There
is no AI and no scoring, and nothing tells you to merge or rename anything. The diagram
shows the evidence (definitions, references, usage sites, repeated names and properties)
so you can spot similarities and inconsistencies yourself.

![Sample: the fixture feature](docs/sample/diagram.svg)

## Run it

```bash
npm install
npm run build
node dist/cli.js --repo-root /path/to/angular-app src/app/features/recipes
open dist/typeset/index.html
```

| Flag / arg | Default | |
|---|---|---|
| `<feature-dir>` | (required) | Directory to analyze, relative to `--repo-root` |
| `--repo-root <path>` | nearest ancestor with `.git`, else cwd | Paths in the output are relative to this |
| `--out-dir <dir>` | `dist/typeset` | |
| `--tsconfig <path>` | nearest `tsconfig.json` from the feature dir up to the repo root | Used for module resolution (`paths` aliases) |

Outputs:

| File | |
|---|---|
| `index.html` | Self-contained interactive diagram: no server, no network, works from disk or as an Actions artifact |
| `graph.json` | The extracted model graph ([schema](src/graph.ts)): deterministic, with stable ids |
| `diagram.svg` | The same diagram as a static image |

`node_modules` is optional. Without it, a reference to a package type is shown with its
module specifier (`@angular/core`) instead of a resolved declaration.

## What's analyzed

- **Definitions**: interfaces, type aliases and enums at the top level of each file (or
  inside a `namespace`), in every `.ts` file under the feature directory. Classes are not
  models (a property typed with a class shows the class as an outside name).
- **Skipped**: `*.spec.ts`, `*.test.ts`, `*.stories.ts`, `*.d.ts`, and directories named
  `__fixtures__`, `__mocks__`, `diagnostics`, `fixtures`, `integration` or `node_modules`
  anywhere below the feature directory.
- **Model → model**: a property, method signature, `extends` clause or alias body that
  names another model in the tree. Edges leave from the row that holds the reference, and
  the detail panel shows how the reference is reached (`via array`, `via generic:Pick`, …).
  References across directories are drawn like any other.
- **Code → model**: every reference to a model from implementation code (anything other
  than type declarations and import/export statements), resolved through imports, barrels,
  namespace imports and `paths` aliases. They are grouped per directory into a
  "code using models" card with one row per file, and one edge per (directory, model).
- **Scope**: definitions and usages both stop at the feature directory. A type declared
  outside it is shown in purple by name and listed in the detail panel with its module;
  code outside the feature is never counted as usage.

## Reading the diagram

The **Models** view shows every model. The **Directories** view collapses each directory
directly below the feature into one box, so you see only the connections between them:

- A line means the code or models in one directory use models declared in another, with
  one line per direction. Its number and thickness show how many distinct models.
- Each box counts the models **defined** there (subdirectories included), those **shared**
  with other top-level directories, and the **external models used** from them.
- Click a line to list those models, or a box to see everything it uses and what uses it.

The **Shared** view keeps only the models defined in a directory directly below the feature
and used from another one:

- Each line runs from a model to a directory that uses it. Its number and thickness show how
  many files and models there use it. Click it to list them.
- Subdirectories count as part of their top-level directory. Use within a model's own
  directory and anything at the feature root are left out.

In the Models view:

- Directory boxes nest the way the folders do. Models at the feature root sit directly in
  the outer box.
- A dashed card outline means the model isn't exported.
- A tinted header with a count (`3 dirs`) means that many other top-level directories of
  the feature use the model, through code or a model declared there. Subdirectories count
  as part of their top-level directory, and the feature root counts as its own.
- Blue lines are references from a property or type alias, purple lines are `extends`, and
  thin orange lines are code in a directory using a model. A line's start marks the row
  holding the reference; where it arrives on a card doesn't refer to a particular row.
- Blue names in a type are models in the tree (click to jump); purple names are declared
  outside the model set.
- Hover or click a card to highlight its connections; the side panel shows its source,
  what it references, what references it, and every file that uses it.
- The **Evidence** panel lists facts for comparison: the most shared models, how many models
  each top-level directory uses from each other one, models with the same name, pairs of
  models declaring two or more of the same property names (`≠` marks a name declared with
  different types), property names that appear in several models, and models nothing in
  the feature references.
- Pan by dragging or scrolling; zoom with ⌘/ctrl + scroll or the buttons. The URL hash
  records the selection, so a link can point at a model.

## GitHub Actions

```yaml
- uses: actions/checkout@v7
- uses: tstapleton/typeset@main
  with:
    feature-dir: src/app/features/my-feature
```

The action builds the tool, generates the diagram, uploads `index.html` as a single-file
artifact (`archive: false`, so it opens directly in the browser), and links it from the
job summary. See [`docs/action-usage.yml`](docs/action-usage.yml).

## Development

Same toolchain as diff-diagram: TypeScript, Vitest, Biome, fallow and husky.

```bash
npm run verify    # build, biome, fallow audit, tests, sample drift check (pre-commit hook)
npm run docs:sample:generate   # after an intentional rendering change
```

Background and decisions: [`docs/design.md`](docs/design.md).
