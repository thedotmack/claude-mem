import * as p from '@clack/prompts';

async function main() {
  p.intro('claude-mem installer');
  p.outro('Scaffolding complete — phases 2-7 will add real steps.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
