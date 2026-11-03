import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../cli.js";
import { computeEvidence } from "../evidence.js";
import { extract } from "../extract/extract.js";
import {
	computeDirectoryLayout,
	lineWidth,
	renderDirectorySvg,
} from "./directories.js";
import { buildHtml } from "./html.js";
import { computeLayout, type Point } from "./layout.js";
import { renderSvg } from "./svg.js";

const FIXTURE = new URL("../../fixtures/feature-app", import.meta.url).pathname;
const FEATURE = "src/app/features/orders";
const graph = extract(FEATURE, { repoRoot: FIXTURE });
const exported = new Map(graph.models.map((m) => [m.id, m.exported]));

type Segment = [Point, Point];

const segments = (e: { points: Point[] }): Segment[] =>
	e.points.slice(1).map((p, i): Segment => [e.points[i], p]);

/** Length two orthogonal segments share when they lie on the same line. */
function collinearOverlap([a, b]: Segment, [c, d]: Segment): number {
	const along = (axis: "x" | "y"): number =>
		Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
		Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
	const flat = (axis: "x" | "y"): boolean =>
		a[axis] === b[axis] && c[axis] === d[axis] && a[axis] === c[axis];
	if (flat("y")) return along("x");
	if (flat("x")) return along("y");
	return 0;
}

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

	it("never runs two edges along the same line unless they share a source port", () => {
		const overlaps: string[] = [];
		for (const [i, a] of layout.edges.entries()) {
			for (const b of layout.edges.slice(i + 1)) {
				const sameSource =
					a.points[0].x === b.points[0].x && a.points[0].y === b.points[0].y;
				if (sameSource) continue;
				const shared = segments(a).flatMap((s) =>
					segments(b).map((t) => collinearOverlap(s, t)),
				);
				if (shared.some((length) => length > 0))
					overlaps.push(`${a.id} | ${b.id}`);
			}
		}
		expect(overlaps).toEqual([]);
	});

	it("gives every edge its own arrival point on the target card", () => {
		const ends = layout.edges.map((e) => {
			const end = e.points[e.points.length - 1];
			return `${end.x},${end.y}`;
		});
		expect(new Set(ends).size).toBe(ends.length);
		for (const e of layout.edges) {
			const card = layout.models.find((c) => c.id === e.to);
			if (!card) throw new Error(`missing ${e.to}`);
			const end = e.points[e.points.length - 1];
			expect(end.x, e.id).toBeCloseTo(card.x, 0);
			expect(end.y, e.id).toBeGreaterThan(card.y);
			expect(end.y, e.id).toBeLessThan(card.y + card.height);
		}
	});

	it("draws alias references like property references, with no kind badges", () => {
		const alias = graph.relations.find((r) => r.kind === "alias");
		const path = [...doc.querySelectorAll("path.edge")].find(
			(p) => p.getAttribute("data-id") === alias?.id,
		);
		expect(path?.getAttribute("class")).toBe("edge e-property");
		expect(doc.querySelector(".badge")).toBeNull();
	});

	it("marks only models used outside their top-level directory, with a count", () => {
		const card = (id: string) =>
			doc.querySelector(`.card.model[data-id="${id}"]`);
		const order = card("model:orders.models.ts#Order");
		expect(order?.getAttribute("class")).toContain("shared");
		expect(order?.querySelector(".shared-pill text")?.textContent).toBe(
			"2 dirs",
		);
		expect(order?.querySelector(".shared-pill title")?.textContent).toContain(
			"data-access/",
		);
		const local = card("model:customers/customer.model.ts#Address");
		expect(local?.getAttribute("class")).not.toContain("shared");
		expect(local?.querySelector(".shared-pill")).toBeNull();
	});

	it("marks model names in type text as links to their card", () => {
		const targets = [...doc.querySelectorAll(".t-model")].map((t) =>
			t.getAttribute("data-target"),
		);
		expect(targets).toContain("model:orders.models.ts#OrderLine");
	});
});

describe("directory view", async () => {
	const layout = await computeDirectoryLayout(graph);
	const doc = new new Window().DOMParser().parseFromString(
		renderDirectorySvg(layout),
		"image/svg+xml",
	);
	const line = (from: string, to: string) =>
		layout.lines.find((l) => l.from === from && l.to === to);

	it("draws one box per top-level directory with its counts", () => {
		expect(
			layout.boxes.map((b) => [b.id, b.defined, b.shared, b.used]),
		).toEqual([
			["dir:", 5, 5, 1],
			["dir:customers", 3, 1, 0],
			["dir:data-access", 3, 0, 4],
			["dir:order-detail", 3, 0, 3],
		]);
		const texts = [
			...doc.querySelectorAll('[data-dir="dir:customers"] .dir-box-count'),
		].map((t) => t.textContent);
		expect(texts).toEqual([
			"3 models defined",
			"1 model shared",
			"0 external models used",
		]);
		expect(doc.querySelectorAll(".dir-box").length).toBe(layout.boxes.length);
	});

	it("draws one line per direction, labelled with its distinct models", () => {
		expect(layout.lines.map((l) => [l.from, l.to, l.models]).sort()).toEqual(
			[
				["dir:", "dir:customers", 1],
				["dir:data-access", "dir:", 3],
				["dir:data-access", "dir:customers", 1],
				["dir:order-detail", "dir:", 3],
			].sort(),
		);
		for (const l of layout.lines)
			expect(l.points.length, l.id).toBeGreaterThanOrEqual(2);
		const counts = [...doc.querySelectorAll(".dir-line-count")].map(
			(t) => t.textContent,
		);
		expect(counts.sort()).toEqual(["1", "1", "3", "3"]);
	});

	it("widens lines with the model count on a fixed, capped scale", () => {
		expect(lineWidth(1)).toBe(1.5);
		expect(lineWidth(25)).toBe(7.5);
		expect(lineWidth(25)).toBeGreaterThan(lineWidth(1));
		expect(lineWidth(1000)).toBe(12);
		expect(line("dir:data-access", "dir:")?.width).toBe(lineWidth(3));
	});

	it("never overlaps two lines", () => {
		const overlaps = layout.lines.flatMap((a, i) =>
			layout.lines.slice(i + 1).flatMap((b) => {
				const shared = segments(a).flatMap((s) =>
					segments(b).map((t) => collinearOverlap(s, t)),
				);
				return shared.some((length) => length > 0) ? [`${a.id} | ${b.id}`] : [];
			}),
		);
		expect(overlaps).toEqual([]);
	});
});

describe("index.html", async () => {
	const layout = await computeLayout(graph);
	const evidence = computeEvidence(graph);

	it("inlines the SVG and data with no placeholders left", async () => {
		const html = await buildHtml(
			graph,
			evidence,
			renderSvg(layout, exported),
			"",
		);
		expect(html).not.toMatch(/__TYPESET_\w+__/);
		const json = html.match(/const DATA = (.*);\n/)?.[1];
		expect(JSON.parse(json ?? "null").graph).toEqual(graph);
		expect(html).not.toMatch(/<script src=|<link [^>]*href="http/);
	});

	it("cannot be broken out of by source text containing </script>", async () => {
		const evil = structuredClone(graph);
		evil.models[0].source = "/** </script><script>alert(1)</script> $& */";
		const html = await buildHtml(
			evil,
			evidence,
			renderSvg(layout, exported),
			"",
		);
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

	it("embeds the directory view in index.html but not in diagram.svg", () => {
		const read = (f: string) => readFileSync(path.join(out, "a", f), "utf8");
		expect(read("index.html")).toMatch(/id="dir-canvas" hidden><svg /);
		expect(read("index.html")).toContain('class="dir-box"');
		expect(read("diagram.svg")).not.toContain('class="dir-box"');
	});
});
