import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelGraph } from "../graph.js";
import { extract } from "./extract.js";

const FIXTURE = new URL("../../fixtures/feature-app", import.meta.url).pathname;
const graph = extract("src/app/features/orders", { repoRoot: FIXTURE });

const model = (g: ModelGraph, name: string, file?: string) => {
	const m = g.models.find((x) => x.name === name && (!file || x.file === file));
	if (!m) throw new Error(`no model ${name}`);
	return m;
};
const member = (g: ModelGraph, modelName: string, memberName: string) => {
	const m = model(g, modelName).members.find((x) => x.name === memberName);
	if (!m) throw new Error(`no member ${modelName}.${memberName}`);
	return m;
};

describe("extract: fixture feature", () => {
	it("reports the feature directory relative to the repo root", () => {
		expect(graph.featureDir).toBe("src/app/features/orders");
		expect(graph.schemaVersion).toBe(1);
	});

	it("skips test files and test-support directories (but not an ancestor named fixtures)", () => {
		const names = graph.models.map((m) => m.name);
		for (const excluded of [
			"SpecOnly",
			"StoryArgs",
			"IntegrationOnly",
			"FixtureOnly",
			"TestOnly",
			"UnderscoreFixtureOnly",
			"MockOnly",
			"DiagnosticOnly",
		]) {
			expect(names).not.toContain(excluded);
		}
		expect(graph.files.map((f) => f.path)).not.toContain(
			"data-access/orders.store.spec.ts",
		);
		for (const excluded of [
			"integration",
			"fixtures",
			"__fixtures__",
			"__mocks__",
			"diagnostics",
		])
			expect(graph.directories.map((d) => d.path)).not.toContain(excluded);
	});

	it("keeps models at the feature root and the nested directory structure", () => {
		expect(model(graph, "Order").directory).toBe("dir:");
		expect(graph.directories).toEqual([
			{ id: "dir:", path: "", name: "orders", parent: null },
			{
				id: "dir:customers",
				path: "customers",
				name: "customers",
				parent: "dir:",
			},
			{
				id: "dir:data-access",
				path: "data-access",
				name: "data-access",
				parent: "dir:",
			},
			{
				id: "dir:order-detail",
				path: "order-detail",
				name: "order-detail",
				parent: "dir:",
			},
			{
				id: "dir:order-detail/summary",
				path: "order-detail/summary",
				name: "summary",
				parent: "dir:order-detail",
			},
		]);
	});

	it("uses path-and-name ids, sorted", () => {
		expect(model(graph, "OrdersState").id).toBe(
			"model:data-access/orders.store.ts#OrdersState",
		);
		const ids = graph.models.map((m) => m.id);
		expect(ids).toEqual([...ids].sort());
		const relIds = graph.relations.map((r) => r.id);
		expect(relIds).toEqual([...relIds].sort());
	});

	it("records members with their types as written", () => {
		expect(member(graph, "Order", "id")).toMatchObject({
			readonly: true,
			type: "string",
		});
		expect(member(graph, "Order", "discounts")).toMatchObject({
			optional: true,
			type: "Record<string, Money>",
			doc: "Keyed by SKU.",
		});
		expect(member(graph, "OrdersApi", "list")).toMatchObject({
			kind: "method",
			type: "(filter: OrderFilter, page: number): Promise<Page<Order>>",
		});
		expect(
			model(graph, "OrderStatus").members.map((m) => `${m.name}=${m.type}`),
		).toEqual(["Draft='draft'", "Placed='placed'", "Shipped='shipped'"]);
		expect(model(graph, "Page").typeParameters).toEqual(["T"]);
		expect(model(graph, "Order").doc).toBe("An order as the API returns it.");
	});

	it("treats a single object-literal alias as members and anything else as aliasOf", () => {
		expect(model(graph, "Money").members.map((m) => m.name)).toEqual([
			"amount",
			"currency",
		]);
		expect(model(graph, "CustomerRef").aliasOf?.type).toBe(
			"Pick<Customer, 'id' | 'name'>",
		);
	});

	it("links properties to models with the path that reaches them", () => {
		const rel = (from: string, to: string, memberName?: string) =>
			graph.relations.find(
				(r) =>
					r.from === model(graph, from).id &&
					r.to === model(graph, to).id &&
					(memberName === undefined || r.member === memberName),
			);
		expect(rel("Order", "OrderLine", "lines")?.via).toEqual(["array"]);
		expect(rel("Order", "Money", "discounts")?.via).toEqual(["generic:Record"]);
		expect(rel("OrderFilter", "OrderStatus", "status")?.via).toEqual(["union"]);
		expect(rel("CustomerRef", "Customer")).toMatchObject({
			kind: "alias",
			via: ["generic:Pick"],
		});
		// Through a namespace import: models.Page<models.Order>
		expect(rel("OrdersState", "Order", "page")?.via).toEqual([
			"generic:models.Page",
		]);
		// Across directories, and between the two models named Address only by the right one
		expect(rel("Customer", "Address", "billing")?.to).toBe(
			"model:customers/customer.model.ts#Address",
		);
	});

	it("records references that leave the model set as external", () => {
		expect(member(graph, "Customer", "account").external).toEqual([
			{
				name: "User",
				module: "src/app/core/api/user.ts",
				inFeature: false,
				via: [],
			},
		]);
		// Resolved through the tsconfig `paths` alias @core/*
		expect(member(graph, "Money", "currency").external[0]?.module).toBe(
			"src/app/core/api/user.ts",
		);
	});

	it("records usages from implementation code by directory, through barrels and namespaces", () => {
		const usage = (name: string, dir: string) =>
			graph.usages.find(
				(u) => u.model === model(graph, name).id && u.directory === dir,
			);
		// customer-card imports Customer through the ../index barrel
		expect(usage("Customer", "dir:customers")?.sites).toEqual([
			{ file: "customers/customer-card.component.ts", count: 1, via: "import" },
		]);
		// orders.store uses models.Order / models.OrderStatus via a namespace import
		expect(usage("Order", "dir:data-access")?.sites[0]?.file).toBe(
			"data-access/orders.store.ts",
		);
		expect(usage("OrderStatus", "dir:data-access")).toBeDefined();
		// A model used by code in its own file
		expect(usage("OrderFilter", "dir:data-access")?.sites).toEqual([
			{ file: "data-access/order-filter.ts", count: 1, via: "local" },
		]);
		// Type-only references between models are relations, not usages
		expect(usage("Money", "dir:")).toBeUndefined();
	});

	it("marks which files carry implementation code", () => {
		const f = (p: string) => graph.files.find((x) => x.path === p);
		expect(f("orders.models.ts")?.implementation).toBe(false);
		expect(f("index.ts")?.implementation).toBe(false);
		expect(f("data-access/order-filter.ts")?.implementation).toBe(true);
	});
});

describe("extract: edge cases", () => {
	const root = mkdtempSync(path.join(tmpdir(), "typeset-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const project = (files: Record<string, string>): ModelGraph => {
		const dir = mkdtempSync(path.join(root, "p-"));
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), text);
		}
		return extract("feature", { repoRoot: dir });
	};

	it("handles extends, merging, index and call signatures, namespaces and self references", () => {
		const g = project({
			"feature/a.ts": `
				export interface Base { id: string }
				export interface Node extends Base, Partial<Base> {
					children: Node[];
					[key: string]: unknown;
					(): void;
				}
				export interface Node { extra?: boolean }
				export namespace Api { export interface Dto { node: Node } }
				export type Keys = keyof Node;
				export type Fn = (n: Node) => Base;
			`,
		});
		const node = model(g, "Node");
		expect(node.extends.map((h) => h.text)).toEqual(["Base", "Partial<Base>"]);
		expect(node.members.map((m) => `${m.kind}:${m.name}`)).toEqual([
			"property:children",
			"index:[key: string]",
			"call:()",
			"property:extra",
		]);
		expect(g.relations.map((r) => r.id)).toEqual(
			expect.arrayContaining([
				"rel:model:a.ts#Node->model:a.ts#Base@extends",
				"rel:model:a.ts#Node->model:a.ts#Node@children",
				"rel:model:a.ts#Api.Dto->model:a.ts#Node@node",
			]),
		);
		expect(g.relations.find((r) => r.from === "model:a.ts#Keys")?.via).toEqual([
			"keyof",
		]);
		expect(
			g.relations.find(
				(r) => r.from === "model:a.ts#Fn" && r.to === "model:a.ts#Base",
			)?.via,
		).toEqual(["function"]);
	});

	it("records an import that does not resolve by its specifier", () => {
		const g = project({
			"feature/a.ts": `import type { Signal } from '@angular/core';\nexport interface A { s: Signal<number> }`,
		});
		expect(member(g, "A", "s").external).toEqual([
			{ name: "Signal", module: "@angular/core", inFeature: false, via: [] },
		]);
	});

	it("records a class inside the feature as external with inFeature", () => {
		const g = project({
			"feature/a.ts": `export class Svc {}\nexport interface A { svc: Svc }`,
		});
		expect(member(g, "A", "svc").external[0]).toMatchObject({
			name: "Svc",
			inFeature: true,
		});
	});

	it("does not count definitions or usages outside the feature tree", () => {
		const g = project({
			"feature/a.ts": "export interface A { x: number }",
			"other/b.ts":
				"import type { A } from '../feature/a';\nexport const b: A = { x: 1 };",
		});
		expect(g.models.map((m) => m.id)).toEqual(["model:a.ts#A"]);
		expect(g.usages).toEqual([]);
	});
});
