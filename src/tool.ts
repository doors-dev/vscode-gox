import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import * as syncFs from 'fs';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import * as tar from 'tar'
import extractZip from "extract-zip";
import { chmod, stat } from "node:fs/promises";
import * as vscode from 'vscode';

export default abstract class Tool {
	protected abstract name: string;
	constructor(protected ctx: vscode.ExtensionContext, readonly version: string) { }
	private msg(message: string) {
		return `[${this.name}] ${message}`;
	}
	public async resolvePath(): Promise<string> {
		const alternative = vscode.workspace.getConfiguration("gox").get<string | undefined>("bin." + this.name, undefined);
		if (alternative && alternative != "") {
			return alternative;
		}
		if (await this.check()) {
			return this.executablePath();
		}
		return ""
	}
	public async ensure(progress: any): Promise<string> {
		const path = await this.resolvePath()
		if (path != "") {
			return path;
		}
		/*
		await vscode.window.showInformationMessage(
			this.msg("installing " + this.version),
		); */
		await this.clearInstallDir();
		await this.ensureInstallDir();
		try {
			progress.report({ message: 'Installing ' + this.name + ' ' + this.version });
			await this.install(progress);
		} catch (err) {
			const message = (err as any)?.message ?? "unknown";
			throw new Error(this.msg("installation failed: " + message));
		}
		const hash = await this.calcHash();
		if (hash === undefined) {
			throw new Error(this.msg("binary not found after installation"));
		}
		await this.writeHash(hash);
		await this.cleanOld();
		/*
		await vscode.window.showInformationMessage(
			this.msg("installed successfully"),
		); */
		progress.report({ message: 'Successfuly installed ' + this.name + ' ' + this.version + ' to ' + await this.installDir() });
		return await this.executablePath();
	}
	private async cleanOld(): Promise<void> {
		const toolRoot = path.join(await this.binDir(), this.name);
		if (!await this.exists(toolRoot)) {
			return
		}
		let entries: string[] = [];
		try {
			entries = await fs.readdir(toolRoot);
		} catch (err) {
			return
		}
		const currentDir = path.resolve(path.join(toolRoot, this.version));
		for (const entry of entries) {
			const p = path.join(toolRoot, entry);
			if (path.resolve(p) === currentDir) {
				continue
			}
			try {
				await fs.rm(p, { recursive: true, force: true });
			} catch (err) {
				continue
			}
		}
	}
	private _tempDir: string | undefined;
	private async tempDir(): Promise<string> {
		if (this._tempDir == undefined) {
			this._tempDir = path.join(this.ctx.globalStorageUri.fsPath, "tmp");
			await fs.mkdir(this._tempDir, { recursive: true });
		}
		return this._tempDir;
	}
	public async cleanTempDir() {
		if (await this.exists(await this.tempDir())) {
			await fs.rm(await this.tempDir(), { recursive: true, force: true });
		}
	}
	private _binDir: string | undefined;
	private async binDir(): Promise<string> {
		if (this._binDir == undefined) {
			this._binDir = path.join(this.ctx.globalStorageUri.fsPath, "bin");
			await fs.mkdir(this._binDir, { recursive: true });
		}
		return this._binDir;
	}
	protected async installDir(): Promise<string> {
		return path.join(await this.binDir(), this.name, this.version);
	}
	private async ensureInstallDir(): Promise<void> {
		const installDir = await this.installDir();
		if (await this.exists(installDir)) {
			return
		}
		await fs.mkdir(installDir, { recursive: true });
	}
	protected async executablePath(): Promise<string> {
		return path.join(await this.installDir(), this.name + this.suffix());
	}
	private async hashPath(): Promise<string> {
		return path.join(await this.installDir(), "sha256.txt");
	}
	private async clearInstallDir() {
		if (await this.exists(await this.installDir())) {
			await fs.rm(await this.installDir(), { recursive: true, force: true });
		}
	}
	protected async check(): Promise<boolean> {
		const hash = await this.readHash();
		if (hash == undefined) {
			return false
		}
		const actualHash = await this.calcHash();
		if (actualHash === undefined) {
			return false
		}
		return actualHash === hash;
	}
	private async readHash(): Promise<string | undefined> {
		const path = await this.hashPath();
		try {
			return await fs.readFile(path, "utf8")
		} catch (err) {
			return undefined;
		}
	}
	private async writeHash(hash: string): Promise<void> {
		const path = await this.hashPath();
		await fs.writeFile(path, hash, "utf8");
	}
	protected async calcHash(): Promise<string | undefined> {
		const path = await this.executablePath();
		return await new Promise((res) => {
			const hash = crypto.createHash("sha256");
			const stream = syncFs.createReadStream(path);
			stream.on("error", () => res(undefined));
			stream.on("data", (chunk) => hash.update(chunk));
			stream.on("end", () => res(hash.digest("hex")));
		});
	}
	protected suffix(): string {
		return process.platform === "win32" ? ".exe" : "";
	}
	protected run(cmd: string, args: string[], envExt: NodeJS.ProcessEnv = {}): Promise<void> {
		return new Promise((resolve, reject) => {
			const env = { ...process.env, ...envExt };
			const p = spawn(cmd, args, {
				env,
				shell: process.platform === "win32",
				stdio: "pipe",
			});
			let stderr = "";
			p.stderr.on("data", (d) => (stderr += String(d)));
			p.on("error", reject);
			p.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`${cmd} ${args.join(" ")} failed (code ${code}): ${stderr}`));
			});
		});
	}
	protected async download(url: string, filename: string): Promise<string> {
		const destPath = path.join(await this.tempDir(), filename);
		try {
			const res = await fetch(url, {
				headers: {
					"Accept": "application/octet-stream",
				},
				redirect: "follow",
			});
			if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
			await pipeline(res.body!, syncFs.createWriteStream(destPath));
		} catch (err) {
			throw new Error("download failed");
		}
		return destPath;
	}
	protected async extract(archivePath: string, outDir: string) {
		try {
			if (archivePath.endsWith(".tar.gz")) {
				await tar.x({ file: archivePath, cwd: outDir });
				return;
			}
			if (archivePath.endsWith(".zip")) {
				await extractZip(archivePath, { dir: outDir });
				return;
			}
		}
		catch (err) {
			throw new Error("extraction failed");
		}
	}
	private async exists(p: string): Promise<boolean> {
		try { await fs.access(p); return true; }
		catch { return false; }
	}
	protected async makeExecutable(filePath: string) {
		if (process.platform === "win32") return;
		const mode = (await stat(filePath)).mode;
		await chmod(filePath, mode | 0o111);
	}
	protected abstract install(progress: any): Promise<void>;

}
