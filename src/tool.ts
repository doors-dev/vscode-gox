import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import * as syncFs from 'fs';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import * as tar from 'tar'
import extractZip from "extract-zip";
import { chmod, stat } from "node:fs/promises";
import * as vscode from 'vscode';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_VERSION_MS = 7 * 24 * 60 * 60 * 1000;

export default abstract class Tool {
	protected abstract name: string;
	constructor(protected ctx: vscode.ExtensionContext, readonly version: string) { }
	private msg(message: string) {
		return `[${this.name}] ${message}`;
	}
	public async resolvePath(): Promise<string> {
		const alternative = vscode.workspace.getConfiguration("gox").get<string | undefined>("bin." + this.name, undefined);
		if (alternative && alternative != "") {
			return this.configuredPath(alternative);
		}
		if (await this.check()) {
			// marks the version as in use, see cleanOld
			const now = new Date();
			await fs.utimes(await this.installDir(), now, now).catch(() => undefined);
			return this.executablePath();
		}
		return ""
	}
	private async configuredPath(value: string): Promise<string> {
		const p = value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(1)) : value;
		// command names and relative paths are left to spawn
		if (!path.isAbsolute(p)) {
			return p;
		}
		try {
			await fs.access(p, syncFs.constants.X_OK);
		} catch (err) {
			throw new Error(`GoX: setting gox.bin.${this.name} is "${value}", but ${p} is missing or not executable. Fix or clear the setting.`);
		}
		return p;
	}
	public async ensure(progress: any): Promise<string> {
		const resolved = await this.resolvePath()
		if (resolved != "") {
			return resolved;
		}
		/*
		await vscode.window.showInformationMessage(
			this.msg("installing " + this.version),
		); */
		// install into a directory of our own next to the versions, then move it into place:
		// other windows share the storage and may run the same install. cleanOld removes what an interrupted install left
		const toolRoot = path.dirname(await this.installDir());
		await fs.mkdir(toolRoot, { recursive: true });
		const temp = this.tempDir = await fs.mkdtemp(path.join(toolRoot, "tmp-"));
		try {
			const stage = path.join(temp, "stage");
			await fs.mkdir(stage);
			try {
				progress.report({ message: 'Installing ' + this.name + ' ' + this.version });
				await this.install(progress, stage);
			} catch (err) {
				const message = (err as any)?.message ?? "unknown";
				throw new Error(this.msg("installation failed: " + message), { cause: err });
			}
			const hash = await this.calcHash(this.binaryPath(stage));
			if (hash === undefined) {
				throw new Error(this.msg("binary not found after installation"));
			}
			await fs.writeFile(path.join(stage, "sha256.txt"), hash, "utf8");
			await this.moveIntoPlace(stage);
		} finally {
			this.tempDir = undefined;
			await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
		}
		await this.cleanOld();
		/*
		await vscode.window.showInformationMessage(
			this.msg("installed successfully"),
		); */
		progress.report({ message: 'Successfuly installed ' + this.name + ' ' + this.version + ' to ' + await this.installDir() });
		return await this.executablePath();
	}
	private async moveIntoPlace(stage: string): Promise<void> {
		const installDir = await this.installDir();
		await fs.mkdir(path.dirname(installDir), { recursive: true });
		try {
			await fs.rename(stage, installDir);
			return
		} catch (err) {
			// install dir exists: another window got there first, or a broken leftover
		}
		if (await this.check()) {
			return
		}
		try {
			await fs.rm(installDir, { recursive: true, force: true });
			await fs.rename(stage, installDir);
		} catch (err) {
			if (await this.check()) {
				return
			}
			const message = (err as any)?.message ?? "unknown";
			throw new Error(this.msg("installation failed: " + message), { cause: err });
		}
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
				// another window may still run a recent version (missed if it has been open for longer than this)
				if (Date.now() - (await stat(p)).mtimeMs > STALE_VERSION_MS) {
					await fs.rm(p, { recursive: true, force: true });
				}
			} catch (err) {
				continue
			}
		}
	}
	// set while ensure() installs
	private tempDir: string | undefined;
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
	protected binaryPath(dir: string): string {
		return path.join(dir, this.name + this.suffix());
	}
	protected async executablePath(): Promise<string> {
		return this.binaryPath(await this.installDir());
	}
	private async hashPath(): Promise<string> {
		return path.join(await this.installDir(), "sha256.txt");
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
	protected async calcHash(file?: string): Promise<string | undefined> {
		const path = file ?? await this.executablePath();
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
	protected run(cmd: string, args: string[], envExt: NodeJS.ProcessEnv = {}, timeoutMs = RUN_TIMEOUT_MS): Promise<void> {
		return new Promise((resolve, reject) => {
			const env = { ...process.env, ...envExt };
			const p = spawn(cmd, args, {
				env,
				shell: process.platform === "win32",
				stdio: "pipe",
			});
			let stderr = "";
			const timer = setTimeout(() => {
				p.kill("SIGKILL");
				reject(new Error(`${cmd} ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s: ${stderr}`));
			}, timeoutMs);
			p.stderr.on("data", (d) => (stderr += String(d)));
			p.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			p.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`${cmd} ${args.join(" ")} failed (code ${code}): ${stderr}`));
			});
		});
	}
	private reason(err: unknown): string {
		const message = (err as any)?.message ?? String(err);
		const cause = (err as any)?.cause?.message;
		return cause ? `${message} (${cause})` : message;
	}
	protected async download(url: string, filename: string): Promise<string> {
		const destPath = path.join(this.tempDir!, filename);
		const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				headers: {
					"Accept": "application/octet-stream",
				},
				redirect: "follow",
				signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			await pipeline(res.body!, syncFs.createWriteStream(destPath), { signal });
		} catch (err) {
			throw new Error(`download of ${url} failed: ${this.reason(err)}`, { cause: err });
		}
		return destPath;
	}
	// checks the file against the "<sha256>  <name>" list published at sumsUrl
	protected async verifyChecksum(filePath: string, sumsUrl: string) {
		const name = path.basename(filePath);
		const sums = await fs.readFile(await this.download(sumsUrl, name + ".sums"), "utf8");
		let expected: string | undefined;
		for (const line of sums.split(/\r?\n/)) {
			const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
			if (m && m[2] === name) {
				expected = m[1].toLowerCase();
				break
			}
		}
		if (expected === undefined) {
			throw new Error(`no checksum for ${name} in ${sumsUrl}`);
		}
		const actual = await this.calcHash(filePath);
		if (actual !== expected) {
			throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
		}
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
			throw new Error(`extraction of ${path.basename(archivePath)} failed: ${this.reason(err)}`, { cause: err });
		}
		throw new Error(`extraction failed: unsupported archive type ${path.basename(archivePath)}`);
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
	protected abstract install(progress: any, dir: string): Promise<void>;

}
