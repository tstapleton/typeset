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

export interface Evidence {
	/** Model names declared more than once in the feature. */
	sameName: SameName[];
	/** Pairs of models declaring two or more of the same property names. */
	overlaps: Overlap[];
	/** Property names declared by more than one model. */
	sharedProperties: SharedProperty[];
	/** Models nothing else in the feature references (no relations in, no usages). */
	unreferenced: string[];
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
	};
}
