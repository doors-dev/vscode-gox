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
	vscode.languages.registerFoldingRangeProvider(goGox, langs);
}

class Langs implements
	vscode.DocumentSemanticTokensProvider,
	vscode.FoldingRangeProvider {
	private langs = new Map<string, Lang>();
	private initPromise: Promise<void>
	constructor(private ctx: vscode.ExtensionContext) {
		this.initPromise = this.init();
	}
	private async init() {
		const failed: string[] = [];
		try {
			const uri = vscode.Uri.joinPath(this.ctx.extensionUri, "wasm", "web-tree-sitter", "web-tree-sitter.wasm");
			await ts.Parser.init({
				locateFile: () => uri.fsPath,
			});
			for (const name of ["gox", "go", "html", "css", "javascript"]) {
				try {
					const lang = await Lang.create(this.ctx, this, name);
					this.langs.set(name, lang);
				} catch (err) {
					console.error("gox: failed to load tree-sitter language " + name, err);
					failed.push(name + ": " + errorText(err));
				}
			}
		} catch (err) {
			console.error("gox: failed to init tree-sitter", err);
			failed.push(errorText(err));
		}
		if (failed.length > 0) {
			void vscode.window.showErrorMessage("GoX: Tree-sitter highlighting failed to load (" + failed.join("; ") + ")");
		}
	}
	async provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): Promise<vscode.FoldingRange[] | undefined> {
		await this.initPromise;
		const lang = this.langs.get(document.languageId)
		if (!lang || token.isCancellationRequested) {
			return undefined
		}
		try {
			const builder = new FoldsBuilder()
			lang.folds(document.getText(), builder)
			return builder.build()
		} finally {
			this.sweep()
		}
	}
	async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
		await this.initPromise;
		const lang = this.langs.get(document.languageId)
		if (!lang || token.isCancellationRequested) {
			return undefined
		}
		try {
			const builder = new TokenBuilder()
			lang.tokenize(document.getText(), builder)
			return builder.build()
		} finally {
			this.sweep()
		}
	}
	private sweep() {
		for (const lang of this.langs.values()) {
			lang.sweep()
		}
	}
	get(id: string): Lang | undefined {
		return this.langs.get(id)
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isNotFound(err: unknown): boolean {
	const code = (err as { code?: unknown } | null | undefined)?.code
	return code === "FileNotFound" || code === "ENOENT"
}

type Parsed = {
	tree: Ts.Tree,
	lines: Lines,
	// parsed or reused since the last sweep
	live: boolean,
}

type Injection = {
	lang: Lang,
	text: string,
	start: Ts.Point,
}

const MAX_INJECTION_DEPTH = 8

class Lang {
	static async create(context: vscode.ExtensionContext, langs: Langs, langId: string): Promise<Lang> {
		const uri = vscode.Uri.joinPath(context.extensionUri, "wasm", langId, "tree-sitter-" + langId + ".wasm");
		const bytes = await vscode.workspace.fs.readFile(uri);
		const lang = await ts.Language.load(bytes);
		return new Lang(
			langs,
			lang,
			{
				folds: await Query.create(context, langId, lang, "folds", false),
				highlights: await Query.create(context, langId, lang, "highlights", true),
				injections: await Query.create(context, langId, lang, "injections", false),
			})
	}
	private parser: Ts.Parser
	constructor(
		private langs: Langs,
		private tsLang: Ts.Language,
		private queries: {
			folds: Query,
			highlights: Query,
			injections: Query,
		}
	) {
		this.parser = new ts.Parser()
		this.parser.setLanguage(this.tsLang)
	}
	tokenize(source: string, builder: TokenBuilder) {
		if (builder.depth > MAX_INJECTION_DEPTH) return;
		const parsed = this.parse(source);
		if (parsed === null) return;
		const captures: Array<{ node: Ts.Node, start: number, end: number, pattern: number, token: VsSemantic, priority: number }> = [];
		for (const match of this.queries.highlights.matches(parsed.tree)) {
			for (const capture of match.captures) {
				const sem = nvimCaptureToVsCodeSemantic(capture.name);
				if (!sem) {
					continue
				}
				const node = capture.node;
				captures.push({ node, start: node.startIndex, end: node.endIndex, pattern: capture.patternIndex, token: sem, priority: match.pattern.priority });
			}
		}
		// push order is paint order: outer nodes first, then later patterns
		captures.sort((a, b) => a.start - b.start || b.end - a.end || a.pattern - b.pattern);
		for (const c of captures) {
			builder.push(parsed.lines, c.node, c.token, c.priority);
		}
		for (const inj of this.injections(parsed)) {
			inj.lang.tokenize(inj.text, new TokenBuilder(builder, inj.start))
		}
	}
	folds(source: string, builder: FoldsBuilder) {
		if (builder.depth > MAX_INJECTION_DEPTH) return;
		const parsed = this.parse(source)
		if (parsed === null) return;
		for (const match of this.queries.folds.matches(parsed.tree)) {
			// a quantified capture folds from its first node to its last
			let first: Ts.Node | undefined
			let last: Ts.Node | undefined
			for (const capture of match.captures) {
				if (capture.name !== "fold") continue
				if (!first || capture.node.startIndex < first.startIndex) first = capture.node
				if (!last || capture.node.endIndex > last.endIndex) last = capture.node
			}
			if (!first || !last) continue
			const startRow = first.startPosition.row
			const end = last.endPosition
			let endRow = end.row
			// keep the line with the closing delimiter visible
			if (end.column === 0 || CLOSING.test(parsed.lines.text(endRow).slice(0, end.column))) {
				endRow--
			}
			if (endRow <= startRow) continue
			builder.push(startRow, endRow)
		}
		for (const inj of this.injections(parsed)) {
			inj.lang.folds(inj.text, new FoldsBuilder(builder, inj.start))
		}
	}
	private injections(parsed: Parsed): Injection[] {
		const result: Injection[] = []
		const seen = new Set<string>()
		for (const match of this.queries.injections.matches(parsed.tree)) {
			let langId = match.properties?.["injection.language"]
			if (!langId) {
				const capture = match.captures.find(c => c.name === "injection.language")
				if (capture) langId = match.pattern.text(capture)
			}
			if (!langId) {
				continue
			}
			const lang = this.langs.get(langId) ?? this.langs.get(langId.toLowerCase())
			if (!lang) {
				continue
			}
			for (const capture of match.captures) {
				if (capture.name !== "injection.content") continue
				const [startIndex, endIndex] = match.pattern.range(capture, parsed.lines)
				if (endIndex <= startIndex) continue
				const key = `${langId}:${startIndex}:${endIndex}`
				if (seen.has(key)) continue
				seen.add(key)
				result.push({
					lang,
					// copied: a V8 slice would keep the whole document alive while the fragment is cached
					text: Buffer.from(parsed.lines.source.slice(startIndex, endIndex), "utf16le").toString("utf16le"),
					start: parsed.lines.point(startIndex),
				})
			}
		}
		return result
	}
	private trees = new Map<string, Parsed>()
	private parse(source: string): Parsed | null {
		let parsed = this.trees.get(source)
		if (!parsed) {
			const tree = this.parser.parse(source)
			if (tree === null) return null
			parsed = { tree, lines: new Lines(source), live: true }
			this.trees.set(source, parsed)
		}
		parsed.live = true
		return parsed
	}
	// after a full document request: keep what was used since the previous sweep, free the rest
	sweep() {
		for (const [key, parsed] of this.trees) {
			if (parsed.live) {
				parsed.live = false
				continue
			}
			parsed.tree.delete()
			this.trees.delete(key)
		}
	}
}

const CLOSING = /^\s*(?:[)\]}>]|<\/|\/>)/

// rows are split on "\n" like tree-sitter does, columns and indexes are UTF-16 units
class Lines {
	private starts: number[] = [0]
	constructor(readonly source: string) {
		for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) {
			this.starts.push(i + 1)
		}
	}
	private end(row: number): number {
		return row + 1 < this.starts.length ? this.starts[row + 1] - 1 : this.source.length
	}
	// without line terminator
	length(row: number): number {
		if (row < 0 || row >= this.starts.length) return 0
		const start = this.starts[row]
		let end = this.end(row)
		if (end > start && this.source.charCodeAt(end - 1) === 13) end--
		return end - start
	}
	text(row: number): string {
		if (row < 0 || row >= this.starts.length) return ""
		return this.source.slice(this.starts[row], this.end(row))
	}
	index(point: Ts.Point): number {
		const row = Math.min(Math.max(point.row, 0), this.starts.length - 1)
		if (row !== point.row) {
			return point.row < 0 ? 0 : this.source.length
		}
		return Math.min(Math.max(this.starts[row] + point.column, this.starts[row]), this.end(row))
	}
	point(index: number): Ts.Point {
		let lo = 0
		let hi = this.starts.length - 1
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1
			if (this.starts[mid] <= index) lo = mid
			else hi = mid - 1
		}
		return { row: lo, column: index - this.starts[lo] }
	}
}

type Match = {
	captures: Ts.QueryCapture[],
	properties: Ts.QueryProperties | undefined,
	pattern: Pattern,
}

// what web-tree-sitter leaves unevaluated: unknown predicates and directives
class Pattern {
	readonly priority: number = 100
	// an unknown predicate never matches
	readonly dead: boolean
	private offsets = new Map<string, number[]>()
	private gsubs: Array<{ capture: string, re: RegExp, replacement: string }> = []
	constructor(predicates: Ts.QueryPredicate[], properties: Ts.QueryProperties | undefined) {
		const priority = parseInt(properties?.["priority"] ?? "", 10)
		if (!isNaN(priority)) {
			this.priority = priority
		}
		this.dead = predicates.some(p => p.operator.endsWith("?"))
		for (const { operator, operands } of predicates) {
			const [first, ...rest] = operands
			if (!operator.endsWith("!") || first?.type !== "capture") continue
			const args = rest.map(o => o.type === "string" ? o.value : "")
			if (operator === "offset!" && args.length === 4) {
				const offset = args.map(a => parseInt(a, 10))
				if (!offset.some(isNaN)) this.offsets.set(first.name, offset)
			} else if (operator === "gsub!" && args.length === 2) {
				// JS RegExp and replacement ($1), not Lua
				this.gsubs.push({ capture: first.name, re: new RegExp(args[0], "g"), replacement: args[1] })
			}
		}
	}
	// capture text after #gsub!, a long text is no language name: kept as is, the regexp may backtrack
	text(capture: Ts.QueryCapture): string {
		let text = capture.node.text
		if (text.length > 256) return text
		for (const gsub of this.gsubs) {
			if (gsub.capture === capture.name) text = text.replace(gsub.re, gsub.replacement)
		}
		return text
	}
	// capture [startIndex, endIndex] after #offset!
	range(capture: Ts.QueryCapture, lines: Lines): [number, number] {
		const node = capture.node
		const offset = this.offsets.get(capture.name)
		if (!offset) {
			return [node.startIndex, node.endIndex]
		}
		const start = node.startPosition
		const end = node.endPosition
		return [
			lines.index({ row: start.row + offset[0], column: start.column + offset[1] }),
			lines.index({ row: end.row + offset[2], column: end.column + offset[3] }),
		]
	}
}


class Query {
	static async create(context: vscode.ExtensionContext, langId: string, lang: Ts.Language, kind: string, required: boolean): Promise<Query> {
		const queryText = await this.prepend(context, "", langId, kind, required);
		if (queryText.length === 0) {
			return new Query(undefined)
		}
		let query: Ts.Query;
		try {
			query = new ts.Query(lang, queryText);
		} catch (err) {
			throw new Error(kind + " query: " + errorText(err))
		}
		// a query (re)synced from nvim-treesitter may bring #lua-match? and the like back
		const dead = query.predicates.flatMap((ps, i) => ps.filter(p => p.operator.endsWith("?")).map(p => `pattern ${i} #${p.operator}`))
		if (dead.length > 0) console.warn("gox: tree-sitter query " + langId + " " + kind + " has patterns that never match: " + dead.join(", "))
		return new Query(query)
	}
	// only a file that doesn't exist is skipped: inherited parents (jsx) and query kinds are optional
	private static async prepend(context: vscode.ExtensionContext, output: string, langId: string, kind: string, required: boolean): Promise<string> {
		const uri = vscode.Uri.joinPath(context.extensionUri, "queries", langId, kind + ".scm");
		let queryText: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			queryText = Buffer.from(bytes).toString("utf8");
		} catch (err) {
			if (required || !isNotFound(err)) {
				throw new Error("can't read queries/" + langId + "/" + kind + ".scm: " + errorText(err))
			}
			return output
		}
		const [rest, inherits] = this.readInherits(queryText);
		if (output.length === 0) {
			output = rest;
		} else {
			output = rest + "\n" + output;
		}
		for (const langName of inherits) {
			output = await this.prepend(context, output, langName, kind, false);
		}
		return output
	}
	private static readInherits(source: string): [string, Array<string>] {
		const re = /^(?:﻿)?\s*;\s*inherits\s*:\s*(.+?)\s*(?:\r?\n|$)/i;
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
	private patterns: Pattern[] = []
	private constructor(private query: Ts.Query | undefined) {
		if (query === undefined) {
			return
		}
		for (let i = 0; i < query.predicates.length; i++) {
			this.patterns.push(new Pattern(query.predicates[i], query.setProperties[i]))
		}
	}
	// matches are needed over captures: predicates reference sibling captures
	matches(tree: Ts.Tree): Match[] {
		if (this.query === undefined) {
			return []
		}
		const result: Match[] = []
		for (const match of this.query.matches(tree.rootNode)) {
			const pattern = this.patterns[match.patternIndex]
			if (pattern.dead) {
				continue
			}
			result.push({ captures: match.captures, properties: match.setProperties, pattern })
		}
		return result
	}
}


class FoldsBuilder {
	private offset: Ts.Point = { row: 0, column: 0 }
	private collection: Array<vscode.FoldingRange> = []
	readonly depth: number = 0
	constructor(private parent?: FoldsBuilder, offset?: Ts.Point) {
		if (offset) {
			this.offset = offset
		}
		if (parent) {
			this.depth = parent.depth + 1
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

// single line piece of a capture
type Span = {
	row: number,
	start: number,
	end: number,
	token: VsSemantic,
	priority: number,
	depth: number,
	seq: number,
}

class TokenBuilder {
	private offset: Ts.Point = { row: 0, column: 0 }
	private spans: Span[] = []
	readonly depth: number = 0
	// child builder positions are relative to the offset in the parent
	constructor(private parent?: TokenBuilder, offset?: Ts.Point) {
		if (offset) {
			this.offset = offset
		}
		if (parent) {
			this.depth = parent.depth + 1
		}
	}
	push(lines: Lines, node: Ts.Node, token: VsSemantic, priority: number) {
		const start = node.startPosition
		const end = node.endPosition
		for (let row = start.row; row <= end.row; row++) {
			const startCol = row === start.row ? start.column : 0
			const endCol = row === end.row ? Math.min(end.column, lines.length(row)) : lines.length(row)
			if (endCol <= startCol) continue
			this.add(row, startCol, endCol, token, priority, this.depth)
		}
	}
	private add(row: number, start: number, end: number, token: VsSemantic, priority: number, depth: number) {
		// only the first line of the fragment is shifted by column
		if (row === 0) {
			start += this.offset.column
			end += this.offset.column
		}
		row += this.offset.row
		if (this.parent) {
			this.parent.add(row, start, end, token, priority, depth)
			return
		}
		this.spans.push({ row, start, end, token, priority, depth, seq: this.spans.length })
	}
	build(): vscode.SemanticTokens {
		const builder = new vscode.SemanticTokensBuilder(LEGEND)
		for (const span of flattenSpans(this.spans)) {
			const range = new vscode.Range(span.row, span.start, span.row, span.end)
			builder.push(range, span.token.type, span.token.modifiers)
		}
		return builder.build()
	}
}

// painter's algorithm per row: spans are painted lowest rank first, a column belongs to the last one painted over it.
// rank is priority, then injection depth, then push order. Output is sorted and non-overlapping.
function flattenSpans(spans: Span[]): Span[] {
	const sorted = spans.slice().sort((a, b) => a.row - b.row || a.priority - b.priority || a.depth - b.depth || a.seq - b.seq)
	const result: Span[] = []
	for (let i = 0; i < sorted.length;) {
		const row = sorted[i].row
		const cols: Array<Span | undefined> = []
		for (; i < sorted.length && sorted[i].row === row; i++) {
			const s = sorted[i]
			for (let c = s.start; c < s.end; c++) cols[c] = s
		}
		for (let start = 0, end = 1; start < cols.length; start = end++) {
			const top = cols[start]
			while (end < cols.length && cols[end] === top) end++
			if (top) result.push({ ...top, start, end })
		}
	}
	return result
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




