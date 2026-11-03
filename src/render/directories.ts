import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import {
	compareStrings,
	directoryImports,
	type ModelGraph,
	outsideUse,
	topLevelDir,
} from "../graph.js";
import { type Box, ElkClass, type Point } from "./layout.js";
import { esc, pathD } from "./svg.js";

export interface DirectoryBox extends Box {
	id: string;
	label: string;
	/** Models declared in the directory, subdirectories included. */
	defined: number;
	/** Of those, the ones used from another top-level directory. */
	shared: number;
	/** Distinct models this directory uses from other top-level directories. */
	used: number;
}

export interface DirectoryLine {
	id: string;
	from: string;
	to: string;
	/** Distinct models `from` uses that are declared in `to`. */
	models: number;
	width: number;
	points: Point[];
	/** Where the model count is drawn; ELK reserves the room for it. */
	labelBox: Box;
}

export interface DirectoryLayout {
	width: number;
	height: number;
	boxes: DirectoryBox[];
	lines: DirectoryLine[];
}

const BOX_MIN_W = 170;
const BOX_MIN_H = 92;
const LINE_ROOM = 22; // height a box needs per line on its busier side
const CHAR_W = 7.2;
const LABEL_H = 18;
const MAX_LINE_W = 12;

/**
 * Stroke width for a count of models. The scale is fixed, not relative to the
 * diagram's busiest line, so one model looks the same in every diagram. It grows
 * with the square root so a line of 25 doesn't dwarf everything else.
 */
export function lineWidth(models: number): number {
	return Math.min(MAX_LINE_W, Math.round(15 * Math.sqrt(models)) / 10);
}

const ROOT_OPTIONS = {
	"elk.algorithm": "layered",
	"elk.direction": "RIGHT",
	"elk.edgeRouting": "ORTHOGONAL",
	"elk.edgeLabels.inline": "true",
	"elk.layered.spacing.nodeNodeBetweenLayers": "90",
	"elk.layered.spacing.edgeNodeBetweenLayers": "26",
	"elk.layered.spacing.edgeEdgeBetweenLayers": "20",
	"elk.spacing.edgeEdge": "20",
	"elk.spacing.edgeNode": "26",
	"elk.spacing.nodeNode": "36",
	"elk.spacing.portPort": "20",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.padding": "[top=24, left=24, bottom=24, right=24]",
};

/** Top-level directories with something to show, in sorted order. */
function topLevelIds(graph: ModelGraph): string[] {
	const ids = new Set([
		...graph.models.map((m) => topLevelDir(m.directory)),
		...graph.usages.map((u) => topLevelDir(u.directory)),
	]);
	return [...ids].sort(compareStrings);
}

type BoxCounts = Pick<DirectoryBox, "defined" | "shared" | "used">;

function boxCounts(graph: ModelGraph, id: string): BoxCounts {
	const inBox = graph.models.filter((m) => topLevelDir(m.directory) === id);
	const outside = outsideUse(graph);
	return {
		defined: inBox.length,
		shared: inBox.filter((m) => outside.has(m.id)).length,
		used: directoryImports(graph).find((d) => d.directory === id)?.total ?? 0,
	};
}

function boxLabel(graph: ModelGraph, id: string): string {
	const dir = graph.directories.find((d) => d.id === id);
	if (!dir) return id;
	return dir.path === "" ? `${dir.name}/ (root)` : `${dir.path}/`;
}

/**
 * Lays out one box per top-level directory and one line per direction between
 * two of them. The counts come from `directoryImports`, the same function
 * behind the evidence panel, so the two can't disagree.
 */
export async function computeDirectoryLayout(
	graph: ModelGraph,
): Promise<DirectoryLayout> {
	const pairs = directoryImports(graph).flatMap((d) =>
		d.from.map((f) => ({
			id: `${d.directory}->${f.directory}`,
			from: d.directory,
			to: f.directory,
			models: f.models.length,
		})),
	);
	pairs.sort((a, b) => compareStrings(a.id, b.id));
	const ids = topLevelIds(graph);
	const labels = new Map(ids.map((id) => [id, boxLabel(graph, id)]));
	const linesOn = (id: string): number =>
		Math.max(
			pairs.filter((p) => p.from === id).length,
			pairs.filter((p) => p.to === id).length,
		);
	const root: ElkNode = {
		id: "root",
		layoutOptions: ROOT_OPTIONS,
		children: ids.map((id) => ({
			id,
			width: Math.max(BOX_MIN_W, (labels.get(id) ?? id).length * CHAR_W + 28),
			height: Math.max(BOX_MIN_H, linesOn(id) * LINE_ROOM + 16),
		})),
		edges: pairs.map((p) => ({
			id: p.id,
			sources: [p.from],
			targets: [p.to],
			labels: [
				{
					text: String(p.models),
					width: String(p.models).length * CHAR_W + 14,
					height: LABEL_H,
				},
			],
		})),
	};
	const result = await new ElkClass().layout(root);
	const placed = new Map(
		(result.edges ?? []).map((e): [string, ElkExtendedEdge] => [e.id, e]),
	);
	return {
		width: Math.ceil(result.width ?? 0),
		height: Math.ceil(result.height ?? 0),
		boxes: (result.children ?? []).map((c) => ({
			id: c.id,
			label: labels.get(c.id) ?? c.id,
			...boxCounts(graph, c.id),
			x: c.x ?? 0,
			y: c.y ?? 0,
			width: c.width ?? 0,
			height: c.height ?? 0,
		})),
		lines: pairs.map((p) => {
			const edge = placed.get(p.id);
			const label = edge?.labels?.[0];
			return {
				...p,
				width: lineWidth(p.models),
				points: (edge?.sections ?? []).flatMap((s) => [
					s.startPoint,
					...(s.bendPoints ?? []),
					s.endPoint,
				]),
				labelBox: {
					x: label?.x ?? 0,
					y: label?.y ?? 0,
					width: label?.width ?? 0,
					height: label?.height ?? 0,
				},
			};
		}),
	};
}

/**
 * Splits a line's end into the path up to the arrowhead and the arrowhead. A
 * scaled SVG marker would be huge on a thick line, and a thick line's square
 * end would poke out past a marker's tip.
 */
function arrowEnd(line: DirectoryLine): { points: Point[]; head: string } {
	const tip = line.points[line.points.length - 1];
	const before = line.points[line.points.length - 2];
	const length = Math.hypot(tip.x - before.x, tip.y - before.y) || 1;
	const dx = (tip.x - before.x) / length;
	const dy = (tip.y - before.y) / length;
	const headLength = Math.min(length, 7 + line.width);
	const halfWidth = line.width / 2 + 4;
	const base = { x: tip.x - dx * headLength, y: tip.y - dy * headLength };
	const corner = (side: number): string =>
		`${base.x - dy * halfWidth * side} ${base.y + dx * halfWidth * side}`;
	return {
		points: [...line.points.slice(0, -1), base],
		head: `M${tip.x} ${tip.y}L${corner(1)}L${corner(-1)}z`,
	};
}

function lineSvg(line: DirectoryLine, labels: Map<string, string>): string {
	if (line.points.length < 2) return "";
	const { points, head } = arrowEnd(line);
	const d = pathD(points);
	const { x, y, width, height } = line.labelBox;
	const noun = line.models === 1 ? "model" : "models";
	const tip = `${labels.get(line.from)} uses ${line.models} ${noun} from ${labels.get(line.to)}`;
	return (
		`<g class="dir-line" data-from="${esc(line.from)}" data-to="${esc(line.to)}"><title>${esc(tip)}</title>` +
		`<path class="dir-line-hit" d="${d}" stroke-width="${Math.max(14, line.width + 6)}"/>` +
		`<path class="dir-line-stroke" d="${d}" stroke-width="${line.width}"/>` +
		`<path class="dir-line-head" d="${head}"/>` +
		`<rect class="dir-line-pill" x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}"/>` +
		`<text class="dir-line-count" x="${x + width / 2}" y="${y + height / 2 + 4}" text-anchor="middle">${line.models}</text></g>`
	);
}

function boxSvg(box: DirectoryBox): string {
	const count = (y: number, text: string): string =>
		`<text class="dir-box-count" x="14" y="${y}">${text}</text>`;
	const models = (n: number): string => (n === 1 ? "1 model" : `${n} models`);
	const external =
		box.used === 1 ? "1 external model" : `${box.used} external models`;
	return (
		`<g class="dir-box" data-dir="${esc(box.id)}" transform="translate(${box.x},${box.y})">` +
		`<rect width="${box.width}" height="${box.height}" rx="8"/>` +
		`<text class="dir-box-name" x="14" y="24">${esc(box.label)}</text>` +
		count(44, `${models(box.defined)} defined`) +
		count(60, `${models(box.shared)} shared`) +
		count(76, `${external} used`) +
		`</g>`
	);
}

const STYLE = `
.dir-box{cursor:pointer}.dir-box rect{fill:var(--card);stroke:var(--outline)}
.dir-box-name{font-size:13px;font-weight:700;fill:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dir-box-count{font-size:11px;fill:var(--dim)}
.dir-line{cursor:pointer}
.dir-line-hit{fill:none;stroke:transparent}
.dir-line-stroke{fill:none;stroke:var(--e-property)}
.dir-line-head{fill:var(--e-property)}
.dir-line-pill{fill:var(--bg);stroke:var(--e-property)}
.dir-line-count{font-size:11px;font-weight:600;fill:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
`;

/** The page's directory view. It takes its colours from the main diagram's stylesheet. */
export function renderDirectorySvg(layout: DirectoryLayout): string {
	const labels = new Map(layout.boxes.map((b) => [b.id, b.label]));
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" class="md" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">` +
		`<style>${STYLE}</style>` +
		`<g class="dir-lines">${layout.lines.map((l) => lineSvg(l, labels)).join("")}</g>` +
		`<g class="dir-boxes">${layout.boxes.map(boxSvg).join("")}</g></svg>`
	);
}
