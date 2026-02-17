const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs/promises");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd(async (result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});

			if (result.errors.length !== 0) {
				return
			}
			try {
				await copyWasm()
				await copyQuery()
				console.log("[watch] assets copied")
			} catch (e) {
				console.error("✘ [ERROR] asset copy failed", e)
			}
		});
	},
}

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});


async function copyQuery() {
	const srcDir = path.join(__dirname, "query");
	const dstDir = path.join(__dirname, "dist", "query");
	await fs.mkdir(dstDir, { recursive: true });
	await fs.cp(srcDir, dstDir, {
		recursive: true,
		filter: (src) => path.resolve(src) !== path.resolve(srcDir, "LICENSE"),
	});
}

async function copyWasm() {
  const srcRoot = path.resolve("./wasm");
  const dstRoot = path.resolve("./dist/wasm");
  await fs.mkdir(dstRoot, { recursive: true });
  const entries = await fs.readdir(srcRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const subSrcDir = path.join(srcRoot, ent.name);
    const subDstDir = path.join(dstRoot, ent.name);
    const files = await fs.readdir(subSrcDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".wasm")) continue;
      await fs.mkdir(subDstDir, { recursive: true });
      const srcFile = path.join(subSrcDir, f.name);
      const dstFile = path.join(subDstDir, f.name); 
      await fs.copyFile(srcFile, dstFile);
    }
  }
}
