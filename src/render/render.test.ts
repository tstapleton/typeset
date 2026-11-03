import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../cli.js";
import { computeEvidence } from "../evidence.js";
import { extract } from "../extract/extract.js";
import { buildHtml } from "./html.js";
import { computeLayout } from "./layout.js";
import { renderSvg } from "./svg.js";

const FIXTURE = new URL("../../fixtures/feature-app", import.meta.url).pathname;
const FEATURE = "src/app/features/orders";
const graph = extract(FEATURE, { repoRoot: FIXTURE });
const exported = new Map(graph.models.map((m) => [m.id, m.exported]));

describe("layout and SVG", async () => {
	const layout = await computeLayout(graph);
	const svg = renderSvg(layout, exported);
	const doc = new new Window().DOMParser().parseFromString(
		svg,
		"image/svg+xml",
	);

	it("draws one card per model, nested in its directory box", () => {
		for (const m of graph.models) {
			const card = layout.models.find((c) => c.id === m.id);
			const dir = layout.directories.find((d) => d.id === m.directory);
			expect(card, m.id).toBeDefined();
			expect(dir, m.directory).toBeDefined();
			if (!card || !dir) continue;
			expect(card.x).toBeGreaterThanOrEqual(dir.x);
			expect(card.y).toBeGreaterThanOrEqual(dir.y);
			expect(card.x + card.width).toBeLessThanOrEqual(dir.x + dir.width);
			expect(card.y + card.height).toBeLessThanOrEqual(dir.y + dir.height);
		}
		expect(doc.querySelectorAll(".card.model").length).toBe(
			graph.models.length,
		);
	});

	it("draws every relation and usage as a routed edge", () => {
		const ids = [
			...graph.relations.map((r) => r.id),
			...graph.usages.map((u) => u.id),
		].sort();
		expect(layout.edges.map((e) => e.id)).toEqual(ids);
		for (const e of layout.edges)
			expect(e.points.length, e.id).toBeGreaterThanOrEqual(2);
		expect(doc.querySelectorAll("path.edge").length).toBe(ids.length);
	});

	it("starts a property edge at the row that holds the reference", () => {
		const rel = graph.relations.find((r) => r.id.endsWith("#OrderLine@lines"));
		const edge = layout.edges.find((e) => e.id === rel?.id);
		const card = layout.models.find((c) => c.id === rel?.from);
		if (!edge || !card) throw new Error("missing");
		const row = card.rows.findIndex((r) => r.member === "lines");
		expect(edge.points[0].y).toBeCloseTo(card.y + 40 + row * 20 + 10, 0);
		expect(edge.points[0].x).toBeCloseTo(card.x + card.width, 0);
	});

	it("marks model names in type text as links to their card", () => {
		const targets = [...doc.querySelectorAll(".t-model")].map((t) =>
			t.getAttribute("data-target"),
		);
		expect(targets).toContain("model:orders.models.ts#OrderLine");
	});
});

describe("index.html", async () => {
	const layout = await computeLayout(graph);
	const evidence = computeEvidence(graph);

	it("inlines the SVG and data with no placeholders left", async () => {
		const html = await buildHtml(graph, evidence, renderSvg(layout, exported));
		expect(html).not.toMatch(/__TYPESET_\w+__/);
		const json = html.match(/const DATA = (.*);\n/)?.[1];
		expect(JSON.parse(json ?? "null").graph).toEqual(graph);
		expect(html).not.toMatch(/<script src=|<link [^>]*href="http/);
	});

	it("cannot be broken out of by source text containing </script>", async () => {
		const evil = structuredClone(graph);
		evil.models[0].source = "/** </script><script>alert(1)</script> $& */";
		const html = await buildHtml(evil, evidence, renderSvg(layout, exported));
		expect(html.split("</script>").length).toBe(2);
		expect(html).toContain("$&");
	});
});

describe("generate", () => {
	const out = mkdtempSync(path.join(tmpdir(), "typeset-out-"));
	afterAll(() => rmSync(out, { recursive: true, force: true }));

	it("is byte-for-byte deterministic", async () => {
		await generate(FEATURE, { repoRoot: FIXTURE, outDir: path.join(out, "a") });
		await generate(FEATURE, { repoRoot: FIXTURE, outDir: path.join(out, "b") });
		for (const f of ["index.html", "graph.json", "diagram.svg"]) {
			expect(readFileSync(path.join(out, "a", f), "utf8")).toBe(
				readFileSync(path.join(out, "b", f), "utf8"),
			);
		}
	});
});
