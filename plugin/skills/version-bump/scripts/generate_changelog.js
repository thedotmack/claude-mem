#!/usr/bin/env node
const fs = require('fs');

/**
 * Processes GitHub release JSON from stdin and outputs a formatted CHANGELOG.md
 */
function generate() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input || input.trim() === '') {
      process.stderr.write('No input received on stdin
');
      process.exit(1);
    }

    const releases = JSON.parse(input);
    const lines = ['# Changelog', '', 'All notable changes to this project.', ''];
    
    releases.slice(0, 50).forEach(r => {
      const date = r.published_at.split('T')[0];
      lines.push(`## [${r.tag_name}] - ${date}`);
      lines.push('');
      if (r.body) lines.push(r.body.trim());
      lines.push('');
    });
    
    process.stdout.write(lines.join('
') + '
');
  } catch (err) {
    process.stderr.write(`Error generating changelog: ${err.message}
`);
    process.exit(1);
  }
}

generate();
