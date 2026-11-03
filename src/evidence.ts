// Facts derived from the model graph that help a reader notice similarities
// and inconsistencies. Everything here is a plain, deterministic function of
// the graph: no scoring thresholds beyond "appears more than once", and no
// suggestions about what to do with the result.

import {
	type CrossDirectoryUse,
	compareStrings,
	crossDirectoryUse,
	type DirectoryImports,
	directoryImports,
	type ModelGraph,
	type OutsideUse,
	outsideUse,
	topLevelDir,
} from "./graph.js";

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

export interface SharedModel extends OutsideUse {
	model: string;
}

/** Uses of a model by one top-level directory: code references plus model references. */
export interface DirectoryUses {
	directory: string;
	uses: number;
}

/** Where a model is used, relative to the top-level directory defining it. */
export interface ModelPlacement {
	model: string;
	/** Uses inside the model's own top-level directory. */
	home: number;
	/** Total uses from other top-level directories. */
	outside: number;
	/** Those uses by directory, highest first. */
	by: DirectoryUses[];
}

/** Two top-level directories that each use models defined in the other. */
export interface TwoWayDirectories {
	a: string;
	b: string;
	/** Models `a` uses from `b`. */
	aUses: string[];
	/** Models `b` uses from `a`. */
	bUses: string[];
}

export interface PropertyTypeDifference {
	name: string;
	/** Each distinct type text, with the models declaring the property that way. */
	types: Array<{ type: string; models: string[] }>;
}

export interface PropertyNameDifference {
	model: string;
	/** Each property name holding the model, with the models declaring it. */
	names: Array<{ name: string; models: string[] }>;
}

export interface Evidence {
	/** Model names declared more than once in the feature. */
	sameName: SameName[];
	/** Property names declared by more than one model. */
	sharedProperties: SharedProperty[];
	/** Models used from other top-level directories and not inside their own. */
	usedOnlyElsewhere: ModelPlacement[];
	/** Models used inside their own top-level directory, but more often from others. */
	usedMoreOutside: ModelPlacement[];
	/** Pairs of top-level directories each using models from the other. */
	twoWayDirectories: TwoWayDirectories[];
	/** Property names declared with different type text in different models. */
	propertyTypeDifferences: PropertyTypeDifference[];
	/** Models held in properties of more than one name. */
	propertyNameDifferences: PropertyNameDifference[];
	/** Models nothing else in the feature references (no relations in, no usages). */
	unreferenced: string[];
	/** Models used outside the top-level directory declaring them, most other directories first. */
	mostShared: SharedModel[];
	/** Top-level directories using models declared in other ones, highest total first. */
	directoryImports: DirectoryImports[];
	/** Models defined in one top-level directory and used from another, ignoring the root. */
	crossDirectoryUse: CrossDirectoryUse[];
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

function unreferenced(graph: ModelGraph): string[] {
	const referenced = new Set<string>([
		...graph.relations.filter((r) => r.from !== r.to).map((r) => r.to),
		...graph.usages.map((u) => u.model),
	]);
	return graph.models.map((m) => m.id).filter((id) => !referenced.has(id));
}

function mostShared(graph: ModelGraph): SharedModel[] {
	return [...outsideUse(graph).entries()]
		.map(([model, use]) => ({ model, ...use }))
		.sort(
			(x, y) =>
				y.directories.length - x.directories.length ||
				y.files + y.models - (x.files + x.models) ||
				y.references - x.references ||
				compareStrings(x.model, y.model),
		);
}

/** A model's uses per top-level directory. A model referencing itself isn't a use. */
function placements(graph: ModelGraph): ModelPlacement[] {
	const homes = new Map(
		graph.models.map((m) => [m.id, topLevelDir(m.directory)]),
	);
	const counts = new Map<string, Map<string, number>>();
	const add = (model: string, directory: string, uses: number): void => {
		const byDir = counts.get(model) ?? new Map<string, number>();
		byDir.set(directory, (byDir.get(directory) ?? 0) + uses);
		counts.set(model, byDir);
	};
	for (const u of graph.usages)
		add(
			u.model,
			topLevelDir(u.directory),
			u.sites.reduce((sum, s) => sum + s.count, 0),
		);
	for (const r of graph.relations)
		if (r.from !== r.to) add(r.to, homes.get(r.from) ?? "", 1);
	return graph.models.map((m) => {
		const home = homes.get(m.id);
		const all = [...(counts.get(m.id) ?? new Map<string, number>()).entries()];
		const by = all
			.filter(([directory]) => directory !== home)
			.map(([directory, uses]) => ({ directory, uses }))
			.sort(
				(x, y) => y.uses - x.uses || compareStrings(x.directory, y.directory),
			);
		return {
			model: m.id,
			home: all.find(([directory]) => directory === home)?.[1] ?? 0,
			outside: by.reduce((sum, d) => sum + d.uses, 0),
			by,
		};
	});
}

const byOutsideUses = (x: ModelPlacement, y: ModelPlacement): number =>
	y.outside - x.outside || compareStrings(x.model, y.model);

function twoWayDirectories(graph: ModelGraph): TwoWayDirectories[] {
	const imports = directoryImports(graph);
	const used = (user: string, home: string): string[] =>
		imports
			.find((d) => d.directory === user)
			?.from.find((f) => f.directory === home)?.models ?? [];
	const ids = imports.map((d) => d.directory).sort(compareStrings);
	return ids
		.flatMap((a, i) =>
			ids.slice(i + 1).map((b) => ({
				a,
				b,
				aUses: used(a, b),
				bUses: used(b, a),
			})),
		)
		.filter((p) => p.aUses.length > 0 && p.bUses.length > 0)
		.sort(
			(x, y) =>
				y.aUses.length + y.bUses.length - (x.aUses.length + x.bUses.length) ||
				compareStrings(x.a, y.a) ||
				compareStrings(x.b, y.b),
		);
}

function propertyTypeDifferences(
	shared: SharedProperty[],
): PropertyTypeDifference[] {
	return shared
		.filter((s) => s.distinctTypes > 1)
		.map((s) => ({
			name: s.name,
			types: [...groupBy(s.occurrences, (o) => o.type).entries()]
				.map(([type, occurrences]) => ({
					type,
					models: occurrences.map((o) => o.model),
				}))
				.sort((x, y) => compareStrings(x.type, y.type)),
		}))
		.sort(
			(x, y) =>
				y.types.length - x.types.length || compareStrings(x.name, y.name),
		);
}

/** Only properties count: a method taking or returning a model isn't holding it. */
function propertyNameDifferences(graph: ModelGraph): PropertyNameDifference[] {
	const properties = new Set(
		graph.models.flatMap((m) =>
			m.members
				.filter((x) => x.kind === "property")
				.map((x) => `${m.id}@${x.name}`),
		),
	);
	const held = graph.relations.filter((r) =>
		properties.has(`${r.from}@${r.member}`),
	);
	return [...groupBy(held, (r) => r.to).entries()]
		.map(([model, relations]) => ({
			model,
			names: [...groupBy(relations, (r) => r.member ?? "").entries()]
				.map(([name, group]) => ({
					name,
					models: [...new Set(group.map((r) => r.from))].sort(compareStrings),
				}))
				.sort((x, y) => compareStrings(x.name, y.name)),
		}))
		.filter((d) => d.names.length > 1)
		.sort(
			(x, y) =>
				y.names.length - x.names.length || compareStrings(x.model, y.model),
		);
}

export function computeEvidence(graph: ModelGraph): Evidence {
	const props = propertiesByModel(graph);
	const shared = sharedProperties(props);
	const placed = placements(graph);
	return {
		sameName: sameNames(graph),
		sharedProperties: shared,
		usedOnlyElsewhere: placed
			.filter((p) => p.outside > 0 && p.home === 0)
			.sort(byOutsideUses),
		usedMoreOutside: placed
			.filter((p) => p.home > 0 && p.outside > p.home)
			.sort(byOutsideUses),
		twoWayDirectories: twoWayDirectories(graph),
		propertyTypeDifferences: propertyTypeDifferences(shared),
		propertyNameDifferences: propertyNameDifferences(graph),
		unreferenced: unreferenced(graph),
		mostShared: mostShared(graph),
		directoryImports: directoryImports(graph),
		crossDirectoryUse: crossDirectoryUse(graph),
	};
}
