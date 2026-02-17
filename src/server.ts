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
	let activationInProgress = false;
	return async () => {
		const ok = await promptDisableGopls(ctx);
		if (!ok) {
			return;
		}
		if (activationInProgress) {
			vscode.window.showWarningMessage("Already starting. Please wait.");
			return;
		}
		activationInProgress = true;
		if (client) {
			client.stop();
			client = undefined;
		}
		let gopls: string, gox: string;
		try {
			[gopls, gox] = await initalize(ctx);
		} catch (err: any) {
			vscode.window.showErrorMessage(err.message);
			return;
		}
		client = new GoxLanguageClient(gopls, gox);
		activationInProgress = false;
		if (!active) {
			client = undefined;
			return;
		}
		client.start();
		ctx.subscriptions.push(client);
	}
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

async function initalize(ctx: vscode.ExtensionContext): Promise<[string, string]> {
	const gopls = new Gopls(ctx, versions.GOPLS);
	const gox = new Gox(ctx, versions.GOX);
	return [await gopls.ensure(), await gox.ensure()];
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
		const serverOptions: ServerOptions = {
			command: gox,
			args: ["srv", "-gopls", gopls],
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
	protected async install() {
		const binDir = await this.installDir();
		const path = await this.executablePath();
		await this.run("go", ["install", "golang.org/x/tools/gopls@" + this.version], { GOBIN: binDir });
		console.log("installed", path)
	}
}

class Gox extends Tool {
	protected name = "gox"
	protected async install() {
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

