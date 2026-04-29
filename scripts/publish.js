#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import readline from 'readline';

const execAsync = promisify(exec);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function publish() {
  try {
    console.log('📦 Claude-mem Marketplace Release Tool\n');

    console.log('🔍 Checking git status...');
    const { stdout: gitStatus } = await execAsync('git status --porcelain');
    if (gitStatus.trim()) {
      console.log('⚠️  Uncommitted changes detected:');
      console.log(gitStatus);
      const proceed = await question('\nContinue anyway? (y/N) ');
      if (proceed.toLowerCase() !== 'y') {
        console.log('Aborted.');
        rl.close();
        process.exit(0);
      }
    } else {
      console.log('✓ Working directory clean');
    }

    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const currentVersion = packageJson.version;
    console.log(`\n📌 Current version: ${currentVersion}`);

    console.log('\nVersion bump type:');
    console.log('  1. patch (x.x.X) - Bug fixes');
    console.log('  2. minor (x.X.0) - New features');
    console.log('  3. major (X.0.0) - Breaking changes');
    console.log('  4. custom - Enter version manually');

    const bumpType = await question('\nSelect bump type (1-4): ');
    let newVersion;

    switch (bumpType.trim()) {
      case '1':
        newVersion = bumpVersion(currentVersion, 'patch');
        break;
      case '2':
        newVersion = bumpVersion(currentVersion, 'minor');
        break;
      case '3':
        newVersion = bumpVersion(currentVersion, 'major');
        break;
      case '4':
        newVersion = await question('Enter version: ');
        if (!isValidVersion(newVersion)) {
          throw new Error('Invalid version format. Use semver (e.g., 1.2.3)');
        }
        break;
      default:
        throw new Error('Invalid selection');
    }

    console.log(`\n🎯 New version: ${newVersion}`);
    const confirm = await question('\nProceed with publish? (y/N) ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Aborted.');
      rl.close();
      process.exit(0);
    }

    console.log('\n📝 Updating package.json and marketplace.json...');
    packageJson.version = newVersion;
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');

    const marketplaceJson = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf-8'));
    marketplaceJson.plugins[0].version = newVersion;
    fs.writeFileSync('.claude-plugin/marketplace.json', JSON.stringify(marketplaceJson, null, 2) + '\n');
    console.log('✓ Versions updated in both files');

    console.log('\n🔨 Building hooks...');
    await execAsync('npm run build');
    console.log('✓ Build complete');

    if (packageJson.scripts?.test) {
      console.log('\n🧪 Running tests...');
      try {
        await execAsync('npm test');
        console.log('✓ Tests passed');
      } catch (error) {
        console.error('❌ Tests failed:', error.message);
        const continueAnyway = await question('\nPublish anyway? (y/N) ');
        if (continueAnyway.toLowerCase() !== 'y') {
          console.log('Aborted.');
          rl.close();
          process.exit(1);
        }
      }
    }

    console.log('\n📌 Creating git commit and tag...');
    await execAsync('git add package.json .claude-plugin/marketplace.json plugin/');
    await execAsync(`git commit -m "chore: Release v${newVersion}

Marketplace release for Claude Code plugin
https://github.com/thedotmack/claude-mem"`);
    await execAsync(`git tag v${newVersion}`);
    console.log(`✓ Created commit and tag v${newVersion}`);

    console.log('\n⬆️  Pushing to git...');
    await execAsync('git push');
    await execAsync('git push --tags');
    console.log('✓ Pushed to git');

    console.log(`\n✅ Successfully released v${newVersion}! 🎉`);
    console.log(`\n🏷️  Tag: https://github.com/thedotmack/claude-mem/releases/tag/v${newVersion}`);
    console.log(`📦 Marketplace will sync from this tag automatically`);

  } catch (error) {
    console.error('\n❌ Release failed:', error.message);
    if (error.stderr) {
      console.error('\nError details:', error.stderr);
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  switch (type) {
    case 'patch':
      parts[2]++;
      break;
    case 'minor':
      parts[1]++;
      parts[2] = 0;
      break;
    case 'major':
      parts[0]++;
      parts[1] = 0;
      parts[2] = 0;
      break;
  }
  return parts.join('.');
}

function isValidVersion(version) {
  return /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(version);
}

publish();
