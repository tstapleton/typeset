import { createRequire } from "node:module";
import type {
	ElkExtendedEdge,
	ELK as ElkInstance,
	ElkNode,
	ElkPort,
} from "elkjs/lib/elk-api.js";
import { compareStrings, type ModelGraph } from "../graph.js";
import {
	FILES_HEADER_H,
	type FilesCard,
	filesCardId,
	filesCards,
	type ModelCard,
	modelCard,
	relationRow,
	rowCenterY,
} from "./cards.js";

const require = createRequire(import.meta.url);
const ElkClass = require("elkjs/lib/elk.bundled.js") as { new (): ElkInstance };

export interface Point {
	x: number;
	y: number;
}

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlacedDirectory extends Box {
	id: string;
	label: string;
	depth: number;
}

export interface PlacedEdge {
	id: string;
	kind: "property" | "extends" | "alias" | "usage";
	from: string;
	to: string;
	points: Point[];
}

export interface Layout {
	width: number;
	height: number;
	directories: PlacedDirectory[];
	models: Array<ModelCard & Box>;
	files: Array<FilesCard & Box>;
	edges: PlacedEdge[];
}

const DIR_LABEL_H = 26;
const MARGIN = 16;

const portId = (card: string, name: string): string => `${card}::${name}`;

function modelPorts(card: ModelCard, rowsWithRefs: Set<number>): ElkPort[] {
	const ports: ElkPort[] = [
		{
			id: portId(card.id, "in"),
			x: 0,
			y: rowCenterY(-1),
			width: 0,
			height: 0,
			layoutOptions: { "elk.port.side": "WEST" },
		},
		{
			id: portId(card.id, "use"),
			x: card.width,
			y: rowCenterY(-1),
			width: 0,
			height: 0,
			layoutOptions: { "elk.port.side": "EAST" },
		},
	];
	for (const row of [...rowsWithRefs].sort((a, b) => a - b)) {
		ports.push({
			id: portId(card.id, `row${row}`),
			x: card.width,
			y: rowCenterY(row),
			width: 0,
			height: 0,
			layoutOptions: { "elk.port.side": "EAST" },
		});
	}
	return ports;
}

type LayoutEdgeInput = ElkExtendedEdge & {
	kind: PlacedEdge["kind"];
	from: string;
	to: string;
};

interface Cards {
	models: Map<string, ModelCard>;
	files: Map<string, FilesCard>;
}

/**
 * Relation edges leave from the row holding the reference; usage edges point
 * from a directory's code to the model it uses, so every edge runs
 * dependent → dependency and the layered layout reads left to right.
 * Returns the edges and, per model, the rows that need an outgoing port.
 */
function layoutEdges(
	graph: ModelGraph,
	cards: Cards,
): { edges: LayoutEdgeInput[]; rowsWithRefs: Map<string, Set<number>> } {
	const rowsWithRefs = new Map<string, Set<number>>();
	const edges: LayoutEdgeInput[] = [];
	for (const rel of graph.relations) {
		const card = cards.models.get(rel.from);
		if (!card || !cards.models.has(rel.to)) continue;
		const row = relationRow(card, rel);
		const rows = rowsWithRefs.get(rel.from) ?? new Set<number>();
		rowsWithRefs.set(rel.from, rows.add(row));
		const source = row < 0 ? "use" : `row${row}`;
		edges.push({
			id: rel.id,
			kind: rel.kind,
			from: rel.from,
			to: rel.to,
			sources: [portId(rel.from, source)],
			targets: [portId(rel.to, "in")],
		});
	}
	for (const u of graph.usages) {
		const source = filesCardId(u.directory);
		edges.push({
			id: u.id,
			kind: "usage",
			from: source,
			to: u.model,
			sources: [portId(source, "out")],
			targets: [portId(u.model, "in")],
		});
	}
	return { edges, rowsWithRefs };
}

function filesNode(f: FilesCard): ElkNode {
	return {
		id: f.id,
		width: f.width,
		height: f.height,
		ports: [
			{
				id: portId(f.id, "out"),
				x: f.width,
				y: FILES_HEADER_H / 2,
				width: 0,
				height: 0,
				layoutOptions: { "elk.port.side": "EAST" },
			},
		],
		layoutOptions: { "elk.portConstraints": "FIXED_POS" },
	};
}

/** Leaf nodes (model cards and file cards), grouped by directory id. */
function leafNodes(
	graph: ModelGraph,
	cards: Cards,
	rowsWithRefs: Map<string, Set<number>>,
): Map<string, ElkNode[]> {
	const children = new Map<string, ElkNode[]>();
	const push = (dir: string, node: ElkNode): void => {
		children.set(dir, [...(children.get(dir) ?? []), node]);
	};
	for (const model of graph.models) {
		const card = cards.models.get(model.id);
		if (!card) continue;
		push(model.directory, {
			id: card.id,
			width: card.width,
			height: card.height,
			ports: modelPorts(card, rowsWithRefs.get(card.id) ?? new Set()),
			layoutOptions: { "elk.portConstraints": "FIXED_POS" },
		});
	}
	for (const f of cards.files.values()) push(f.directory, filesNode(f));
	return children;
}

/**
 * Directories with nothing to draw (no models, no code using models, and no
 * drawn subdirectories) stay in graph.json but are left out of the picture.
 */
function drawnDirectories(
	graph: ModelGraph,
	children: Map<string, ElkNode[]>,
): Set<string> {
	const drawn = new Set<string>();
	// Sorted paths put every child after its parent, so reversed order visits children first.
	for (const d of [...graph.directories].reverse()) {
		const hasDrawnChild = graph.directories.some(
			(c) => c.parent === d.id && drawn.has(c.id),
		);
		if (children.has(d.id) || hasDrawnChild) drawn.add(d.id);
	}
	return drawn;
}

const CONTAINER_OPTIONS = {
	"elk.padding": `[top=${DIR_LABEL_H + 12}, left=14, bottom=14, right=14]`,
	"elk.spacing.nodeNode": "24",
};

const ROOT_OPTIONS = {
	"elk.algorithm": "layered",
	"elk.direction": "RIGHT",
	"elk.hierarchyHandling": "INCLUDE_CHILDREN",
	"elk.edgeRouting": "ORTHOGONAL",
	"elk.layered.spacing.nodeNodeBetweenLayers": "56",
	"elk.layered.spacing.edgeNodeBetweenLayers": "20",
	"elk.spacing.edgeEdge": "8",
	"elk.spacing.edgeNode": "16",
	"elk.spacing.nodeNode": "24",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
	"elk.padding": `[top=${MARGIN}, left=${MARGIN}, bottom=${MARGIN}, right=${MARGIN}]`,
};

function elkGraph(
	graph: ModelGraph,
	cards: Cards,
): { root: ElkNode; edges: LayoutEdgeInput[] } {
	const { edges, rowsWithRefs } = layoutEdges(graph, cards);
	const children = leafNodes(graph, cards, rowsWithRefs);
	const drawn = drawnDirectories(graph, children);
	const dirNode = (dirId: string): ElkNode => ({
		id: dirId,
		layoutOptions: CONTAINER_OPTIONS,
		children: [
			...(children.get(dirId) ?? []),
			...graph.directories
				.filter((d) => d.parent === dirId && drawn.has(d.id))
				.map((d) => dirNode(d.id)),
		],
	});
	const rootDir = graph.directories.find((d) => d.parent === null);
	if (!rootDir) throw new Error("graph has no root directory");
	return {
		root: {
			id: ROOT_ID,
			layoutOptions: ROOT_OPTIONS,
			children: [dirNode(rootDir.id)],
			edges,
		},
		edges,
	};
}

const ROOT_ID = "__root__";

/** Walks ELK's result, converting parent-relative positions to absolute ones. */
class Placer {
	readonly layout: Layout;
	private readonly absolute = new Map<string, Point>([
		[ROOT_ID, { x: 0, y: 0 }],
	]);
	private readonly dirById: Map<string, ModelGraph["directories"][number]>;

	constructor(
		graph: ModelGraph,
		private readonly cards: Cards,
		result: ElkNode,
	) {
		this.dirById = new Map(graph.directories.map((d) => [d.id, d]));
		this.layout = {
			width: Math.ceil(result.width ?? 0),
			height: Math.ceil(result.height ?? 0),
			directories: [],
			models: [],
			files: [],
			edges: [],
		};
	}

	placeNodes(node: ElkNode, origin: Point, depth: number): void {
		const x = origin.x + (node.x ?? 0);
		const y = origin.y + (node.y ?? 0);
		this.absolute.set(node.id, { x, y });
		const box = { x, y, width: node.width ?? 0, height: node.height ?? 0 };
		const dir = this.dirById.get(node.id);
		if (dir)
			this.layout.directories.push({
				id: dir.id,
				label: `${dir.name}/`,
				depth,
				...box,
			});
		this.placeLeaf(node.id, box);
		for (const child of node.children ?? [])
			this.placeNodes(child, { x, y }, dir ? depth + 1 : depth);
	}

	private placeLeaf(id: string, box: Box): void {
		const card = this.cards.models.get(id);
		if (card) this.layout.models.push({ ...card, ...box });
		const files = this.cards.files.get(id);
		if (files) this.layout.files.push({ ...files, ...box });
	}

	placeEdges(node: ElkNode, meta: Map<string, LayoutEdgeInput>): void {
		for (const e of node.edges ?? []) {
			const m = meta.get(e.id);
			if (m) this.layout.edges.push(this.placedEdge(e, node.id, m));
		}
		for (const child of node.children ?? []) this.placeEdges(child, meta);
	}

	private placedEdge(
		e: ElkExtendedEdge,
		declaredIn: string,
		m: LayoutEdgeInput,
	): PlacedEdge {
		// Edge coordinates are relative to the edge's container (`container` in
		// ELK's output), which defaults to the node it was declared in.
		const containerId = (e as { container?: string }).container ?? declaredIn;
		const o = this.absolute.get(containerId) ?? { x: 0, y: 0 };
		const points = (e.sections ?? []).flatMap((s) => [
			s.startPoint,
			...(s.bendPoints ?? []),
			s.endPoint,
		]);
		return {
			id: m.id,
			kind: m.kind,
			from: m.from,
			to: m.to,
			points: points.map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
		};
	}
}

/**
 * Lays out the graph with ELK's layered algorithm: directories become nested
 * compound nodes, model cards and per-directory file cards are leaves, and
 * edges leave from the port of the property row that references the target.
 * ELK is deterministic for identical input, and every input list here is
 * sorted by id, so the layout is reproducible.
 */
export async function computeLayout(graph: ModelGraph): Promise<Layout> {
	const cards: Cards = {
		models: new Map(graph.models.map((m) => [m.id, modelCard(m)])),
		files: new Map(filesCards(graph).map((f) => [f.id, f])),
	};
	const { root, edges } = elkGraph(graph, cards);
	const result = await new ElkClass().layout(root);
	const placer = new Placer(graph, cards, result);
	for (const child of result.children ?? [])
		placer.placeNodes(child, { x: 0, y: 0 }, 0);
	placer.placeEdges(result, new Map(edges.map((e) => [e.id, e])));
	placer.layout.edges.sort((a, b) => compareStrings(a.id, b.id));
	return placer.layout;
}
