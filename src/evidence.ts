// Facts derived from the model graph that help a reader notice similarities
// and inconsistencies. Everything here is a plain, deterministic function of
// the graph: no scoring thresholds beyond "appears more than once", and no
// suggestions about what to do with the result.

import { compareStrings, type ModelGraph } from "./graph.js";

export interface SameName {
	name: string;
	models: string[];
}

export interface PropertyOccurrence {
	model: string;
	type: string;
	optional: boolean;
}

export interface SharedProperty {
	name: string;
	occurrences: PropertyOccurrence[];
	/** Number of distinct type texts across the occurrences. */
	distinctTypes: number;
}

export interface Overlap {
	a: string;
	b: string;
	/** Property names both models declare. */
	shared: string[];
	/** The subset of `shared` declared with different type text. */
	typeDiffers: string[];
}

export interface ModelUsage {
	model: string;
	/** Implementation files that use the model. */
	files: number;
	/** Directories holding those files. */
	directories: number;
	/** References across those files. */
	references: number;
	/** Other models that reference the model. */
	models: number;
}

export interface DirectoryImports {
	/** A top-level directory of the feature, or the feature root. */
	directory: string;
	/** Distinct models used from other top-level directories. */
	total: number;
	/** Those models by the top-level directory declaring them, largest group first. */
	from: Array<{ directory: string; models: string[] }>;
}

export interface Evidence {
	/** Model names declared more than once in the feature. */
	sameName: SameName[];
	/** Pairs of models declaring two or more of the same property names. */
	overlaps: Overlap[];
	/** Property names declared by more than one model. */
	sharedProperties: SharedProperty[];
	/** Models nothing else in the feature references (no relations in, no usages). */
	unreferenced: string[];
	/** Models used by code or other models, by files plus models, highest first. */
	mostUsed: ModelUsage[];
	/** Top-level directories using models declared in other ones, highest total first. */
	directoryImports: DirectoryImports[];
}

type Properties = Map<string, Map<string, PropertyOccurrence>>;

/** Each model's declared properties by name (first declaration wins). */
function propertiesByModel(graph: ModelGraph): Properties {
	const out: Properties = new Map();
	for (const model of graph.models) {
		const props = new Map<string, PropertyOccurrence>();
		for (const m of model.members) {
			if (m.kind !== "property" || props.has(m.name)) continue;
			props.set(m.name, {
				model: model.id,
				type: m.type,
				optional: m.optional,
			});
		}
		out.set(model.id, props);
	}
	return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items)
		out.set(key(item), [...(out.get(key(item)) ?? []), item]);
	return out;
}

function sameNames(graph: ModelGraph): SameName[] {
	return [...groupBy(graph.models, (m) => m.name).entries()]
		.filter(([, models]) => models.length > 1)
		.map(([name, models]) => ({ name, models: models.map((m) => m.id) }))
		.sort((x, y) => compareStrings(x.name, y.name));
}

function sharedProperties(props: Properties): SharedProperty[] {
	const all = [...props.values()].flatMap((p) => [...p.entries()]);
	return [...groupBy(all, ([name]) => name).entries()]
		.filter(([, occ]) => occ.length > 1)
		.map(([name, entries]) => {
			const occurrences = entries.map(([, o]) => o);
			return {
				name,
				occurrences,
				distinctTypes: new Set(occurrences.map((o) => o.type)).size,
			};
		})
		.sort(
			(x, y) =>
				y.occurrences.length - x.occurrences.length ||
				compareStrings(x.name, y.name),
		);
}

function overlap(a: string, b: string, props: Properties): Overlap | undefined {
	const pa = props.get(a) ?? new Map<string, PropertyOccurrence>();
	const pb = props.get(b) ?? new Map<string, PropertyOccurrence>();
	const shared = [...pa.keys()].filter((k) => pb.has(k)).sort(compareStrings);
	if (shared.length < 2) return undefined;
	const typeDiffers = shared.filter((k) => pa.get(k)?.type !== pb.get(k)?.type);
	return { a, b, shared, typeDiffers };
}

function overlaps(ids: string[], props: Properties): Overlap[] {
	const out = ids.flatMap((a, i) =>
		ids.slice(i + 1).flatMap((b) => overlap(a, b, props) ?? []),
	);
	return out.sort(
		(x, y) =>
			y.shared.length - x.shared.length ||
			compareStrings(x.a, y.a) ||
			compareStrings(x.b, y.b),
	);
}

function unreferenced(graph: ModelGraph): string[] {
	const referenced = new Set<string>([
		...graph.relations.filter((r) => r.from !== r.to).map((r) => r.to),
		...graph.usages.map((u) => u.model),
	]);
	return graph.models.map((m) => m.id).filter((id) => !referenced.has(id));
}

function mostUsed(graph: ModelGraph): ModelUsage[] {
	return graph.models
		.map((m) => {
			const usages = graph.usages.filter((u) => u.model === m.id);
			const sites = usages.flatMap((u) => u.sites);
			const referrers = graph.relations
				.filter((r) => r.to === m.id && r.from !== m.id)
				.map((r) => r.from);
			return {
				model: m.id,
				files: sites.length,
				directories: usages.length,
				references: sites.reduce((sum, s) => sum + s.count, 0),
				models: new Set(referrers).size,
			};
		})
		.filter((u) => u.files + u.models > 0)
		.sort(
			(x, y) =>
				y.files + y.models - (x.files + x.models) ||
				y.references - x.references ||
				compareStrings(x.model, y.model),
		);
}

/** `dir:a/b/c` → `dir:a`; the feature root (`dir:`) stays as it is. */
const topLevelDir = (id: string): string => id.split("/")[0];

/**
 * Rolled up to top-level directories, so use within one isn't counted. Code in
 * a directory and model declarations in it both count as using a model.
 */
function directoryImports(graph: ModelGraph): DirectoryImports[] {
	const homes = new Map(
		graph.models.map((m) => [m.id, topLevelDir(m.directory)]),
	);
	const pairs = [
		...graph.usages.map((u) => ({
			user: topLevelDir(u.directory),
			model: u.model,
		})),
		...graph.relations.map((r) => ({
			user: homes.get(r.from) ?? "",
			model: r.to,
		})),
	].filter(({ user, model }) => homes.get(model) !== user);
	return [...groupBy(pairs, (p) => p.user).entries()]
		.map(([directory, used]) => {
			const models = [...new Set(used.map((p) => p.model))];
			const from = [...groupBy(models, (m) => homes.get(m) ?? "").entries()]
				.map(([home, ids]) => ({
					directory: home,
					models: ids.sort(compareStrings),
				}))
				.sort(
					(x, y) =>
						y.models.length - x.models.length ||
						compareStrings(x.directory, y.directory),
				);
			return { directory, total: models.length, from };
		})
		.sort(
			(x, y) => y.total - x.total || compareStrings(x.directory, y.directory),
		);
}

export function computeEvidence(graph: ModelGraph): Evidence {
	const props = propertiesByModel(graph);
	return {
		sameName: sameNames(graph),
		overlaps: overlaps(
			graph.models.map((m) => m.id),
			props,
		),
		sharedProperties: sharedProperties(props),
		unreferenced: unreferenced(graph),
		mostUsed: mostUsed(graph),
		directoryImports: directoryImports(graph),
	};
}
