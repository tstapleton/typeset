#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeEvidence } from "./evidence.js";
import { extract } from "./extract/extract.js";
import {
	computeDirectoryLayout,
	renderDirectorySvg,
} from "./render/directories.js";
import { buildHtml } from "./render/html.js";
import { computeLayout } from "./render/layout.js";
import { renderSvg } from "./render/svg.js";

export interface Args {
	featureDir: string | null;
	repoRoot: string | null;
	outDir: string;
	tsconfig: string | null;
}

const HELP = `Usage: typeset [options] <feature-dir>

Diagram the interfaces, type aliases and enums declared in a TypeScript
feature directory: their properties, the models they reference, and the
directories whose code uses them.

Arguments:
  feature-dir          Feature directory to analyze (relative to --repo-root)

Options:
  --repo-root <path>   Repo root (default: nearest ancestor with .git, else cwd)
  --out-dir <dir>      Output directory (default: dist/typeset)
  --tsconfig <path>    tsconfig for module resolution (default: nearest
                       tsconfig.json from the feature directory up to the repo root)
  -h, --help           Show this help

Outputs: <out-dir>/index.html, <out-dir>/graph.json, <out-dir>/diagram.svg
Skipped: *.spec.ts, *.test.ts, *.stories.ts, *.d.ts, and directories named
__fixtures__, __mocks__, diagnostics, fixtures, integration or node_modules.`;

function flagValue(argv: string[], i: number, flag: string): string {
	const v = argv[i];
	if (v === undefined || v.startsWith("-"))
		throw new Error(`Error: ${flag} needs a value`);
	return v;
}

export function parseArgs(argv: string[]): Args | "help" {
	const args: Args = {
		featureDir: null,
		repoRoot: null,
		outDir: "dist/typeset",
		tsconfig: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i];
		if (t === "-h" || t === "--help") return "help";
		if (t === "--repo-root") args.repoRoot = flagValue(argv, ++i, t);
		else if (t === "--out-dir") args.outDir = flagValue(argv, ++i, t);
		else if (t === "--tsconfig") args.tsconfig = flagValue(argv, ++i, t);
		else if (t.startsWith("-")) throw new Error(`Error: unknown option: ${t}`);
		else if (args.featureDir !== null)
			throw new Error(`Error: unexpected extra argument "${t}"`);
		else args.featureDir = t;
	}
	return args;
}

export function detectRepoRoot(startDir: string): string {
	let dir = startDir;
	while (path.dirname(dir) !== dir) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		dir = path.dirname(dir);
	}
	return startDir;
}

export interface GenerateResult {
	files: string[];
	models: number;
	relations: number;
	usages: number;
}

/** The whole pipeline: extract → evidence → layout → render → write. */
export async function generate(
	featureDir: string,
	options: { repoRoot: string; outDir: string; tsconfig?: string },
): Promise<GenerateResult> {
	const graph = extract(featureDir, {
		repoRoot: options.repoRoot,
		...(options.tsconfig
			? { tsConfigFilePath: path.resolve(options.tsconfig) }
			: {}),
	});
	const evidence = computeEvidence(graph);
	const layout = await computeLayout(graph);
	const svg = renderSvg(
		layout,
		new Map(graph.models.map((m) => [m.id, m.exported])),
	);
	const directoriesSvg = renderDirectorySvg(
		await computeDirectoryLayout(graph),
	);
	const html = await buildHtml(graph, evidence, svg, directoriesSvg);

	await mkdir(options.outDir, { recursive: true });
	const out = (name: string): string => path.join(options.outDir, name);
	await writeFile(out("graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
	await writeFile(out("diagram.svg"), `${svg}\n`);
	await writeFile(out("index.html"), html);
	return {
		files: ["index.html", "graph.json", "diagram.svg"].map(out),
		models: graph.models.length,
		relations: graph.relations.length,
		usages: graph.usages.length,
	};
}

function resolveFeatureDir(args: Args): {
	repoRoot: string;
	featureDir: string;
} {
	if (!args.featureDir) throw new Error(HELP);
	const repoRoot = path.resolve(args.repoRoot ?? detectRepoRoot(process.cwd()));
	const featureDir = path.resolve(repoRoot, args.featureDir);
	if (!existsSync(featureDir) || !statSync(featureDir).isDirectory()) {
		throw new Error(`Error: feature directory not found: ${featureDir}`);
	}
	return { repoRoot, featureDir };
}

/** Runs the CLI; returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
	let args: Args | "help";
	let dirs: { repoRoot: string; featureDir: string };
	try {
		args = parseArgs(argv);
		if (args === "help") {
			console.log(HELP);
			return 0;
		}
		dirs = resolveFeatureDir(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
	console.log(
		`Analyzing ${path.relative(dirs.repoRoot, dirs.featureDir) || "."} ...`,
	);
	const result = await generate(dirs.featureDir, {
		repoRoot: dirs.repoRoot,
		outDir: path.resolve(args.outDir),
		...(args.tsconfig ? { tsconfig: args.tsconfig } : {}),
	});
	console.log(
		`  ${result.models} models, ${result.relations} model references, ${result.usages} directory usages`,
	);
	if (result.models === 0)
		console.warn("Warning: no interfaces, type aliases or enums found");
	for (const f of result.files) console.log(`Wrote ${f}`);
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	run(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			console.error(err);
			process.exitCode = 1;
		},
	);
}
