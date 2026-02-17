import * as vscode from 'vscode';

import type * as Ts from "web-tree-sitter";

const ts = require("./vendor/web-tree-sitter/web-tree-sitter.cjs") as typeof import("web-tree-sitter");

export default function activate(ctx: vscode.ExtensionContext) {
	const langs = new Langs(ctx);
	const onlyGox = [
		{ language: "gox" },
	]
	const goGox = [
		...onlyGox,
		{ language: "go" },
	]
	vscode.languages.registerDocumentSemanticTokensProvider(goGox, langs, LEGEND);
	vscode.languages.registerDocumentRangeSemanticTokensProvider(goGox, langs, LEGEND);
	vscode.languages.registerFoldingRangeProvider(goGox, langs);
}

class Langs implements
	vscode.DocumentSemanticTokensProvider,
	vscode.DocumentRangeSemanticTokensProvider,
	vscode.FoldingRangeProvider {
	private langs = new Map<string, Lang>();
	private initPromise: Promise<void>
	constructor(private ctx: vscode.ExtensionContext) {
		let resolve: () => void;
		this.initPromise = new Promise(r => resolve = r);
		this.init(resolve!).then();
	}
	private async init(resolve: () => void) {
		const uri = vscode.Uri.joinPath(this.ctx.extensionUri, "wasm", "web-tree-sitter", "web-tree-sitter.wasm");
		await ts.Parser.init({
			locateFile: () => uri.fsPath,
		});
		for (const name of ["gox", "go", "html", "css", "javascript"]) {
			const lang = await Lang.create(this.ctx, this, name);
			this.langs.set(name, lang);
		}
		resolve();
	}
	provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): vscode.FoldingRange[] {
		const lang = this.langs.get(document.languageId)
		if (!lang) {
			throw new Error("usupported lang: " + document.languageId)
		}
		const builder = new FoldsBuilder()
		lang.folds(document.getText(), builder)
		return builder.build()
	}
	async provideDocumentSemanticTokens(document: vscode.TextDocument, _token: vscode.CancellationToken) {
		const lang = this.langs.get(document.languageId)
		if (!lang) {
			throw new Error("usupported lang: " + document.languageId)
		}
		await this.initPromise;
		const builder = new TokenBuilder(new vscode.SemanticTokensBuilder(LEGEND))
		lang.tokenize(document.getText(), builder)
		return builder.build()
	}
	async provideDocumentRangeSemanticTokens(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken) {
		const lang = this.langs.get(document.languageId)
		if (!lang) {
			throw new Error("usupported lang: " + document.languageId)
		}
		await this.initPromise;
		const builder = new TokenBuilder(new vscode.SemanticTokensBuilder(LEGEND))
		lang.tokenizeRange(document.getText(), range, builder)
		return builder.build()
	}
	get(id: string): Lang | undefined {
		return this.langs.get(id)
	}
}

class Lang {
	static async create(context: vscode.ExtensionContext, langs: Langs, langId: string): Promise<Lang> {
		const uri = vscode.Uri.joinPath(context.extensionUri, "wasm", langId, "tree-sitter-" + langId + ".wasm");
		const bytes = await vscode.workspace.fs.readFile(uri);
		const lang = await ts.Language.load(bytes);
		return new Lang(
			langs,
			lang,
			{
				folds: await Query.create(context, langId, lang, "folds"),
				highlights: await Query.create(context, langId, lang, "highlights"),
				indets: await Query.create(context, langId, lang, "indets"),
				injections: await Query.create(context, langId, lang, "injections"),
				locals: await Query.create(context, langId, lang, "locals"),
			})
	}
	private parser: Ts.Parser
	constructor(
		private langs: Langs,
		private tsLang: Ts.Language,
		private queries: {
			folds: Query,
			highlights: Query,
			indets: Query,
			injections: Query,
			locals: Query,
		}
	) {
		this.parser = new ts.Parser()
		this.parser.setLanguage(this.tsLang)
	}
	tokenizeRange(source: string, range: vscode.Range, builder: TokenBuilder) {
		const tree = this.parse(source);
		if (tree === null) return;
		type Winner = {
			capture: Ts.QueryCapture;
			token: VsSemantic,
			spec: number;
			startIndex: number;
			endIndex: number;
		};
		const winners = new Map<string, Winner>();
		for (const capture of this.queries.highlights.captures(tree, range)) {
			const token = nvimCaptureToVsCodeSemantic(capture.name);
			if (!token) {
				continue
			}
			const spec = capture.name.split(".").length;
			const startIndex = capture.node.startIndex;
			const endIndex = capture.node.endIndex;
			const key = `${startIndex}:${endIndex}`;
			const prev = winners.get(key);
			if (prev && prev.spec > spec) {
				continue
			}
			const curr: Winner = { capture, token, spec, startIndex, endIndex };
			winners.set(key, curr);
		}
		for (const w of winners.values()) {
			const node = w.capture.node;
			for (let i = node.startPosition.row; i <= node.endPosition.row; i++) {
				let start = node.startPosition.column;
				if (i !== node.startPosition.row) start = 0;
				let end = node.endPosition.column;
				if (i !== node.endPosition.row) end = 1 << 16;
				const captureRange = new vscode.Range(
					new vscode.Position(i, start),
					new vscode.Position(i, end)
				);
				builder.push(captureRange, w.token.type, w.token.modifiers);
			}

		}
		for (const capture of this.queries.injections.captures(tree, range)) {
			const langId = capture.setProperties?.["injection.language"]
			if (!langId) {
				continue
			}
			const lang = this.langs.get(langId)
			if (!lang) {
				continue
			}
			lang.tokenize(capture.node.text, new TokenBuilder(builder, capture.node.startPosition))
		}
	}
	tokenize(source: string, builder: TokenBuilder) {
		return this.tokenizeRange(source, new vscode.Range(0, 0, ~(1 << 31), ~(1 << 31)), builder)
	}
	folds(source: string, builder: FoldsBuilder) {
		const tree = this.parse(source)
		const ranges: Array<vscode.FoldingRange> = []
		if (tree == null) {
			return ranges
		}
		for (const capture of this.queries.folds.captures(tree)) {
			builder.push(capture.node.startPosition.row, capture.node.endPosition.row)
		}
		for (const capture of this.queries.injections.captures(tree)) {
			const langId = capture.setProperties?.["injection.language"]
			if (!langId) {
				continue
			}
			const lang = this.langs.get(langId)
			if (!lang) {
				continue
			}
			lang.folds(capture.node.text, new FoldsBuilder(builder, capture.node.startPosition))
		}
	}
	private source: string = ""
	private cache: Ts.Tree | null = null
	parse(source: string) {
		if (source === this.source) {
			return this.cache
		}
		this.source = source
		this.cache = this.parser.parse(this.source)
		return this.cache
	}
}


class Query {
	static async create(context: vscode.ExtensionContext, langId: string, lang: Ts.Language, kind: string): Promise<Query> {
		const queryText = await this.prepend(context, "", langId, kind);
		if (queryText.length === 0) {
			return new Query(undefined)
		}
		const query = new ts.Query(lang, queryText);
		return new Query(query)
	}
	private static async prepend(context: vscode.ExtensionContext, output: string, langId: string, kind: string): Promise<string> {
		const uri = vscode.Uri.joinPath(context.extensionUri, "query", langId, kind + ".scm");
		let queryText: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			queryText = Buffer.from(bytes).toString("utf8");
		} catch (err) {
			return output
		}
		const [rest, inherits] = this.readInherits(queryText);
		if (output.length === 0) {
			output = rest;
		} else {
			output = rest + "\n" + output;
		}
		for (const langName of inherits) {
			output = await this.prepend(context, output, langName, kind);
		}
		return output
	}
	private static readInherits(source: string): [string, Array<string>] {
		const re = /^(?:\uFEFF)?\s*;\s*inherits\s*:\s*(.+?)\s*(?:\r?\n|$)/i;
		const m = source.match(re);
		if (!m) {
			return [source, []];
		}
		const consumed = m[0].length;
		const rest = source.slice(consumed);
		const imports = m[1]
			.split(",")
			.map(s => s.trim())
			.filter(Boolean);
		return [rest, imports];
	}
	private constructor(private query: Ts.Query | undefined) { }
	captures(tree: Ts.Tree, range?: vscode.Range) {
		if (this.query === undefined) {
			return []
		}
		let options: Ts.QueryOptions | undefined = undefined
		if (range) {
			options = {
				startPosition: {
					row: range.start.line,
					column: range.start.character
				},
				endPosition: {
					row: range.end.line,
					column: range.end.character
				}
			}
		}
		return this.query.captures(tree.rootNode, options)
	}
}


class FoldsBuilder {
	private offset: Ts.Point = { row: 0, column: 0 }
	private collection: Array<vscode.FoldingRange> = []
	constructor(private parent?: FoldsBuilder, offset?: Ts.Point) {
		if (offset) {
			this.offset = offset
		}
	}
	push(start: number, end: number) {
		const startRow = start + this.offset.row
		const endRow = end + this.offset.row
		if (this.parent) {
			this.parent.push(startRow, endRow)
			return
		}
		const ran = new vscode.FoldingRange(startRow, endRow)
		this.collection.push(ran)
	}
	build() {
		if (this.parent) {
			this.parent.build()
		}
		return this.collection
	}
}

interface AnyTokenBuilder {
	push(range: vscode.Range, type: TokenType, modifiers: TokenModifier[]): void
	build(): vscode.SemanticTokens
}

class TokenBuilder {
	private offset: Ts.Point = { row: 0, column: 0 }
	constructor(private parent: AnyTokenBuilder, offset?: Ts.Point) {
		if (offset) {
			this.offset = offset
		}
	}
	push(range: vscode.Range, type: TokenType, modifiers: TokenModifier[]) {
		let startCol = range.start.character
		if (range.start.line === 0) {
			startCol += this.offset.column
		}
		let endCol = range.end.character
		if (range.end.line === 0) {
			endCol += this.offset.column
		}
		const startRow = range.start.line + this.offset.row
		const endRow = range.end.line + this.offset.row
		const newRange = new vscode.Range(startRow, startCol, endRow, endCol)
		this.parent.push(newRange, type, modifiers)
	}
	build(): vscode.SemanticTokens {
		return this.parent.build()
	}
}

/**
 * Standard semantic token types predefined by VS Code.
 * Source: VS Code Semantic Highlight Guide. :contentReference[oaicite:1]{index=1}
 */
const TOKEN_TYPES = [
	"namespace",
	"class",
	"enum",
	"interface",
	"struct",
	"typeParameter",
	"type",
	"parameter",
	"variable",
	"property",
	"enumMember",
	"decorator",
	"event",
	"function",
	"method",
	"macro",
	"label",
	"comment",
	"string",
	"keyword",
	"number",
	"regexp",
	"operator",
] as const;

/**
 * Standard semantic token modifiers predefined by VS Code.
 * Source: VS Code Semantic Highlight Guide. :contentReference[oaicite:2]{index=2}
 */
const TOKEN_MODIFIERS = [
	"declaration",
	"definition",
	"readonly",
	"static",
	"deprecated",
	"abstract",
	"async",
	"modification",
	"documentation",
	"defaultLibrary",
	"control",
	"tag",
] as const;

const LEGEND = new vscode.SemanticTokensLegend(
	[...TOKEN_TYPES],
	[...TOKEN_MODIFIERS]
);

type TokenType = (typeof TOKEN_TYPES)[number];
type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

type VsSemantic = { type: TokenType; modifiers: TokenModifier[] };

const NO_MODS: TokenModifier[] = [];

function sem(type: TokenType, modifiers: TokenModifier[] = NO_MODS): VsSemantic {
	return { type, modifiers };
}

/**
 * Convert Neovim Tree-sitter highlight capture names to VS Code standard semantic tokens.
 * Input capture WITHOUT leading "@", e.g. "variable.member". (If present, "@" is stripped.)
 * Always returns `modifiers: []` when there are none.
 */
function nvimCaptureToVsCodeSemantic(capture: string): VsSemantic | null {
	if (capture.startsWith("@")) capture = capture.slice(1);

	switch (capture) {
		// Identifiers
		case "variable": return sem("variable");
		case "variable.builtin": return sem("variable", ["defaultLibrary"]);
		case "variable.parameter": return sem("parameter");
		case "variable.parameter.builtin": return sem("parameter", ["defaultLibrary"]);
		case "variable.member": return sem("property");

		case "constant": return sem("variable", ["readonly"]);
		case "constant.builtin": return sem("variable", ["readonly", "defaultLibrary"]);
		case "constant.macro": return sem("macro");

		case "module": return sem("namespace");
		case "module.builtin": return sem("namespace", ["defaultLibrary"]);

		case "label": return sem("label");

		// Literals
		case "string": return sem("string");
		case "string.documentation": return sem("string", ["documentation"]);
		case "string.regexp": return sem("regexp");
		case "string.escape":
		case "string.special":
		case "string.special.symbol":
		case "string.special.url":
		case "string.special.path":
			return sem("string");

		case "character":
		case "character.special":
			return sem("string");

		case "boolean":
			return sem("variable", ["readonly"]);
		case "number":
		case "number.float":
			return sem("number");

		// Types / attributes / properties
		case "type": return sem("type");
		case "type.builtin": return sem("type", ["defaultLibrary"]);
		case "type.definition": return sem("type", ["declaration"]);

		// nvim @attribute ~= decorators/annotations in many languages
		case "attribute": return sem("decorator");
		case "attribute.builtin": return sem("decorator", ["defaultLibrary"]);

		case "property": return sem("property");

		// Functions
		case "function": return sem("function");
		case "function.builtin": return sem("function", ["defaultLibrary"]);
		case "function.call": return sem("function");
		case "function.macro": return sem("macro");

		case "function.method": return sem("method");
		case "function.method.call": return sem("method");

		case "constructor":
			return sem("function");

		case "operator":
			return sem("operator");

		// Keywords
		case "keyword.import":
			return sem("keyword", ["control"]);
		case "keyword.function":
		case "keyword.type":
		case "keyword": return sem("keyword");
		case "keyword.coroutine": return sem("keyword", ["async"]);
		case "keyword.repeat":
		case "keyword.return":
		case "keyword.debug":
		case "keyword.exception":
		case "keyword.conditional":
			return sem("keyword", ["control"]);

		case "keyword.conditional.ternary": return sem("operator");
		case "keyword.operator": return sem("operator");

		// VS Code standard token TYPES do not include "modifier" as a type;
		// treat modifier-keywords as keywords (or make a custom semantic type if you want).
		case "keyword.modifier": return sem("keyword");

		case "keyword.directive":
		case "keyword.directive.define":
			return sem("macro");

		// Punctuation
		case "punctuation.delimiter":
		case "punctuation.bracket":
			return sem("operator");
		case "punctuation.special":
			return sem("macro");

		// Comments
		case "comment": return sem("comment");
		case "comment.documentation": return sem("comment", ["documentation"]);
		case "comment.error": return sem("comment", ["deprecated"]);
		case "comment.warning":
		case "comment.todo":
		case "comment.note":
			return sem("comment");

		// Tags (XML-like)
		case "tag":
			return sem("variable", ["tag"]);
		case "tag.builtin": return sem("namespace", ["defaultLibrary"]);
		case "tag.attribute": return sem("property");
		case "tag.delimiter": return sem("operator");

		// Diff (optional)
		case "diff.plus":
		case "diff.minus":
		case "diff.delta":
			return sem("string");

		default:
			return null;
	}
}




