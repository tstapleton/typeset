import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { crossDirectoryUse, type ModelGraph } from "../graph.js";
import { type ModelCard, modelCard } from "./cards.js";
import {
	lineWidth,
	type WeightedLine,
	weightedLineSvg,
} from "./directories.js";
import {
	type Box,
	type Cards,
	DIR_PADDING,
	ElkClass,
	LAYERED_OPTIONS,
	type PlacedDirectory,
	Placer,
	portId,
	ROOT_ID,
	ROOT_PADDING,
} from "./layout.js";
import { dirBoxSvg, esc, modelCardSvg } from "./svg.js";

export interface SharedLine extends WeightedLine {
	id: string;
	from: string;
	to: string;
}

export interface SharedLayout {
	width: number;
	height: number;
	directories: PlacedDirectory[];
	models: Array<ModelCard & Box>;
	lines: SharedLine[];
}

const EMPTY_BOX_MIN_W = 150;
const EMPTY_BOX_H = 56;
const CHAR_W = 7.8; // directory labels are 13px monospace at their widest
const LABEL_H = 18;
const EMPTY_W = 640;
const EMPTY_H = 80;

/**
 * Above this many lines, placement switches to Brandes-Koepf. Network Simplex
 * gives a more compact layout but its time climbs steeply: on synthetic graphs,
 * 10s at 132 lines and 138s at 410, against 2s for Brandes-Koepf at 410.
 */
const MAX_LINES_FOR_NETWORK_SIMPLEX = 100;

const SHARED_OPTIONS = {
	...LAYERED_OPTIONS,
	"elk.edgeLabels.inline": "true",
	"elk.layered.spacing.edgeEdgeBetweenLayers": "20",
	"elk.spacing.edgeEdge": "20",
	"elk.spacing.portPort": "18",
};

const labelOf = (graph: ModelGraph, id: string): string =>
	`${graph.directories.find((d) => d.id === id)?.path ?? id}/`;

/** The drawn directories: those holding a card or receiving a line, with their ancestors. */
function drawnDirectories(graph: ModelGraph, seeds: string[]): Set<string> {
	const parents = new Map(graph.directories.map((d) => [d.id, d.parent]));
	const drawn = new Set<string>();
	for (const seed of seeds) {
		let id: string | null | undefined = seed;
		while (id !== null && id !== undefined && !drawn.has(id)) {
			drawn.add(id);
			id = parents.get(id);
		}
	}
	return drawn;
}

/**
 * Lays out the models defined in a top-level directory and used from another
 * one, each line ending on the directory that uses the model. Use inside a
 * model's own top-level directory and anything at the feature root are left
 * out, and lines are ordered by ELK since nothing ties them to a row here.
 */
export async function computeSharedLayout(
	graph: ModelGraph,
): Promise<SharedLayout> {
	const uses = crossDirectoryUse(graph);
	const empty = {
		width: EMPTY_W,
		height: EMPTY_H,
		directories: [],
		models: [],
		lines: [],
	};
	const rootDir = graph.directories.find((d) => d.parent === null);
	if (uses.length === 0 || !rootDir) return empty;
	const lineId = (model: string, directory: string): string =>
		`${model}->${directory}`;
	const targets = (model: string): string[] =>
		uses.filter((u) => u.model === model).map((u) => u.directory);
	const models = graph.models.filter((m) => targets(m.id).length > 0);
	const cards: Cards = {
		models: new Map(
			models.map((m) => [
				m.id,
				modelCard(
					m,
					targets(m.id).map((d) => labelOf(graph, d)),
				),
			]),
		),
		files: new Map(),
	};
	const drawn = drawnDirectories(graph, [
		...models.map((m) => m.directory),
		...uses.map((u) => u.directory),
	]);
	const cardNode = (id: string, card: ModelCard): ElkNode => ({
		id,
		width: card.width,
		height: card.height,
		layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
		ports: targets(id).map((d) => ({
			id: portId(id, lineId(id, d)),
			width: 0,
			height: 0,
			layoutOptions: { "elk.port.side": "EAST" },
		})),
	});
	const placement =
		uses.length > MAX_LINES_FOR_NETWORK_SIMPLEX
			? { "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF" }
			: {};
	const dirNode = (id: string): ElkNode => {
		const children = [
			...models.flatMap((m) => {
				const card = cards.models.get(m.id);
				return m.directory === id && card ? [cardNode(m.id, card)] : [];
			}),
			...graph.directories
				.filter((d) => d.parent === id && drawn.has(d.id))
				.map((d) => dirNode(d.id)),
		];
		const options = {
			...SHARED_OPTIONS,
			...placement,
			"elk.padding": DIR_PADDING,
		};
		if (children.length > 0) return { id, layoutOptions: options, children };
		// A directory that only uses shared models has nothing to size it.
		return {
			id,
			layoutOptions: options,
			width: Math.max(EMPTY_BOX_MIN_W, labelOf(graph, id).length * CHAR_W + 28),
			height: EMPTY_BOX_H,
		};
	};
	const root: ElkNode = {
		id: ROOT_ID,
		layoutOptions: {
			...SHARED_OPTIONS,
			...placement,
			"elk.algorithm": "layered",
			"elk.hierarchyHandling": "INCLUDE_CHILDREN",
			// Otherwise lines entering a box share one port and merge into a trunk.
			"elk.layered.mergeHierarchyEdges": "false",
			"elk.padding": ROOT_PADDING,
		},
		children: [dirNode(rootDir.id)],
		edges: uses.map((u) => {
			const id = lineId(u.model, u.directory);
			return {
				id,
				sources: [portId(u.model, id)],
				targets: [u.directory],
				labels: [
					{
						text: String(u.users),
						width: String(u.users).length * 7.2 + 14,
						height: LABEL_H,
					},
				],
			};
		}),
	};
	const result = await new ElkClass().layout(root);
	const placer = new Placer(graph, cards, result);
	for (const child of result.children ?? [])
		placer.placeNodes(child, { x: 0, y: 0 }, 0);
	const placed = new Map<string, ElkExtendedEdge & { container?: string }>();
	const collect = (node: ElkNode): void => {
		for (const e of node.edges ?? []) placed.set(e.id, e);
		for (const c of node.children ?? []) collect(c);
	};
	collect(result);
	return {
		width: placer.layout.width,
		height: placer.layout.height,
		directories: placer.layout.directories,
		models: placer.layout.models,
		lines: uses.map((u) => {
			const id = lineId(u.model, u.directory);
			const edge = placed.get(id);
			// Coordinates are relative to the edge's container, not the root.
			const o = placer.absolute.get(edge?.container ?? ROOT_ID) ?? {
				x: 0,
				y: 0,
			};
			const label = edge?.labels?.[0];
			return {
				id,
				from: u.model,
				to: u.directory,
				count: u.users,
				width: lineWidth(u.users),
				points: (edge?.sections ?? [])
					.flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
					.map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
				labelBox: {
					x: (label?.x ?? 0) + o.x,
					y: (label?.y ?? 0) + o.y,
					width: label?.width ?? 0,
					height: label?.height ?? 0,
				},
			};
		}),
	};
}

/** The page's shared view. It takes its colours from the main diagram's stylesheet. */
export function renderSharedSvg(
	layout: SharedLayout,
	exportedById: ReadonlyMap<string, boolean>,
): string {
	const open = `<svg xmlns="http://www.w3.org/2000/svg" class="md" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`;
	if (layout.lines.length === 0)
		return `${open}<text class="dir-box-count" x="20" y="44">No model defined in a top-level directory is used from another one.</text></svg>`;
	const names = new Map(layout.models.map((m) => [m.id, m.title]));
	const labels = new Map(layout.directories.map((d) => [d.id, d.label]));
	const lines = layout.lines.map((l) =>
		weightedLineSvg(
			l,
			`data-from="${esc(l.from)}" data-to="${esc(l.to)}"`,
			`${names.get(l.from)} is used by ${l.count} in ${labels.get(l.to)}`,
		),
	);
	return (
		open +
		`<g class="dirs">${layout.directories.map(dirBoxSvg).join("")}</g>` +
		`<g class="dir-lines">${lines.join("")}</g>` +
		`<g class="cards">${layout.models.map((m) => modelCardSvg(m, exportedById.get(m.id) ?? true)).join("")}</g></svg>`
	);
}
