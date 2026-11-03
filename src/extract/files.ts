import { readdirSync } from "node:fs";
import path from "node:path";
import { compareStrings } from "../graph.js";

// Directory names excluded anywhere below the feature directory. The check is
// on path segments relative to the feature directory, so a feature that itself
// lives under e.g. `fixtures/` is still analyzed.
const EXCLUDED_DIRS = new Set([
	"__fixtures__",
	"__mocks__",
	"diagnostics",
	"fixtures",
	"integration",
	"node_modules",
]);

const EXCLUDED_SUFFIXES = [".spec.ts", ".test.ts", ".stories.ts", ".d.ts"];

function isExcludedFile(name: string): boolean {
	return (
		!name.endsWith(".ts") || EXCLUDED_SUFFIXES.some((s) => name.endsWith(s))
	);
}

function isExcludedDir(name: string): boolean {
	return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

/** POSIX path of `p` relative to `from`. */
export function posixRelative(from: string, p: string): string {
	return path.relative(from, p).split(path.sep).join("/");
}

/**
 * Every analyzable `.ts` file under `featureDir`, as feature-relative POSIX
 * paths in sorted order.
 */
export function listFeatureFiles(featureDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!isExcludedDir(entry.name)) walk(full);
			} else if (entry.isFile() && !isExcludedFile(entry.name)) {
				out.push(posixRelative(featureDir, full));
			}
		}
	};
	walk(featureDir);
	return out.sort(compareStrings);
}

/** Feature-relative directory of a feature-relative file path ("" for the root). */
export function dirOf(file: string): string {
	const i = file.lastIndexOf("/");
	return i === -1 ? "" : file.slice(0, i);
}
