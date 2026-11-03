import { describe, expect, it } from "vitest";
import { computeEvidence } from "./evidence.js";
import type { Member, Model, ModelGraph } from "./graph.js";

const prop = (name: string, type: string, optional = false): Member => ({
	name,
	kind: "property",
	optional,
	readonly: false,
	type,
	refs: [],
	external: [],
});

const model = (file: string, name: string, members: Member[]): Model => ({
	id: `model:${file}#${name}`,
	name,
	kind: "interface",
	exported: true,
	directory: "dir:",
	file,
	line: 1,
	typeParameters: [],
	extends: [],
	members,
	source: "",
});

const graph = (
	models: Model[],
	extra: Partial<ModelGraph> = {},
): ModelGraph => ({
	schemaVersion: 1,
	featureDir: "f",
	directories: [{ id: "dir:", path: "", name: "f", parent: null }],
	files: [],
	models,
	relations: [],
	usages: [],
	...extra,
});

describe("computeEvidence", () => {
	const a = model("a.ts", "Address", [
		prop("city", "string"),
		prop("zip", "string"),
		prop("line1", "string"),
	]);
	const b = model("b/b.ts", "Address", [
		prop("city", "string"),
		prop("zip", "number"),
	]);
	const c = model("c.ts", "Order", [prop("id", "string")]);

	it("lists names declared more than once", () => {
		expect(computeEvidence(graph([a, b, c])).sameName).toEqual([
			{ name: "Address", models: [a.id, b.id] },
		]);
	});

	it("lists property names declared by several models with their distinct type count", () => {
		const shared = computeEvidence(graph([a, b, c])).sharedProperties;
		expect(
			shared.map((s) => [s.name, s.occurrences.length, s.distinctTypes]),
		).toEqual([
			["city", 2, 1],
			["zip", 2, 2],
		]);
	});

	it("lists property names with different types, grouping models by type", () => {
		const d = model("d.ts", "Other", [prop("zip", "number")]);
		expect(
			computeEvidence(graph([a, b, c, d])).propertyTypeDifferences,
		).toEqual([
			{
				name: "zip",
				types: [
					{ type: "number", models: [b.id, d.id] },
					{ type: "string", models: [a.id] },
				],
			},
		]);
	});

	it("lists models with no incoming relation or usage (self references don't count)", () => {
		const g = graph([a, b, c], {
			relations: [
				{
					id: "r1",
					from: a.id,
					to: b.id,
					kind: "property",
					member: "x",
					via: [],
				},
				{
					id: "r2",
					from: c.id,
					to: c.id,
					kind: "property",
					member: "y",
					via: [],
				},
			],
			usages: [{ id: "u", model: a.id, directory: "dir:", sites: [] }],
		});
		expect(computeEvidence(g).unreferenced).toEqual([c.id]);
	});

	const relation = (from: Model, to: Model, member: string) => ({
		id: `${from.id}->${to.id}@${member}`,
		from: from.id,
		to: to.id,
		kind: "property" as const,
		member,
		via: [],
	});
	const usage = (m: Model, directory: string, files: string[], count = 1) => ({
		id: `${m.id}->${directory}`,
		model: m.id,
		directory,
		sites: files.map((file) => ({ file, count, via: "import" as const })),
	});
	const inDir = (m: Model, directory: string): Model => ({ ...m, directory });

	it("lists models used outside their top-level directory, most directories first", () => {
		const wide = inDir(model("h/w.ts", "Wide", []), "dir:h");
		const narrow = inDir(model("h/n.ts", "Narrow", []), "dir:h");
		const inside = inDir(model("h/i.ts", "Inside", []), "dir:h");
		const nested = inDir(model("h/sub/s.ts", "Nested", []), "dir:h/sub");
		const outsider = inDir(model("y/z/o.ts", "Outsider", []), "dir:y/z");
		const g = graph([wide, narrow, inside, nested, outsider], {
			relations: [
				relation(wide, wide, "self"),
				relation(nested, wide, "fromSubdirectory"),
				relation(nested, inside, "fromSubdirectory"),
				relation(outsider, wide, "one"),
				relation(outsider, wide, "two"),
			],
			usages: [
				usage(wide, "dir:x", ["x/1.ts", "x/2.ts"], 3),
				usage(wide, "dir:y/z", ["y/z/1.ts"]),
				usage(wide, "dir:h", ["h/own.ts"], 50),
				usage(wide, "dir:h/sub", ["h/sub/own.ts"], 50),
				usage(narrow, "dir:x", ["x/1.ts"]),
				usage(inside, "dir:h/sub", ["h/sub/own.ts"]),
			],
		});
		expect(computeEvidence(g).mostShared).toEqual([
			{
				model: wide.id,
				directories: ["dir:x", "dir:y"],
				files: 3,
				references: 7,
				models: 1,
			},
			{
				model: narrow.id,
				directories: ["dir:x"],
				files: 1,
				references: 1,
				models: 0,
			},
		]);
	});

	it("lists use across top-level directories, ignoring the root and a model's own directory", () => {
		const shared = inDir(model("a/x/s.ts", "Shared", []), "dir:a/x");
		const rootModel = inDir(model("r.ts", "Root", []), "dir:");
		const user = inDir(model("b/c/u.ts", "User", []), "dir:b/c");
		const local = inDir(model("a/l.ts", "Local", []), "dir:a");
		const g = graph([shared, rootModel, user, local], {
			relations: [
				relation(user, shared, "one"),
				relation(user, shared, "two"),
				relation(local, shared, "sameDirectory"),
				relation(rootModel, shared, "fromRoot"),
				relation(user, rootModel, "toRoot"),
			],
			usages: [
				usage(shared, "dir:b", ["b/1.ts"], 2),
				usage(shared, "dir:", ["root.ts"]),
				usage(shared, "dir:a", ["a/own.ts"]),
				usage(rootModel, "dir:b", ["b/1.ts"]),
			],
		});
		expect(computeEvidence(g).crossDirectoryUse).toEqual([
			{
				model: shared.id,
				directory: "dir:b",
				files: [{ file: "b/1.ts", count: 2 }],
				references: [
					{ model: user.id, member: "one" },
					{ model: user.id, member: "two" },
				],
				users: 2,
			},
		]);
	});

	it("separates models used only elsewhere from those used more outside than at home", () => {
		const only = inDir(model("h/o.ts", "Only", []), "dir:h");
		const more = inDir(model("h/m.ts", "More", []), "dir:h");
		const even = inDir(model("h/e.ts", "Even", []), "dir:h/sub");
		const unused = inDir(model("h/u.ts", "Unused", []), "dir:h");
		const local = inDir(model("h/sub/l.ts", "Local", []), "dir:h/sub");
		const g = graph([only, more, even, unused, local], {
			relations: [
				relation(only, only, "self"),
				relation(local, more, "fromSubdirectory"),
				relation(local, even, "fromSameRollup"),
			],
			usages: [
				usage(only, "dir:x/deep", ["x/deep/1.ts", "x/deep/2.ts"], 2),
				usage(only, "dir:y", ["y/1.ts"], 1),
				usage(more, "dir:x", ["x/1.ts"], 3),
				usage(even, "dir:x", ["x/1.ts"], 1),
			],
		});
		const evidence = computeEvidence(g);
		expect(evidence.usedOnlyElsewhere).toEqual([
			{
				model: only.id,
				home: 0,
				outside: 5,
				by: [
					{ directory: "dir:x", uses: 4 },
					{ directory: "dir:y", uses: 1 },
				],
			},
		]);
		expect(evidence.usedMoreOutside).toEqual([
			{
				model: more.id,
				home: 1,
				outside: 3,
				by: [{ directory: "dir:x", uses: 3 }],
			},
		]);
	});

	it("lists pairs of top-level directories using each other, only when both do", () => {
		const inA = inDir(model("a/a.ts", "InA", []), "dir:a");
		const inB = inDir(model("b/x/b.ts", "InB", []), "dir:b/x");
		const inC = inDir(model("c/c.ts", "InC", []), "dir:c");
		const g = graph([inA, inB, inC], {
			relations: [relation(inA, inB, "toB")],
			usages: [
				usage(inA, "dir:b", ["b/1.ts"]),
				usage(inC, "dir:a", ["a/1.ts"]),
			],
		});
		expect(computeEvidence(g).twoWayDirectories).toEqual([
			{ a: "dir:a", b: "dir:b", aUses: [inB.id], bUses: [inA.id] },
		]);
	});

	it("lists models held under different property names, skipping methods", () => {
		const target = model("t.ts", "MyType", []);
		const same = model("s.ts", "Same", []);
		const holderA = model("a2.ts", "HolderA", [
			prop("bar", "MyType"),
			prop("same", "Same"),
		]);
		const holderB = model("b2.ts", "HolderB", [
			prop("baz", "MyType"),
			prop("same", "Same"),
			{ ...prop("run", "(x: MyType) => void"), kind: "method" },
		]);
		const g = graph([target, same, holderA, holderB], {
			relations: [
				relation(holderA, target, "bar"),
				relation(holderB, target, "baz"),
				relation(holderB, target, "run"),
				relation(holderA, same, "same"),
				relation(holderB, same, "same"),
			],
		});
		expect(computeEvidence(g).propertyNameDifferences).toEqual([
			{
				model: target.id,
				names: [
					{ name: "bar", models: [holderA.id] },
					{ name: "baz", models: [holderB.id] },
				],
			},
		]);
	});

	it("groups each top-level directory's outside models by where they're declared", () => {
		const compiler1 = inDir(model("compiler/1.ts", "C1", []), "dir:compiler");
		const compiler2 = inDir(model("compiler/2.ts", "C2", []), "dir:compiler");
		const workspace = inDir(model("workspace/w.ts", "W", []), "dir:workspace");
		const adapter = inDir(model("adapters/a.ts", "A", []), "dir:adapters");
		const nested = inDir(model("adapters/x/n.ts", "N", []), "dir:adapters/x");
		const g = graph([compiler1, compiler2, workspace, adapter, nested], {
			relations: [
				relation(adapter, compiler1, "x"),
				relation(adapter, adapter, "self"),
				relation(adapter, nested, "withinTopLevel"),
			],
			usages: [
				usage(compiler1, "dir:adapters", ["adapters/b.ts"]),
				usage(compiler2, "dir:adapters/x/y", ["adapters/x/y/c.ts"]),
				usage(workspace, "dir:adapters", ["adapters/b.ts"]),
				usage(adapter, "dir:adapters", ["adapters/b.ts"]),
				usage(workspace, "dir:workspace", ["workspace/x.ts"]),
			],
		});
		expect(computeEvidence(g).directoryImports).toEqual([
			{
				directory: "dir:adapters",
				total: 3,
				from: [
					{ directory: "dir:compiler", models: [compiler1.id, compiler2.id] },
					{ directory: "dir:workspace", models: [workspace.id] },
				],
			},
		]);
	});
});
