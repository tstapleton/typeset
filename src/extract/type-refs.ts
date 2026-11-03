import path from "node:path";
import {
	type ArrayTypeNode,
	type ConditionalTypeNode,
	type ConstructorTypeNode,
	type ExpressionWithTypeArguments,
	type FunctionTypeNode,
	type Identifier,
	type IndexedAccessTypeNode,
	type IntersectionTypeNode,
	type MappedTypeNode,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
	type Symbol as TsSymbol,
	type TupleTypeNode,
	type TypeOperatorTypeNode,
	type TypeReferenceNode,
	type UnionTypeNode,
} from "ts-morph";
import type { ExternalRef, ModelRef, ViaStep } from "../graph.js";
import { posixRelative } from "./files.js";

export interface RefCollector {
	refs: ModelRef[];
	external: ExternalRef[];
}

/**
 * Resolves names to models. Built once per extraction; `modelIdByDecl` maps
 * every model declaration node to its model id.
 */
export class Resolver {
	constructor(
		private readonly project: Project,
		private readonly repoRoot: string,
		private readonly featureDir: string,
		private readonly modelIdByDecl: Map<Node, string>,
	) {}

	/** Follows import/export aliases to the symbol that owns the declarations. */
	static unalias(symbol: TsSymbol): TsSymbol {
		if (!symbol.isAlias()) return symbol;
		return symbol.getAliasedSymbol() ?? symbol;
	}

	/** The model id an identifier refers to, if it refers to a model in the tree. */
	modelFor(id: Identifier): string | undefined {
		const symbol = id.getSymbol();
		if (!symbol) return undefined;
		for (const decl of Resolver.unalias(symbol).getDeclarations()) {
			const modelId = this.modelIdByDecl.get(decl);
			if (modelId) return modelId;
		}
		return undefined;
	}

	/**
	 * Classifies the name at a type reference site: a model, an external
	 * declaration, or nothing worth recording (type parameters, built-ins).
	 */
	resolve(
		nameNode: Identifier,
		text: string,
		via: ViaStep[],
		out: RefCollector,
	): void {
		const modelId = this.modelFor(nameNode);
		if (modelId) {
			out.refs.push({ target: modelId, text, via });
			return;
		}
		const symbol = nameNode.getSymbol();
		if (!symbol) return;
		const target = Resolver.unalias(symbol);
		const decls = target.getDeclarations();
		if (decls.length === 0) {
			// An import whose module does not resolve (e.g. a package that is not
			// installed): fall back to the specifier as written.
			const specifier = importSpecifierOf(symbol);
			if (specifier !== undefined) {
				out.external.push({
					name: nameNode.getText(),
					module: specifier,
					inFeature: false,
					via,
				});
			}
			return;
		}
		const decl = decls[0];
		if (Node.isTypeParameterDeclaration(decl)) return;
		const sf = decl.getSourceFile();
		if (this.isDefaultLib(sf)) return;
		const module = this.moduleOf(sf);
		out.external.push({
			name: target.getName(),
			module: module.name,
			inFeature: module.inFeature,
			via,
		});
	}

	private isDefaultLib(sf: SourceFile): boolean {
		return this.project
			.getProgram()
			.compilerObject.isSourceFileDefaultLibrary(sf.compilerNode);
	}

	private moduleOf(sf: SourceFile): { name: string; inFeature: boolean } {
		const filePath = sf.getFilePath();
		const nm = filePath.lastIndexOf("/node_modules/");
		if (nm !== -1) {
			const rest = filePath.slice(nm + "/node_modules/".length).split("/");
			const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
			return { name: name.replace(/^@types\//, ""), inFeature: false };
		}
		const inFeature =
			filePath === this.featureDir ||
			filePath.startsWith(this.featureDir + path.sep) ||
			filePath.startsWith(`${this.featureDir}/`);
		return { name: posixRelative(this.repoRoot, filePath), inFeature };
	}
}

function importSpecifierOf(symbol: TsSymbol): string | undefined {
	for (const decl of symbol.getDeclarations()) {
		const imp = decl.getFirstAncestor(Node.isImportDeclaration);
		if (imp) return imp.getModuleSpecifierValue();
	}
	return undefined;
}

const ARRAY_GENERICS = new Set(["Array", "ReadonlyArray"]);

/** Rightmost identifier of `A`, `ns.A`, or an expression `ns.A` in a heritage clause. */
function nameIdentifier(node: Node): Identifier | undefined {
	if (Node.isIdentifier(node)) return node;
	if (Node.isQualifiedName(node)) return node.getRight();
	if (Node.isPropertyAccessExpression(node)) return node.getNameNode();
	return undefined;
}

type Child = [Node | undefined, ViaStep | undefined];

const each = (nodes: Node[], step: ViaStep): Child[] =>
	nodes.map((n) => [n, step]);

/**
 * For each type constructor, the child type nodes to walk and the step that
 * records how they are reached. Kinds not listed are walked through
 * unchanged (parenthesized types, type literals, named tuple members, …).
 */
const CHILDREN: Partial<Record<SyntaxKind, (node: Node) => Child[]>> = {
	[SyntaxKind.ArrayType]: (n) => [
		[(n as ArrayTypeNode).getElementTypeNode(), "array"],
	],
	[SyntaxKind.UnionType]: (n) =>
		each((n as UnionTypeNode).getTypeNodes(), "union"),
	[SyntaxKind.IntersectionType]: (n) =>
		each((n as IntersectionTypeNode).getTypeNodes(), "intersection"),
	[SyntaxKind.TupleType]: (n) =>
		each((n as TupleTypeNode).getElements(), "tuple"),
	[SyntaxKind.FunctionType]: (n) => signatureChildren(n as FunctionTypeNode),
	[SyntaxKind.ConstructorType]: (n) =>
		signatureChildren(n as ConstructorTypeNode),
	[SyntaxKind.IndexedAccessType]: (n) => {
		const t = n as IndexedAccessTypeNode;
		return each([t.getObjectTypeNode(), t.getIndexTypeNode()], "indexed");
	},
	// `keyof T` reaches T's keys, not T itself; `readonly T[]` is still T[].
	[SyntaxKind.TypeOperator]: (n) => {
		const t = n as TypeOperatorTypeNode;
		return [
			[
				t.getTypeNode(),
				t.getOperator() === SyntaxKind.KeyOfKeyword ? "keyof" : undefined,
			],
		];
	},
	[SyntaxKind.MappedType]: (n) => {
		const t = n as MappedTypeNode;
		return [
			[t.getTypeParameter().getConstraint(), "mapped"],
			[t.getTypeNode(), "mapped"],
		];
	},
	[SyntaxKind.ConditionalType]: (n) => {
		const t = n as ConditionalTypeNode;
		return each(
			[t.getCheckType(), t.getExtendsType(), t.getTrueType(), t.getFalseType()],
			"conditional",
		);
	},
	// `typeof value` refers to a value, not a model.
	[SyntaxKind.TypeQuery]: () => [],
};

function signatureChildren(
	node: FunctionTypeNode | ConstructorTypeNode,
): Child[] {
	return [
		...node.getParameters().map((p): Child => [p.getTypeNode(), "function"]),
		[node.getReturnTypeNode(), "function"],
	];
}

function passThroughChildren(node: Node): Child[] {
	return node
		.getChildren()
		.flatMap((c) =>
			c.getKind() === SyntaxKind.SyntaxList ? c.getChildren() : [c],
		)
		.filter(
			(c) =>
				Node.isTypeNode(c) ||
				Node.isTypeElement(c) ||
				Node.isParameterDeclaration(c),
		)
		.map((c): Child => [c, undefined]);
}

/** A named type reference: resolve the name, then walk its type arguments. */
function referenceChildren(
	node: TypeReferenceNode | ExpressionWithTypeArguments,
	via: ViaStep[],
	resolver: Resolver,
	out: RefCollector,
): Child[] {
	const nameNode = Node.isTypeReference(node)
		? node.getTypeName()
		: node.getExpression();
	const id = nameIdentifier(nameNode);
	const name = nameNode.getText();
	if (id) resolver.resolve(id, name, via, out);
	const step: ViaStep = ARRAY_GENERICS.has(name) ? "array" : `generic:${name}`;
	return each(node.getTypeArguments(), step);
}

/**
 * Walks a type node and records every named type it mentions, with the path
 * of type constructors (`via`) that leads to it. Purely syntactic apart from
 * name resolution, so it keeps aliases as written (`Unit[]` stays `Unit`,
 * rather than expanding to its literal union).
 */
function collectTypeRefs(
	node: Node,
	via: ViaStep[],
	resolver: Resolver,
	out: RefCollector,
): void {
	const children =
		Node.isTypeReference(node) || Node.isExpressionWithTypeArguments(node)
			? referenceChildren(node, via, resolver, out)
			: (CHILDREN[node.getKind()]?.(node) ?? passThroughChildren(node));
	for (const [child, step] of children) {
		if (child)
			collectTypeRefs(child, step ? [...via, step] : via, resolver, out);
	}
}

/** `collectTypeRefs` into a fresh collector. */
export function refsOf(
	node: Node | undefined,
	resolver: Resolver,
	via: ViaStep[] = [],
): RefCollector {
	const out: RefCollector = { refs: [], external: [] };
	if (node) collectTypeRefs(node, via, resolver, out);
	return out;
}
