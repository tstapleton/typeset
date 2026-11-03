import { readFile } from "node:fs/promises";
import type { Evidence } from "../evidence.js";
import type { ModelGraph } from "../graph.js";

const TEMPLATE_PATH = new URL("../../src/template.html", import.meta.url);

/**
 * index.html: the pre-rendered SVGs of both views plus the graph and evidence as JSON for
 * the sidebar, all inline, so the file works from disk or as a GitHub
 * Actions artifact with no server or network access.
 */
export async function buildHtml(
	graph: ModelGraph,
	evidence: Evidence,
	svg: string,
	directoriesSvg: string,
): Promise<string> {
	const template = await readFile(TEMPLATE_PATH, "utf8");
	// "</" is escaped so a type or doc comment containing "</script>" can't end
	// the inline script early; "\/" round-trips through JSON.parse unchanged.
	const json = JSON.stringify({ graph, evidence }).replaceAll("</", "<\\/");
	const title = `Models · ${graph.featureDir}`.replace(/[&<>]/g, (c) =>
		c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
	);
	// Replacement functions, not strings: `$&`-style sequences in the content
	// must be inserted literally.
	return template
		.replace("__TYPESET_TITLE__", () => title)
		.replace("__TYPESET_DIRECTORIES__", () => directoriesSvg)
		.replace("__TYPESET_SVG__", () => svg)
		.replace("__TYPESET_DATA__", () => json);
}
