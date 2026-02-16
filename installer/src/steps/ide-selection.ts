import * as p from '@clack/prompts';

export type IDE = 'claude-code' | 'cursor';

export async function runIdeSelection(): Promise<IDE[]> {
  const result = await p.multiselect({
    message: 'Which IDEs do you use?',
    options: [
      { value: 'claude-code' as const, label: 'Claude Code', hint: 'recommended' },
      { value: 'cursor' as const, label: 'Cursor' },
      // Windsurf coming soon - not yet selectable
    ],
    initialValues: ['claude-code'],
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  const selectedIDEs = result as IDE[];

  if (selectedIDEs.includes('claude-code')) {
    p.log.info('Claude Code: Plugin will be registered via marketplace.');
  }
  if (selectedIDEs.includes('cursor')) {
    p.log.info('Cursor: Hooks will be configured for your projects.');
  }

  return selectedIDEs;
}
