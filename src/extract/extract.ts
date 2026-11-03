import { existsSync } from "node:fs";
import path from "node:path";
import {
	type CallSignatureDeclaration,
	type ConstructSignatureDeclaration,
	type EnumDeclaration,
	type InterfaceDeclaration,
	type JSDocableNode,
	type MethodSignature,
	Node,
	Project,
	SyntaxKind,
	type SourceFile as TsSourceFile,
	type TypeAliasDeclaration,
	type TypeElementTypes,
} from "ts-morph";
import {
	compareStrings,
	type Directory,
	directoryId,
	type Heritage,
	type Member,
	type Model,
	type ModelGraph,
	modelId,
	type Relation,
	SCHEMA_VERSION,
	type SourceFile,
	type Usage,
	type UsageSite,
} from "../graph.js";
import { dirOf, listFeatureFiles, posixRelative } from "./files.js";
import { type RefCollector, Resolver, refsOf } from "./type-refs.js";

export interface ExtractOptions {
	/** Repo root; `featureDir` and external module paths are reported relative to it. */
	repoRoot: string;
	/** tsconfig used for module resolution (paths aliases). Default: nearest tsconfig.json walking up from the feature directory, stopping at the repo root. */
	tsConfigFilePath?: string;
}

type ModelDecl = InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration;

/** Walks up from `startDir` to `repoRoot` (inclusive) looking for a tsconfig.json. */
function findTsConfig(startDir: string, repoRoot: string): string | undefined {
	const root = path.resolve(repoRoot);
	let dir = path.resolve(startDir);
	if (posixRelative(root, dir).startsWith("..")) return undefined;
	while (true) {
		const candidate = path.join(dir, "tsconfig.json");
		if (existsSync(candidate)) return candidate;
		if (dir === root || dir === path.dirname(dir)) return undefined;
		dir = path.dirname(dir);
	}
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function docOf(node: JSDocableNode): string | undefined {
	const [first] = node.getJsDocs();
	if (!first) return undefined;
	const description = first
		.getDescription()
		.trim()
		.split(/\n\s*\n/)[0];
	const doc = collapse(description ?? "");
	return doc || undefined;
}

/** Model declarations at the top level of a file, or inside (nested) namespaces. */
function modelDecls(
	sf: TsSourceFile,
): Array<{ decl: ModelDecl; name: string }> {
	const out: Array<{ decl: ModelDecl; name: string }> = [];
	const visit = (container: Node, prefix: string): void => {
		const statements = Node.isSourceFile(container)
			? container.getStatements()
			: Node.isModuleDeclaration(container)
				? container.getStatements()
				: [];
		for (const st of statements) {
			if (
				Node.isInterfaceDeclaration(st) ||
				Node.isTypeAliasDeclaration(st) ||
				Node.isEnumDeclaration(st)
			) {
				out.push({ decl: st, name: prefix + st.getName() });
			} else if (Node.isModuleDeclaration(st)) {
				visit(st, `${prefix}${st.getName()}.`);
			}
		}
	};
	visit(sf, "");
	return out;
}

function isImplementationStatement(node: Node): boolean {
	if (
		Node.isInterfaceDeclaration(node) ||
		Node.isTypeAliasDeclaration(node) ||
		Node.isImportDeclaration(node) ||
		Node.isExportDeclaration(node) ||
		Node.isEmptyStatement(node)
	) {
		return false;
	}
	// An enum is a model even though it emits code.
	if (Node.isEnumDeclaration(node)) return false;
	if (Node.isModuleDeclaration(node)) {
		return node.getStatements().some(isImplementationStatement);
	}
	return true;
}

type SignatureNode =
	| MethodSignature
	| CallSignatureDeclaration
	| ConstructSignatureDeclaration;

function signatureText(node: SignatureNode): string {
	const typeParams = node.getTypeParameters().map((p) => collapse(p.getText()));
	const params = node.getParameters().map((p) => collapse(p.getText()));
	const ret = node.getReturnTypeNode();
	const tp = typeParams.length ? `<${typeParams.join(", ")}>` : "";
	return `${tp}(${params.join(", ")}): ${ret ? collapse(ret.getText()) : "void"}`;
}

const typeText = (node: Node | undefined): string =>
	node ? collapse(node.getText()) : "any";

/** A member whose type is a single type node: properties, index signatures, accessors. */
function typedMember(
	fields: Pick<Member, "name" | "kind" | "optional" | "readonly">,
	typeNode: Node | undefined,
	resolver: Resolver,
): Member {
	return { ...fields, type: typeText(typeNode), ...refsOf(typeNode, resolver) };
}

const SIGNATURE_NAMES: Record<string, [string, Member["kind"]]> = {
	[SyntaxKind.CallSignature]: ["()", "call"],
	[SyntaxKind.ConstructSignature]: ["new ()", "construct"],
};

function signatureMember(el: SignatureNode, resolver: Resolver): Member {
	const out: RefCollector = { refs: [], external: [] };
	const typeNodes = [
		...el.getParameters().map((p) => p.getTypeNode()),
		el.getReturnTypeNode(),
	];
	for (const node of typeNodes) {
		const r = refsOf(node, resolver, ["function"]);
		out.refs.push(...r.refs);
		out.external.push(...r.external);
	}
	const isMethod = Node.isMethodSignature(el);
	const [name, kind] = isMethod
		? [el.getName(), "method" as const]
		: (SIGNATURE_NAMES[el.getKind()] ?? ["()", "call"]);
	return {
		name,
		kind,
		optional: isMethod && el.hasQuestionToken(),
		readonly: false,
		type: signatureText(el),
		...out,
	};
}

function memberOfElement(
	el: TypeElementTypes,
	resolver: Resolver,
): Member | undefined {
	if (Node.isPropertySignature(el)) {
		const fields = {
			name: el.getName(),
			kind: "property" as const,
			optional: el.hasQuestionToken(),
			readonly: el.isReadonly(),
		};
		return typedMember(fields, el.getTypeNode(), resolver);
	}
	if (Node.isIndexSignatureDeclaration(el)) {
		const name = `[${el.getKeyName()}: ${typeText(el.getKeyTypeNode())}]`;
		const fields = {
			name,
			kind: "index" as const,
			optional: false,
			readonly: el.isReadonly(),
		};
		return typedMember(fields, el.getReturnTypeNode(), resolver);
	}
	if (Node.isGetAccessorDeclaration(el)) {
		const fields = {
			name: el.getName(),
			kind: "property" as const,
			optional: false,
			readonly: true,
		};
		return typedMember(fields, el.getReturnTypeNode(), resolver);
	}
	if (Node.isSetAccessorDeclaration(el)) {
		const fields = {
			name: el.getName(),
			kind: "property" as const,
			optional: false,
			readonly: false,
		};
		return typedMember(fields, el.getParameters()[0]?.getTypeNode(), resolver);
	}
	return signatureMember(el, resolver);
}

function memberOf(
	el: TypeElementTypes,
	resolver: Resolver,
): Member | undefined {
	const member = memberOfElement(el, resolver);
	const doc = Node.isJSDocable(el) ? docOf(el) : undefined;
	return member && doc ? { ...member, doc } : member;
}

function buildModel(
	decl: ModelDecl,
	name: string,
	file: string,
	resolver: Resolver,
): Model {
	const base = {
		id: modelId(file, name),
		name,
		exported: decl.isExported(),
		directory: directoryId(dirOf(file)),
		file,
		line: decl.getStartLineNumber(),
		source: decl.getText(true).replace(/\r\n/g, "\n"),
		...(docOf(decl) ? { doc: docOf(decl) } : {}),
	};

	if (Node.isEnumDeclaration(decl)) {
		return {
			...base,
			kind: "enum",
			typeParameters: [],
			extends: [],
			members: decl.getMembers().map((m) => ({
				name: m.getName(),
				kind: "enum-member",
				optional: false,
				readonly: true,
				type: collapse(m.getInitializer()?.getText() ?? ""),
				refs: [],
				external: [],
				...(docOf(m) ? { doc: docOf(m) } : {}),
			})),
		};
	}

	const typeParameters = decl
		.getTypeParameters()
		.map((p) => collapse(p.getText()));
	const members = (elements: TypeElementTypes[]): Member[] =>
		elements.flatMap((el) => memberOf(el, resolver) ?? []);

	if (Node.isInterfaceDeclaration(decl)) {
		const heritage: Heritage[] = decl.getExtends().map((h) => ({
			text: collapse(h.getText()),
			...refsOf(h, resolver),
		}));
		return {
			...base,
			kind: "interface",
			typeParameters,
			extends: heritage,
			members: members(decl.getMembers()),
		};
	}

	const body = decl.getTypeNode();
	if (body && Node.isTypeLiteral(body)) {
		return {
			...base,
			kind: "type",
			typeParameters,
			extends: [],
			members: members(body.getMembers()),
		};
	}
	return {
		...base,
		kind: "type",
		typeParameters,
		extends: [],
		members: [],
		aliasOf: {
			type: body ? collapse(body.getText()) : "",
			...refsOf(body, resolver),
		},
	};
}

/** Merges a re-declaration (interface/enum declaration merging) into the first one. */
function mergeModel(into: Model, other: Model): void {
	into.members.push(...other.members);
	into.extends.push(...other.extends);
	into.source = `${into.source}\n\n${other.source}`;
	into.exported ||= other.exported;
}

function relationsOf(model: Model): Relation[] {
	const out = new Map<string, Relation>();
	const add = (r: Omit<Relation, "id">): void => {
		const id = `rel:${r.from}->${r.to}@${r.member ?? r.kind}`;
		if (!out.has(id)) out.set(id, { id, ...r });
	};
	for (const m of model.members) {
		for (const ref of m.refs) {
			add({
				from: model.id,
				to: ref.target,
				kind: "property",
				member: m.name,
				via: ref.via,
			});
		}
	}
	for (const h of model.extends) {
		for (const ref of h.refs) {
			add({ from: model.id, to: ref.target, kind: "extends", via: ref.via });
		}
	}
	for (const ref of model.aliasOf?.refs ?? []) {
		add({ from: model.id, to: ref.target, kind: "alias", via: ref.via });
	}
	return [...out.values()];
}

/**
 * References to models from implementation code: every identifier outside
 * model declarations and import/export declarations that resolves to a model.
 */
function usageSitesOf(
	sf: TsSourceFile,
	file: string,
	modelRanges: Array<[number, number]>,
	resolver: Resolver,
	modelFile: Map<string, string>,
): Map<string, UsageSite> {
	const counts = new Map<string, number>();
	for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
		const pos = id.getStart();
		if (modelRanges.some(([s, e]) => pos >= s && pos < e)) continue;
		if (
			id.getFirstAncestor(
				(a) => Node.isImportDeclaration(a) || Node.isExportDeclaration(a),
			)
		) {
			continue;
		}
		const target = resolver.modelFor(id);
		if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
	}
	const sites = new Map<string, UsageSite>();
	for (const [target, count] of counts) {
		sites.set(target, {
			file,
			count,
			via: modelFile.get(target) === file ? "local" : "import",
		});
	}
	return sites;
}

function directoriesOf(featureDir: string, files: string[]): Directory[] {
	const paths = new Set<string>([""]);
	for (const f of files) {
		let d = dirOf(f);
		while (d !== "") {
			paths.add(d);
			d = dirOf(d);
		}
	}
	return [...paths].sort(compareStrings).map((p) => ({
		id: directoryId(p),
		path: p,
		name:
			p === "" ? path.basename(featureDir) : p.slice(p.lastIndexOf("/") + 1),
		parent: p === "" ? null : directoryId(dirOf(p)),
	}));
}

export function extract(
	featureDirInput: string,
	options: ExtractOptions,
): ModelGraph {
	const repoRoot = path.resolve(options.repoRoot);
	const featureDir = path.resolve(repoRoot, featureDirInput);
	const files = listFeatureFiles(featureDir);
	const tsConfigFilePath =
		options.tsConfigFilePath ?? findTsConfig(featureDir, repoRoot);

	const project = new Project({
		...(tsConfigFilePath ? { tsConfigFilePath } : {}),
		skipAddingFilesFromTsConfig: true,
	});
	const sourceFiles = files.map((f) =>
		project.addSourceFileAtPath(path.join(featureDir, f)),
	);
	project.resolveSourceFileDependencies();

	// Pass 1: find every model declaration, so references can be resolved to ids.
	const modelIdByDecl = new Map<Node, string>();
	const declsByFile = new Map<
		string,
		Array<{ decl: ModelDecl; name: string }>
	>();
	sourceFiles.forEach((sf, i) => {
		const decls = modelDecls(sf);
		declsByFile.set(files[i], decls);
		for (const { decl, name } of decls)
			modelIdByDecl.set(decl, modelId(files[i], name));
	});
	const resolver = new Resolver(project, repoRoot, featureDir, modelIdByDecl);

	// Pass 2: models, with members and references.
	const models = new Map<string, Model>();
	for (const file of files) {
		for (const { decl, name } of declsByFile.get(file) ?? []) {
			const model = buildModel(decl, name, file, resolver);
			const existing = models.get(model.id);
			if (existing) mergeModel(existing, model);
			else models.set(model.id, model);
		}
	}
	const modelFile = new Map([...models.values()].map((m) => [m.id, m.file]));

	// Pass 3: usages from implementation code, grouped by directory.
	const usages = new Map<string, Usage>();
	const fileInfos: SourceFile[] = [];
	sourceFiles.forEach((sf, i) => {
		const file = files[i];
		const decls = declsByFile.get(file) ?? [];
		const ranges = decls.map(({ decl }): [number, number] => [
			decl.getPos(),
			decl.getEnd(),
		]);
		const directory = directoryId(dirOf(file));
		for (const [target, site] of usageSitesOf(
			sf,
			file,
			ranges,
			resolver,
			modelFile,
		)) {
			const id = `use:${target}->${directory}`;
			const usage = usages.get(id) ?? {
				id,
				model: target,
				directory,
				sites: [],
			};
			usage.sites.push(site);
			usages.set(id, usage);
		}
		fileInfos.push({
			path: file,
			directory,
			models: [...new Set(decls.map(({ name }) => modelId(file, name)))].sort(
				compareStrings,
			),
			implementation: sf.getStatements().some(isImplementationStatement),
		});
	});

	const byId = <T extends { id: string }>(a: T, b: T): number =>
		compareStrings(a.id, b.id);
	const sortedModels = [...models.values()].sort(byId);
	return {
		schemaVersion: SCHEMA_VERSION,
		featureDir: posixRelative(repoRoot, featureDir),
		directories: directoriesOf(featureDir, files),
		files: fileInfos,
		models: sortedModels,
		relations: sortedModels.flatMap(relationsOf).sort(byId),
		usages: [...usages.values()]
			.map((u) => ({
				...u,
				sites: u.sites.sort((a, b) => compareStrings(a.file, b.file)),
			}))
			.sort(byId),
	};
}
