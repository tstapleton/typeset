# feature-app fixture

A small Angular-shaped app whose `src/app/features/orders` feature exercises the
extractor: nested directories, models at the feature root, a barrel, a namespace
import, generics, utility types, an enum, a type defined in a component, references
to models outside the feature (`core/api`), and the excluded `*.spec.ts`,
`*.stories.ts`, `integration/` and `fixtures/` paths.

`@angular/core` is deliberately not installed: unresolved packages must not break
extraction.
