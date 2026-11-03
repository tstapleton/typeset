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

	it("lists pairs sharing two or more property names, flagging differing types", () => {
		expect(computeEvidence(graph([a, b, c])).overlaps).toEqual([
			{ a: a.id, b: b.id, shared: ["city", "zip"], typeDiffers: ["zip"] },
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

	it("counts each model's users, highest first, leaving out unused models", () => {
		const g = graph([a, b, c], {
			relations: [
				relation(a, c, "order"),
				relation(a, c, "lastOrder"),
				relation(c, c, "parent"),
			],
			usages: [
				usage(c, "dir:x", ["x/1.ts", "x/2.ts"], 3),
				usage(c, "dir:y", ["y/1.ts"], 1),
				usage(a, "dir:x", ["x/1.ts"], 1),
			],
		});
		expect(computeEvidence(g).mostUsed).toEqual([
			{
				model: c.id,
				files: 3,
				directories: 2,
				references: 7,
				models: 1,
			},
			{ model: a.id, files: 1, directories: 1, references: 1, models: 0 },
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
