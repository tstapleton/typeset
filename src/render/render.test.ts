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
import { computeSharedLayout, renderSharedSvg } from "./shared.js";
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
			["dir:customers", 4, 1, 1],
			["dir:data-access", 3, 1, 4],
			["dir:order-detail", 3, 0, 5],
		]);
		const texts = [
			...doc.querySelectorAll('[data-dir="dir:customers"] .dir-box-count'),
		].map((t) => t.textContent);
		expect(texts).toEqual([
			"4 models defined",
			"1 model shared",
			"1 external model used",
		]);
		expect(doc.querySelectorAll(".dir-box").length).toBe(layout.boxes.length);
	});

	it("draws one line per direction, labelled with its distinct models", () => {
		expect(layout.lines.map((l) => [l.from, l.to, l.count]).sort()).toEqual(
			[
				["dir:", "dir:customers", 1],
				["dir:customers", "dir:data-access", 1],
				["dir:data-access", "dir:", 3],
				["dir:data-access", "dir:customers", 1],
				["dir:order-detail", "dir:", 3],
				["dir:order-detail", "dir:customers", 1],
				["dir:order-detail", "dir:data-access", 1],
			].sort(),
		);
		for (const l of layout.lines)
			expect(l.points.length, l.id).toBeGreaterThanOrEqual(2);
		const counts = [...doc.querySelectorAll(".dir-line-count")].map(
			(t) => t.textContent,
		);
		expect(counts.sort()).toEqual(["1", "1", "1", "1", "1", "3", "3"]);
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

describe("shared view", async () => {
	const layout = await computeSharedLayout(graph);
	const doc = new new Window().DOMParser().parseFromString(
		renderSharedSvg(layout, exported),
		"image/svg+xml",
	);
	const uses = computeEvidence(graph).crossDirectoryUse;

	it("draws only models defined in one top-level directory and used from another", () => {
		const expected = [...new Set(uses.map((u) => u.model))].sort();
		expect(expected.length).toBeGreaterThan(1);
		expect(layout.models.map((m) => m.id).sort()).toEqual(expected);
		for (const m of graph.models.filter((x) => x.directory === "dir:"))
			expect(expected).not.toContain(m.id);
		expect(doc.querySelectorAll(".card.model").length).toBe(expected.length);
	});

	it("runs each line from its model's card to the box of the directory using it", () => {
		expect(layout.lines.length).toBe(uses.length);
		for (const l of layout.lines) {
			const card = layout.models.find((m) => m.id === l.from);
			const box = layout.directories.find((d) => d.id === l.to);
			if (!card || !box) throw new Error(`missing end of ${l.id}`);
			const start = l.points[0];
			const end = l.points[l.points.length - 1];
			expect(start.x, l.id).toBeCloseTo(card.x + card.width, 0);
			expect(start.y, l.id).toBeGreaterThanOrEqual(card.y);
			expect(start.y, l.id).toBeLessThanOrEqual(card.y + card.height);
			const onSide =
				Math.abs(end.x - box.x) < 1 ||
				Math.abs(end.x - (box.x + box.width)) < 1;
			expect(onSide, l.id).toBe(true);
			expect(end.y, l.id).toBeGreaterThanOrEqual(box.y);
			expect(end.y, l.id).toBeLessThanOrEqual(box.y + box.height);
		}
	});

	it("keeps a line's count beside the line, in the same coordinates", () => {
		for (const l of layout.lines) {
			const { x, y, width, height } = l.labelBox;
			const near = segments(l).some(([a, b]) => {
				const dx = Math.max(
					Math.min(a.x, b.x) - (x + width),
					x - Math.max(a.x, b.x),
					0,
				);
				const dy = Math.max(
					Math.min(a.y, b.y) - (y + height),
					y - Math.max(a.y, b.y),
					0,
				);
				return Math.hypot(dx, dy) < 12;
			});
			expect(near, l.id).toBe(true);
		}
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

	it("says so when nothing is shared", async () => {
		const none = { ...graph, usages: [], relations: [] };
		const svg = renderSharedSvg(await computeSharedLayout(none), exported);
		expect(svg).toContain("No model defined in a top-level directory");
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
		expect(read("index.html")).toMatch(/id="shared-canvas" hidden><svg /);
	});
});
