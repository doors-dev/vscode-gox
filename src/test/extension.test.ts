import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

// Compiled to out/test, so the manifest is two levels up.
const manifest = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
);
const extensionId = `${manifest.publisher}.${manifest.name}`;

suite('Extension Test Suite', () => {
	test('extension is present', () => {
		assert.ok(vscode.extensions.getExtension(extensionId), `${extensionId} not found`);
	});

	// No go/gox document is opened here: activation starts a health check
	// that may show modal prompts, which would block the test host.
	test('extension activates', async () => {
		const ext = vscode.extensions.getExtension(extensionId);
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('gox language is registered', async () => {
		const langs = await vscode.languages.getLanguages();
		assert.ok(langs.includes('gox'));
	});

	test('gox.start command is registered', async () => {
		const ext = vscode.extensions.getExtension(extensionId);
		assert.ok(ext);
		await ext.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('gox.start'));
	});

	test('language configuration is valid JSON', () => {
		const file = path.resolve(__dirname, '..', '..', 'language', 'gox.language-configuration.json');
		const config = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.strictEqual(typeof config.comments.lineComment, 'string');
		assert.strictEqual(config.comments.blockComment.length, 2);
	});
});
