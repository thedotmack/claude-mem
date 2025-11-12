/**
 * Extension tests
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('thedotmack.claude-mem-vscode'));
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension('thedotmack.claude-mem-vscode');
    await ext?.activate();
    assert.ok(ext?.isActive);
  });

  test('Commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('claudeMem.checkWorkerHealth'));
    assert.ok(commands.includes('claudeMem.restartWorker'));
    assert.ok(commands.includes('claudeMem.openViewer'));
    assert.ok(commands.includes('claudeMem.openSettings'));
  });
});
