// The model graph: the only thing extraction produces and the only thing
// rendering consumes. It is written to graph.json as-is.
//
// Determinism rules (so two runs over the same tree produce identical bytes,
// and so a future base-vs-PR diff can match entities by id):
// - No timestamps, absolute paths, or machine-specific data.
// - Every path is POSIX and relative to the feature directory ("" is the root).
// - Every id is derived from paths and names only, never from discovery order.
// - Every array is sorted by id (or by a documented key).

export const SCHEMA_VERSION = 1;

/** `interface`, `type` alias or `enum` declared in the feature tree. */
export type ModelKind = "interface" | "type" | "enum";

/**
 * How a reference reaches its target, outermost first, e.g. a property typed
 * `Array<GroceryItem> | null` reaches GroceryItem via ["union", "array"].
 * Generic arguments record the generic's name: `Pick<Recipe, "id">` reaches
 * Recipe via ["generic:Pick"].
 */
export type ViaStep =
	| "array"
	| "union"
	| "intersection"
	| "tuple"
	| "function"
	| "indexed"
	| "keyof"
	| "mapped"
	| "conditional"
	| `generic:${string}`;

/** A type reference that resolved to a model inside the feature tree. */
export interface ModelRef {
	target: string;
	/** The name as written at the reference site (may differ from the target's name when renamed on import). */
	text: string;
	via: ViaStep[];
}

/**
 * A type reference that did not resolve to a model in the feature tree: a
 * declaration outside the tree, or a class or function inside it. Built-in
 * library types (Array, Promise, Record, …) are not recorded.
 */
export interface ExternalRef {
	name: string;
	/**
	 * Repo-relative path for project files, the package name for node_modules,
	 * or the module specifier as written when the import does not resolve.
	 */
	module: string;
	/** True when the declaration is inside the feature tree (a class or function, not a model). */
	inFeature: boolean;
	via: ViaStep[];
}

export type MemberKind =
	| "property"
	| "method"
	| "index"
	| "call"
	| "construct"
	| "enum-member";

export interface Member {
	/** Property name, `[key: string]` for index signatures, `()` for call signatures. */
	name: string;
	kind: MemberKind;
	optional: boolean;
	readonly: boolean;
	/** The member's type exactly as written, whitespace-collapsed. Enum members carry their initializer, if any. */
	type: string;
	refs: ModelRef[];
	external: ExternalRef[];
	/** First JSDoc paragraph, whitespace-collapsed. */
	doc?: string;
}

export interface Heritage {
	/** The clause as written, e.g. `Pick<Recipe, "id">`. */
	text: string;
	refs: ModelRef[];
	external: ExternalRef[];
}

export interface Model {
	/** `model:<file>#<name>`, e.g. `model:data-access/orders.store.ts#OrderState`. */
	id: string;
	name: string;
	kind: ModelKind;
	exported: boolean;
	/** Directory id this model is declared in. */
	directory: string;
	/** File path relative to the feature directory. */
	file: string;
	line: number;
	typeParameters: string[];
	extends: Heritage[];
	/**
	 * Declared members, in source order. For a type alias whose body is a
	 * single object literal these are its members; otherwise the alias body is
	 * in `aliasOf` and `members` is empty.
	 */
	members: Member[];
	/** Type alias body as written, whitespace-collapsed, when it is not a single object literal. */
	aliasOf?: {
		type: string;
		refs: ModelRef[];
		external: ExternalRef[];
	};
	/** The declaration's source text, verbatim (including JSDoc). */
	source: string;
	doc?: string;
}

export type RelationKind = "property" | "extends" | "alias";

/** model → model, one per (source, member, target). */
export interface Relation {
	/** `rel:<from>-><to>@<member>`; `@extends` / `@alias` for non-member relations. */
	id: string;
	from: string;
	to: string;
	kind: RelationKind;
	/** Member name for `property` relations. */
	member?: string;
	via: ViaStep[];
}

/** A reference to a model from implementation code in one file. */
export interface UsageSite {
	/** File path relative to the feature directory. */
	file: string;
	/** Number of references in that file, outside type declarations. */
	count: number;
	/** `import` when the model is declared in another file, `local` when it is declared in the same file. */
	via: "import" | "local";
}

/** model → directory: implementation code in that directory uses the model. */
export interface Usage {
	/** `use:<model>-><directory>`. */
	id: string;
	model: string;
	directory: string;
	sites: UsageSite[];
}

export interface SourceFile {
	/** Path relative to the feature directory. */
	path: string;
	directory: string;
	/** Model ids declared here. */
	models: string[];
	/** True when the file has code other than imports, exports and model declarations. */
	implementation: boolean;
}

export interface Directory {
	/** `dir:<path>`; `dir:` is the feature root. */
	id: string;
	/** Path relative to the feature directory; "" for the root. */
	path: string;
	/** Basename, or the feature directory's basename for the root. */
	name: string;
	parent: string | null;
}

export interface ModelGraph {
	schemaVersion: typeof SCHEMA_VERSION;
	/** Repo-relative POSIX path of the feature directory. */
	featureDir: string;
	directories: Directory[];
	files: SourceFile[];
	models: Model[];
	relations: Relation[];
	usages: Usage[];
}

export function directoryId(dirPath: string): string {
	return `dir:${dirPath}`;
}

export function modelId(file: string, name: string): string {
	return `model:${file}#${name}`;
}

/** Code-unit string order: locale-independent, so output is byte-stable across machines. */
export function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** `dir:a/b/c` → `dir:a`; the feature root (`dir:`) stays as it is. */
export const topLevelDir = (id: string): string => id.split("/")[0];

/**
 * How a model is used from outside the top-level directory declaring it. A
 * directory's subdirectories count as inside it, and the feature root is a
 * directory of its own.
 */
export interface OutsideUse {
	/** Other top-level directories using the model, through code or a model declared there. */
	directories: string[];
	/** Implementation files in those directories that use the model. */
	files: number;
	/** References across those files. */
	references: number;
	/** Models in those directories that reference the model. */
	models: number;
}

/** Keyed by model id. Models used only inside their top-level directory have no entry. */
export function outsideUse(graph: ModelGraph): Map<string, OutsideUse> {
	const homes = new Map(
		graph.models.map((m) => [m.id, topLevelDir(m.directory)]),
	);
	const out = new Map<string, OutsideUse>();
	for (const m of graph.models) {
		const home = homes.get(m.id);
		const usages = graph.usages.filter(
			(u) => u.model === m.id && topLevelDir(u.directory) !== home,
		);
		const sites = usages.flatMap((u) => u.sites);
		const referrers = graph.relations
			.filter((r) => r.to === m.id && homes.get(r.from) !== home)
			.map((r) => r.from);
		const directories = new Set([
			...usages.map((u) => topLevelDir(u.directory)),
			...referrers.map((id) => homes.get(id) ?? ""),
		]);
		if (directories.size === 0) continue;
		out.set(m.id, {
			directories: [...directories].sort(compareStrings),
			files: sites.length,
			references: sites.reduce((sum, s) => sum + s.count, 0),
			models: new Set(referrers).size,
		});
	}
	return out;
}

export interface DirectoryImports {
	/** A top-level directory of the feature, or the feature root. */
	directory: string;
	/** Distinct models used from other top-level directories. */
	total: number;
	/** Those models by the top-level directory declaring them, largest group first. */
	from: Array<{ directory: string; models: string[] }>;
}

/**
 * Rolled up to top-level directories, so use within one isn't counted. Code in
 * a directory and model declarations in it both count as using a model.
 */
export function directoryImports(graph: ModelGraph): DirectoryImports[] {
	const homes = new Map(
		graph.models.map((m) => [m.id, topLevelDir(m.directory)]),
	);
	const used = new Map<string, Map<string, Set<string>>>();
	const add = (user: string, model: string): void => {
		const home = homes.get(model);
		if (home === undefined || home === user) return;
		const from = used.get(user) ?? new Map<string, Set<string>>();
		from.set(home, (from.get(home) ?? new Set<string>()).add(model));
		used.set(user, from);
	};
	for (const u of graph.usages) add(topLevelDir(u.directory), u.model);
	for (const r of graph.relations) add(homes.get(r.from) ?? "", r.to);
	return [...used.entries()]
		.map(([directory, from]) => {
			const groups = [...from.entries()]
				.map(([home, models]) => ({
					directory: home,
					models: [...models].sort(compareStrings),
				}))
				.sort(
					(x, y) =>
						y.models.length - x.models.length ||
						compareStrings(x.directory, y.directory),
				);
			const total = groups.reduce((sum, g) => sum + g.models.length, 0);
			return { directory, total, from: groups };
		})
		.sort(
			(x, y) => y.total - x.total || compareStrings(x.directory, y.directory),
		);
}
