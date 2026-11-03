import {
	type CardRow,
	FILES_HEADER_H,
	HEADER_H,
	MAX_ROW_CHARS,
	PAD_X,
	ROW_H,
	rowText,
} from "./cards.js";
import type { Layout, PlacedEdge, Point } from "./layout.js";

export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const PRIMITIVES = new Set([
	"string",
	"number",
	"boolean",
	"bigint",
	"symbol",
	"null",
	"undefined",
	"void",
	"never",
	"unknown",
	"any",
	"object",
	"true",
	"false",
	"readonly",
	"keyof",
	"typeof",
	"infer",
	"extends",
]);

const TOKEN =
	/('[^']*'?|"[^"]*"?|`[^`]*`?|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+(?:\.\d+)?|\s+|.)/g;

/** Type text as `<tspan>`s: model names link to their card, other names are coloured by kind. */
function typeSpans(text: string, row: CardRow): string {
	const external = new Set(row.externalNames);
	let out = "";
	for (const [tok] of text.matchAll(TOKEN)) {
		const target = row.modelNames[tok];
		if (target)
			out += `<tspan class="t-model" data-target="${esc(target)}">${esc(tok)}</tspan>`;
		else if (external.has(tok) || external.has(tok.split(".").pop() ?? "")) {
			out += `<tspan class="t-ext">${esc(tok)}</tspan>`;
		} else if (/^['"`\d]/.test(tok))
			out += `<tspan class="t-lit">${esc(tok)}</tspan>`;
		else if (PRIMITIVES.has(tok))
			out += `<tspan class="t-prim">${esc(tok)}</tspan>`;
		else out += esc(tok);
	}
	return out;
}

function rowSvg(row: CardRow, index: number): string {
	const y = HEADER_H + index * ROW_H + ROW_H / 2 + 4;
	const full = rowText(row);
	let type = row.type;
	const room = MAX_ROW_CHARS - row.name.length - row.sep.length;
	if (full.length > MAX_ROW_CHARS)
		type = `${type.slice(0, Math.max(0, room - 1))}…`;
	const tip = row.doc ? `${full}\n\n${row.doc}` : full;
	const nameClass = row.kind === "member" ? "r-name" : "r-kw";
	return (
		`<g class="row" data-row="${index}"><title>${esc(tip)}</title>` +
		(index > 0
			? `<line class="row-sep" x1="0" x2="100%" y1="${HEADER_H + index * ROW_H}" y2="${HEADER_H + index * ROW_H}"/>`
			: "") +
		`<text x="${PAD_X}" y="${y}" class="mono">` +
		`<tspan class="${nameClass}">${esc(row.name)}</tspan>` +
		`<tspan class="r-sep">${esc(row.sep)}</tspan>${typeSpans(type, row)}</text></g>`
	);
}

/** The count of other top-level directories using a model, at the right of its header. */
function sharedPillSvg(card: Layout["models"][number]): string {
	const count = card.sharedWith.length;
	const text = `${count} dir${count === 1 ? "" : "s"}`;
	const w = text.length * 6.2 + 12;
	const tip = `Used in ${count} other top-level director${count === 1 ? "y" : "ies"}:\n${card.sharedWith.join("\n")}`;
	return (
		`<g class="shared-pill"><title>${esc(tip)}</title>` +
		`<rect x="${card.width - w - 8}" y="8" width="${w}" height="15" rx="7.5"/>` +
		`<text x="${card.width - w / 2 - 8}" y="19" text-anchor="middle">${text}</text></g>`
	);
}

export function modelCardSvg(
	card: Layout["models"][number],
	exported: boolean,
): string {
	const rows = card.rows.length
		? card.rows.map(rowSvg).join("")
		: `<text x="${PAD_X}" y="${HEADER_H + ROW_H / 2 + 4}" class="mono r-empty">no members</text>`;
	const shared = card.sharedWith.length > 0;
	return (
		`<g class="card model${exported ? "" : " unexported"}${shared ? " shared" : ""}" data-id="${esc(card.id)}" transform="translate(${card.x},${card.y})">` +
		`<svg width="${card.width}" height="${card.height}" overflow="visible">` +
		`<rect class="card-bg" width="${card.width}" height="${card.height}" rx="8"/>` +
		`<path class="card-head" d="M0 8a8 8 0 0 1 8-8h${card.width - 16}a8 8 0 0 1 8 8v${HEADER_H - 8}h-${card.width}z"/>` +
		`<text x="${PAD_X}" y="18" class="title">${esc(card.title)}</text>` +
		`<text x="${PAD_X}" y="33" class="subtitle">${esc(card.subtitle)}${exported ? "" : " · not exported"}</text>` +
		(shared ? sharedPillSvg(card) : "") +
		rows +
		`<rect class="card-outline" width="${card.width}" height="${card.height}" rx="8"/>` +
		`</svg></g>`
	);
}

function filesCardSvg(card: Layout["files"][number]): string {
	const rows = card.rows
		.map((r, i) => {
			const y = FILES_HEADER_H + i * ROW_H + ROW_H / 2 + 4;
			return (
				`<g class="file-row" data-file="${esc(r.file)}"><title>${esc(`${r.file}\nuses ${r.models} model${r.models === 1 ? "" : "s"}`)}</title>` +
				`<text x="${PAD_X}" y="${y}" class="mono">${esc(r.label)}</text>` +
				`<text x="${card.width - PAD_X}" y="${y}" class="mono t-prim" text-anchor="end">${r.models}</text></g>`
			);
		})
		.join("");
	return (
		`<g class="card files" data-id="${esc(card.id)}" data-dir="${esc(card.directory)}" transform="translate(${card.x},${card.y})">` +
		`<rect class="files-bg" width="${card.width}" height="${card.height}" rx="6"/>` +
		`<text x="${PAD_X}" y="18" class="files-title">code using models</text>` +
		rows +
		`</g>`
	);
}

export function pathD(points: Point[]): string {
	if (points.length === 0) return "";
	const r = 6;
	let d = `M${points[0].x} ${points[0].y}`;
	for (let i = 1; i < points.length; i++) {
		const p = points[i];
		const prev = points[i - 1];
		const next = points[i + 1];
		if (!next) {
			d += `L${p.x} ${p.y}`;
			break;
		}
		// Round orthogonal corners.
		const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
		const outLen = Math.hypot(next.x - p.x, next.y - p.y);
		const k = Math.min(r, inLen / 2, outLen / 2);
		const ax = p.x - Math.sign(p.x - prev.x) * k;
		const ay = p.y - Math.sign(p.y - prev.y) * k;
		const bx = p.x + Math.sign(next.x - p.x) * k;
		const by = p.y + Math.sign(next.y - p.y) * k;
		d += `L${ax} ${ay}Q${p.x} ${p.y} ${bx} ${by}`;
	}
	return d;
}

function edgeSvg(e: PlacedEdge): string {
	// An alias body referencing a model reads the same as a property doing so.
	const look = e.kind === "alias" ? "property" : e.kind;
	return `<path class="edge e-${look}" data-id="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${pathD(e.points)}" marker-end="url(#m-${look})"/>`;
}

const STYLE = `
.md{--bg:#0b1120;--dir0:#111a2e;--dir1:#16223b;--dir2:#1c2b48;--dir3:#223456;--dir-stroke:#2f4366;--dir-text:#8aa0c4;
--card:#141c2f;--head:#1d2942;--outline:#3a4d72;--sep:#24324d;--text:#e2e8f0;--dim:#7d8db0;
--model:#60a5fa;--ext:#c4a1ff;--lit:#86efac;--prim:#94a3b8;--kw:#f0abfc;
--e-property:#60a5fa;--e-extends:#c084fc;--e-usage:#f59e0b;--shared:#2dd4bf;--shared-head:#17343f;--files:#1f1a10;--files-stroke:#8a6420}
@media (prefers-color-scheme: light){.md:not(.dark){--bg:#f8fafc;--dir0:#f1f5f9;--dir1:#e8eef6;--dir2:#dfe7f2;--dir3:#d5dfee;--dir-stroke:#b6c4da;--dir-text:#475a7a;
--card:#ffffff;--head:#eef3fa;--outline:#a9b8d0;--sep:#e5ebf3;--text:#0f172a;--dim:#5d6b86;
--model:#1d4ed8;--ext:#7c3aed;--lit:#15803d;--prim:#64748b;--kw:#a21caf;
--e-property:#2563eb;--e-extends:#9333ea;--e-usage:#d97706;--shared:#0f766e;--shared-head:#d9f3ee;--files:#fff7e6;--files-stroke:#d9a441}}
.md{background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:12px;fill:var(--text)}
.dir rect{stroke:var(--dir-stroke);stroke-width:1}
.dir.d0 rect{fill:var(--dir0)}.dir.d1 rect{fill:var(--dir1)}.dir.d2 rect{fill:var(--dir2)}.dir.d3 rect,.dir.d4 rect,.dir.d5 rect{fill:var(--dir3)}
.dir-label{font-size:12px;font-weight:600;fill:var(--dir-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.card-bg{fill:var(--card)}.card-head{fill:var(--head)}.card-outline{fill:none;stroke:var(--outline)}
.unexported .card-outline{stroke-dasharray:4 3}
.shared .card-head{fill:var(--shared-head)}
.shared-pill rect{fill:none;stroke:var(--shared)}.shared-pill text{font-size:9.5px;fill:var(--shared)}
.title{font-size:13px;font-weight:700;fill:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.subtitle{font-size:10px;fill:var(--dim)}
.row-sep{stroke:var(--sep)}
.r-name{fill:var(--text)}.r-kw{fill:var(--kw)}.r-sep{fill:var(--dim)}.r-empty{fill:var(--dim);font-style:italic}
.t-model{fill:var(--model);font-weight:600}.t-ext{fill:var(--ext)}.t-lit{fill:var(--lit)}.t-prim{fill:var(--prim)}
.files-bg{fill:var(--files);stroke:var(--files-stroke);stroke-dasharray:3 2}
.files-title{font-size:10px;font-weight:600;fill:var(--e-usage);text-transform:uppercase;letter-spacing:.05em}
.edge{fill:none;stroke-width:1.5}
.e-property{stroke:var(--e-property)}.e-extends{stroke:var(--e-extends);stroke-width:2}
.e-usage{stroke:var(--e-usage);stroke-width:1;opacity:.6}
.m-property{fill:var(--e-property)}.m-extends{fill:var(--bg);stroke:var(--e-extends);stroke-width:1.5}.m-usage{fill:var(--e-usage)}
`;

const MARKERS =
	`<marker id="m-property" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-property" d="M0 0L10 5L0 10z"/></marker>` +
	`<marker id="m-extends" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path class="m-extends" d="M1 1L11 6L1 11z"/></marker>` +
	`<marker id="m-usage" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="m-usage" d="M0 0L10 5L0 10z"/></marker>`;

export function dirBoxSvg(d: Layout["directories"][number]): string {
	return (
		`<g class="dir d${d.depth}" data-dir="${esc(d.id)}"><rect x="${d.x}" y="${d.y}" width="${d.width}" height="${d.height}" rx="10"/>` +
		`<text class="dir-label" x="${d.x + 14}" y="${d.y + 22}">${esc(d.label)}</text></g>`
	);
}

/**
 * The whole diagram as one standalone SVG document. Styling is embedded, so
 * the same string works as `diagram.svg` and inlined in `index.html`.
 */
export function renderSvg(
	layout: Layout,
	exportedById: ReadonlyMap<string, boolean>,
): string {
	const dirs = layout.directories.map(dirBoxSvg).join("");
	const edges = layout.edges.map(edgeSvg).join("");
	const models = layout.models
		.map((m) => modelCardSvg(m, exportedById.get(m.id) ?? true))
		.join("");
	const files = layout.files.map(filesCardSvg).join("");
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" class="md" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">` +
		`<style>${STYLE}</style><defs>${MARKERS}</defs>` +
		`<rect class="md-bg" width="100%" height="100%" fill="var(--bg)"/>` +
		`<g class="dirs">${dirs}</g><g class="edges">${edges}</g><g class="cards">${models}${files}</g></svg>`
	);
}
