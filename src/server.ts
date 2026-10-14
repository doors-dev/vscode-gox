import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';

import versions from "./versions";

export default {
	activate,
	deactivate,
}

import {
	CloseAction,
	ErrorHandler,
	LanguageClient,
	LanguageClientOptions,
	MessageTransports,
	InitializeParams,
	ServerOptions,
} from "vscode-languageclient/node";

import Tool from "./tool";

const START_TIMEOUT_MS = 60 * 1000;

let client: GoxLanguageClient | undefined;
let output: vscode.OutputChannel | undefined;
let active = false;

function activate(ctx: vscode.ExtensionContext) {
	active = true;
	// one channel for every client, so a client that failed to start leaves none behind
	output = vscode.window.createOutputChannel("GoX Language Server");
	const run = start(ctx);
	ctx.subscriptions.push(
		output,
		vscode.commands.registerCommand("gox.start", run),
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (!e.affectsConfiguration("gox.bin") && !e.affectsConfiguration("gox.log")) {
				return;
			}
			const choice = await vscode.window.showInformationMessage("GoX settings changed. Restart the language server?", "Restart");
			if (choice === "Restart") {
				void run();
			}
		}),
	);
	void run();
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		p.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

// stops the client whatever state it is in
async function stopClient(): Promise<void> {
	const c = client;
	if (!c) {
		return;
	}
	client = undefined;
	c.abandoned = true;
	try {
		await c.stop();
	} catch (err) {
		// stop() only shuts down a running server
		c.kill();
	}
	c.diagnostics?.dispose();
}

function start(ctx: vscode.ExtensionContext) {
	let inProgress = false;
	return async () => {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: 'Gox Initialization',
			},
			async (progress) => {
				if (inProgress) {
					vscode.window.showWarningMessage("Already starting. Please wait.");
					return;
				}
				inProgress = true;
				try {
					await stopClient();
					if (!active) {
						return;
					}
					await health(ctx, progress)
				} catch (err: any) {
					vscode.window.showErrorMessage(err?.message ?? String(err));
				} finally {
					inProgress = false
				}
			}
		);
	}
}

async function health(ctx: vscode.ExtensionContext, progress: any) {
	const gopls = new Gopls(ctx, versions.GOPLS);
	progress.report({ message: 'Checking gopls...' });
	let goplsPath = await gopls.resolvePath()
	if (goplsPath == "") {
		const choice = await vscode.window.showWarningMessage(
			"GoX: Go language server " +
			versions.GOPLS +
			" not found. Install it into the GoX directory now?",
			{
				modal: true,
				detail: "Alternatively you can configure gox.bin.gopls",
			},
			"Install",
		);
		if (choice !== "Install") {
			void vscode.window.showWarningMessage(
				"GoX: gopls is required. Configure gox.bin.gopls to use your gopls, or rerun the health check to install it into the GoX directory.",
			);
		} else {
			goplsPath = await gopls.ensure(progress)
		}
	}
	const gox = new Gox(ctx, versions.GOX);
	progress.report({ message: 'Checking gox...' });
	let goxPath = await gox.resolvePath()
	if (goxPath == "") {
		const choice = await vscode.window.showWarningMessage(
			"GoX: GoX language server " +
			versions.GOX +
			" not found. Install it into the GoX directory now?",
			{
				modal: true,
				detail: "Alternatively you can configure gox.bin.gox",
			},
			"Install",
		);
		if (choice !== "Install") {
			void vscode.window.showWarningMessage(
				"GoX: gox is required. Configure bin.gox to use your gox binary, or rerun the health check to install it into the GoX directory.",

			);
		} else {
			goxPath = await gox.ensure(progress)
		}
	}
	progress.report({ message: '...' });
	if (goxPath == "" || goplsPath == "") {
		void vscode.window.showWarningMessage(
			'GoX language features are disabled. Run the "GoX: Start" command to perform a healthcheck.',
		);
		return
	}
	const ok = await promptDisableGopls()
	if (!ok) {
		return
	}
	if (!active || !output) {
		progress.report({ message: 'start canceled' });
		return;
	}
	const c = new GoxLanguageClient(goplsPath, goxPath, output);
	client = c;
	progress.report({ message: 'starting' });
	try {
		await withTimeout(
			c.start(),
			START_TIMEOUT_MS,
			`GoX language server did not start within ${START_TIMEOUT_MS / 1000} seconds. Check gox.bin.gox and gox.bin.gopls, then run the "GoX: Start" command.`,
		);
	} catch (err) {
		await stopClient();
		throw err;
	}
	c.started = true;
}

async function promptDisableGopls(): Promise<boolean> {
	const goExt = vscode.extensions.getExtension("golang.go");
	if (!goExt) {
		return true
	}
	const enabled = () => vscode.workspace.getConfiguration("go").get("useLanguageServer", true);
	if (!enabled()) {
		return true
	}
	const choice = await vscode.window.showWarningMessage(
		"GoX enables .gox support by proxying gopls, so the Go extension language server must be disabled. Disable it now?",
		{
			modal: true,
			detail: "This updates your user settings (applies to all workspaces). You can re-enable it at any time.",
		},
		"Yes, disable",
	);
	if (choice !== "Yes, disable") {
		void vscode.window.showWarningMessage(
			"GoX language features are disabled. .gox support requires disabling the Go extension language server.",
		);
		return false;
	}
	await vscode.workspace.getConfiguration("go").update("useLanguageServer", false, true);
	// a workspace setting wins over the user one
	if (enabled()) {
		void vscode.window.showWarningMessage(
			'GoX language features are disabled: "go.useLanguageServer" is enabled in this workspace\'s .vscode/settings.json. Set it to false there and run the "GoX: Start" command.',
		);
		return false;
	}
	return true;
}

function deactivate(): Promise<void> {
	active = false;
	output = undefined;
	return stopClient();
}

class GoxLanguageClient extends LanguageClient {
	// the library restarts the server only between these two: after a start succeeded, until the client is dropped
	public started = false;
	public abandoned = false;
	constructor(gopls: string, gox: string, outputChannel: vscode.OutputChannel) {
		let args = ["srv", "-gopls", gopls]
		const logFile = vscode.workspace.getConfiguration("gox").get<string>("log.file");
		if (logFile && logFile !== "") {
			const logLevel = vscode.workspace.getConfiguration("gox").get<string>("log.level", "info");
			args = [...args, "-log", logFile, "-log.level", logLevel]
		}
		const serverOptions: ServerOptions = {
			command: gox,
			args,
		};
		let self: GoxLanguageClient | undefined;
		let fallback: ErrorHandler | undefined;
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: "file", language: "gox" }, { scheme: "file", language: "go" }],
			outputChannel,
			errorHandler: {
				error: (error, message, count) => fallback!.error(error, message, count),
				closed: () => self!.started && !self!.abandoned
					? fallback!.closed()
					: { action: CloseAction.DoNotRestart, handled: true },
			},
		};
		super(
			"gox",
			"GoX Language Server",
			serverOptions,
			clientOptions
		);
		self = this;
		fallback = this.createDefaultErrorHandler();
	}
	private proc: ChildProcess | undefined;
	protected async createMessageTransports(encoding: string): Promise<MessageTransports> {
		const transports = await super.createMessageTransports(encoding);
		// the client forgets the process when a start fails
		this.proc = (this as any)._serverProcess;
		if (this.abandoned) {
			// dropped while a restart was spawning
			this.kill();
			throw new Error("GoX language client was stopped");
		}
		return transports;
	}
	public error(message: string, data?: any, showNotification: boolean | "force" = true) {
		// a dropped client still logs, but no longer notifies
		super.error(message, data, this.abandoned ? false : showNotification);
	}
	public kill() {
		const proc = this.proc;
		if (proc && proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGKILL");
		}
	}
	protected fillInitializeParams(params: InitializeParams): void {
		super.fillInitializeParams(params);
		params.clientInfo!.name += " [GOX_EXT]"
	}
}

class Gopls extends Tool {
	protected name = "gopls"
	protected async install(progress: any, dir: string) {
		await this.run("go", ["install", "golang.org/x/tools/gopls@" + this.version], { GOBIN: dir });
	}
}

class Gox extends Tool {
	protected name = "gox"
	protected async install(progress: any, dir: string) {
		const os = process.platform === "win32" ? "windows" :
			process.platform === "darwin" ? "darwin" :
				process.platform === "linux" ? "linux" :
					null;
		const cpu =
			process.arch === "x64" ? "amd64" :
				process.arch === "arm64" ? "arm64" :
					null;
		if (os === null || cpu === null) {
			throw new Error(
				"No binaries available for your platform and arch : " + process.platform + " " + process.arch +
				" Please isntall GoX language server by following the isntructions in the README."
			)
		}
		const ext = os === "windows" ? ".zip" : ".tar.gz";
		const fileName = `gox_${os}_${cpu}${ext}`;
		const release = `https://github.com/doors-dev/gox/releases/download/${this.version}/`;
		const file = await this.download(release + fileName, fileName);
		await this.verifyChecksum(file, release + "SHA256SUMS");
		await this.extract(file, dir);
		await this.makeExecutable(this.binaryPath(dir));
	}
}

