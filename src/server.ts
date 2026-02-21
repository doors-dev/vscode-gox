import * as vscode from 'vscode';

import versions from "./versions";

export default {
	activate,
	deactivate,
}

import {
	LanguageClient,
	LanguageClientOptions,
	InitializeParams,
	ServerOptions,
} from "vscode-languageclient/node";

import Tool from "./tool";

let client: LanguageClient | undefined;
let active = false;

function activate(ctx: vscode.ExtensionContext) {
	active = true;
	const disposable = vscode.commands.registerCommand("gox.start", start(ctx));
	ctx.subscriptions.push(disposable);
	vscode.commands.executeCommand("gox.start")
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
				if (client) {
					client.stop();
					client = undefined;
				}
				try {
					await health(ctx, progress)
				} catch (err: any) {
					vscode.window.showErrorMessage(err.message);
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
			'GoX language features are disabled. Run "gox.start" command to perform a healthcheck.',
		);
		return
	}
	const ok = promptDisableGopls(ctx)
	if (!ok) {
		void vscode.window.showWarningMessage(
			'GoX language features are disabled. Run "gox.start" command to perform a healthcheck.',
		);
		return
	}
	client = new GoxLanguageClient(goplsPath, goxPath);
	if (!active) {
		client = undefined;
		progress.report({ message: 'start canceled' });
		return;
	}
	progress.report({ message: 'starting' });
	await client.start();
	ctx.subscriptions.push(client);

}

async function promptDisableGopls(ctx: vscode.ExtensionContext): Promise<boolean> {
	const goExt = vscode.extensions.getExtension("golang.go");
	if (!goExt) {
		return true
	}
	const enabled = vscode.workspace.getConfiguration("go").get("useLanguageServer", true);
	if (!enabled) {
		return true
	}
	const choice = await vscode.window.showWarningMessage(
		"GoX enables .gox support by proxying gopls, so the Go extension language server must be disabled. Disable it now?",
		{
			modal: true,
			detail:
				"This updates your user settings (applies to all workspaces). You can re-enable it at any time.",
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
	return true;
}


function deactivate() {
	active = false;
	if (client) {
		client.stop();
		client = undefined;
	}
}

class GoxLanguageClient extends LanguageClient {
	constructor(gopls: string, gox: string) {
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
		console.log("serverOptions", serverOptions)
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ language: "gox" }, { language: "go" }],
		};
		super(
			"gox",
			"GoX Language Server",
			serverOptions,
			clientOptions
		);
	}
	protected fillInitializeParams(params: InitializeParams): void {
		super.fillInitializeParams(params);
		params.clientInfo!.name += " [GOX_EXT]"
	}
}


class Gopls extends Tool {
	protected name = "gopls"
	protected async install(progress: any) {
		const binDir = await this.installDir();
		const path = await this.executablePath();
		await this.run("go", ["install", "golang.org/x/tools/gopls@" + this.version], { GOBIN: binDir });
		console.log("installed", path)
	}
}

class Gox extends Tool {
	protected name = "gox"
	protected async install(progress: any) {
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
		const file = await this.download(
			`https://github.com/doors-dev/gox/releases/download/${this.version}/${fileName}`,
			fileName
		);
		await this.extract(file, await this.installDir());
		await this.makeExecutable(await this.executablePath());
		await this.cleanTempDir();
	}
}

