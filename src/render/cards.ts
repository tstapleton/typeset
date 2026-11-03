// Card content and geometry, shared by layout (sizes, port positions) and
// SVG drawing (text), so the two can never disagree about where a row is.

import {
	compareStrings,
	type Member,
	type Model,
	type ModelGraph,
	type Relation,
} from "../graph.js";

const CHAR_W = 7.2; // 12px monospace advance width
export const ROW_H = 20;
export const HEADER_H = 40;
export const PAD_X = 10;
const MIN_CARD_W = 180;
const SHARED_PILL_CHARS = 10; // room for the pill next to the name
/** Rows longer than this are truncated with an ellipsis; the full text is in a tooltip and the detail panel. */
export const MAX_ROW_CHARS = 64;

export type RowKind = "extends" | "alias" | "member";

export interface CardRow {
	kind: RowKind;
	/** Member name (member rows only). */
	member?: string;
	/** Left part, e.g. `readonly id?`; empty for alias/extends rows. */
	name: string;
	/** Separator drawn between name and type (`: `, `` or ` = `). */
	sep: string;
	type: string;
	/** Names in `type` that are models in the tree, as written → model id. */
	modelNames: Record<string, string>;
	/** Names in `type` that resolved outside the tree (or to non-model declarations). */
	externalNames: string[];
	doc?: string;
}

export interface ModelCard {
	id: string;
	title: string;
	subtitle: string;
	/** Labels of the other top-level directories using this model. */
	sharedWith: string[];
	rows: CardRow[];
	width: number;
	height: number;
}

export interface FilesCard {
	/** `files:<directory id>` */
	id: string;
	directory: string;
	rows: Array<{ file: string; label: string; models: number }>;
	width: number;
	height: number;
}

export const filesCardId = (directory: string): string => `files:${directory}`;

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Splits alias text into rows at top-level `|` / `&` where possible. */
function wrapAlias(text: string): string[] {
	if (text.length <= MAX_ROW_CHARS - 2) return [text];
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if ("<({[".includes(c)) depth++;
		else if (">)}]".includes(c)) depth--;
		else if (depth === 0 && (c === "|" || c === "&") && i > start) {
			parts.push(text.slice(start, i).trim());
			start = i;
		}
	}
	parts.push(text.slice(start).trim());
	return parts.filter(Boolean);
}

export function rowText(row: CardRow): string {
	return `${row.name}${row.sep}${row.type}`;
}

function refsToNames(
	refs: Array<{ text: string; target: string }>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const r of refs) out[r.text] = r.target;
	return out;
}

function extendsRows(model: Model): CardRow[] {
	if (model.extends.length === 0) return [];
	return [
		{
			kind: "extends",
			name: "extends",
			sep: " ",
			type: model.extends.map((h) => h.text).join(", "),
			modelNames: refsToNames(model.extends.flatMap((h) => h.refs)),
			externalNames: model.extends.flatMap((h) =>
				h.external.map((e) => e.name),
			),
		},
	];
}

function aliasRows(model: Model): CardRow[] {
	if (!model.aliasOf) return [];
	const { type, refs, external } = model.aliasOf;
	return wrapAlias(type).map((part, i) => ({
		kind: "alias",
		name: i === 0 ? "=" : " ",
		sep: " ",
		type: part,
		modelNames: refsToNames(refs),
		externalNames: external.map((e) => e.name),
	}));
}

const SEPARATORS: Partial<Record<Member["kind"], string>> = {
	method: "",
	call: "",
	construct: "",
};

function memberRow(m: Member): CardRow {
	const isEnum = m.kind === "enum-member";
	const readonly = m.readonly && !isEnum ? "readonly " : "";
	const sep = isEnum ? (m.type ? " = " : "") : (SEPARATORS[m.kind] ?? ": ");
	return {
		kind: "member",
		member: m.name,
		name: `${readonly}${m.name}${m.optional ? "?" : ""}`,
		sep,
		type: m.type,
		modelNames: refsToNames(m.refs),
		externalNames: m.external.map((e) => e.name),
		...(m.doc ? { doc: m.doc } : {}),
	};
}

export function modelCard(model: Model, sharedWith: string[]): ModelCard {
	const rows = [
		...extendsRows(model),
		...aliasRows(model),
		...model.members.map(memberRow),
	];
	const params = model.typeParameters.join(", ");
	const title = params ? `${model.name}<${params}>` : model.name;
	const subtitle = basename(model.file);
	const longest = Math.max(
		title.length + (sharedWith.length > 0 ? SHARED_PILL_CHARS : 0),
		subtitle.length,
		...rows.map((r) => Math.min(MAX_ROW_CHARS, rowText(r).length)),
	);
	return {
		id: model.id,
		title,
		subtitle,
		sharedWith,
		rows,
		width: Math.max(MIN_CARD_W, Math.ceil(longest * CHAR_W + PAD_X * 2)),
		height: HEADER_H + Math.max(1, rows.length) * ROW_H + 6,
	};
}

/** Row index a relation leaves from, or -1 for the header. */
export function relationRow(card: ModelCard, rel: Relation): number {
	if (rel.kind === "extends")
		return card.rows.findIndex((r) => r.kind === "extends");
	if (rel.kind === "alias")
		return card.rows.findIndex((r) => r.kind === "alias");
	return card.rows.findIndex(
		(r) => r.kind === "member" && r.member === rel.member,
	);
}

/** Y offset of a row's centre within its card. */
export function rowCenterY(row: number): number {
	return row < 0 ? HEADER_H / 2 : HEADER_H + row * ROW_H + ROW_H / 2;
}

/**
 * One card per directory listing its implementation files that use models,
 * the target of usage edges.
 */
export function filesCards(graph: ModelGraph): FilesCard[] {
	const byDir = new Map<string, Map<string, Set<string>>>();
	for (const u of graph.usages) {
		const files = byDir.get(u.directory) ?? new Map<string, Set<string>>();
		for (const s of u.sites) {
			const models = files.get(s.file) ?? new Set<string>();
			models.add(u.model);
			files.set(s.file, models);
		}
		byDir.set(u.directory, files);
	}
	return [...byDir.entries()]
		.sort(([a], [b]) => compareStrings(a, b))
		.map(([directory, files]) => {
			const rows = [...files.entries()]
				.sort(([a], [b]) => compareStrings(a, b))
				.map(([file, models]) => ({
					file,
					label: basename(file),
					models: models.size,
				}));
			const longest = Math.max(10, ...rows.map((r) => r.label.length + 4));
			return {
				id: filesCardId(directory),
				directory,
				rows,
				width: Math.max(150, Math.ceil(longest * CHAR_W + PAD_X * 2)),
				height: 28 + rows.length * ROW_H + 6,
			};
		});
}

export const FILES_HEADER_H = 28;
