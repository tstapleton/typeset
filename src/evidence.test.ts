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
});
