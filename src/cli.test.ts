import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./cli.js";

describe("parseArgs", () => {
	it("parses the feature directory and options", () => {
		expect(
			parseArgs([
				"--repo-root",
				"r",
				"--out-dir",
				"o",
				"--tsconfig",
				"t",
				"src/app/x",
			]),
		).toEqual({
			featureDir: "src/app/x",
			repoRoot: "r",
			outDir: "o",
			tsconfig: "t",
		});
	});
	it("defaults the output directory", () => {
		expect(parseArgs(["x"])).toMatchObject({
			featureDir: "x",
			outDir: "dist/typeset",
		});
	});
	it("rejects unknown options, missing values and extra arguments", () => {
		expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
		expect(() => parseArgs(["--out-dir"])).toThrow(/needs a value/);
		expect(() => parseArgs(["a", "b"])).toThrow(/extra argument/);
	});
	it("returns help", () => {
		expect(parseArgs(["-h"])).toBe("help");
	});
});

describe("run", () => {
	const fixture = new URL("../fixtures/feature-app", import.meta.url).pathname;
	const out = mkdtempSync(path.join(tmpdir(), "typeset-cli-"));
	afterAll(() => rmSync(out, { recursive: true, force: true }));
	const quiet = () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	};

	it("writes index.html, graph.json and diagram.svg", async () => {
		quiet();
		const code = await run([
			"--repo-root",
			fixture,
			"--out-dir",
			out,
			"src/app/features/orders",
		]);
		expect(code).toBe(0);
		expect(readdirSync(out).sort()).toEqual([
			"diagram.svg",
			"graph.json",
			"index.html",
		]);
	});

	it("fails on a missing feature directory or no arguments", async () => {
		quiet();
		expect(await run(["--repo-root", fixture, "src/nope"])).toBe(1);
		expect(await run([])).toBe(1);
		expect(await run(["--help"])).toBe(0);
	});
});
