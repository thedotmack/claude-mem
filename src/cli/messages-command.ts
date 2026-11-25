import { acknowledgeClaudeMemMessage } from '../shared/claude-mem-messages.js';

const usage = 'Usage: claude-mem messages acknowledge <message-id>';
const failureMessages = {
  unknown: 'Unknown Claude-Mem message.',
  'not-dispatched': 'This Claude-Mem message has not been dispatched on this installation.',
  unavailable: 'Could not record the acknowledgment on this installation.',
} satisfies Record<Exclude<ReturnType<typeof acknowledgeClaudeMemMessage>, 'acknowledged' | 'already-acknowledged'>, string>;

/** Only an issued first-party message can be acknowledged. This command is local. */
export function runMessagesCommand(args: string[]): number {
  const [action, id] = args;
  if (args.length === 1 && (action === '--help' || action === '-h')) {
    console.log(usage);
    return 0;
  }
  if (action !== 'acknowledge' || !id || args.length !== 2) {
    console.error(usage);
    return 1;
  }

  const status = acknowledgeClaudeMemMessage(id);
  if (status === 'acknowledged' || status === 'already-acknowledged') {
    console.log(`Acknowledged Claude-Mem message ${id}.`);
    return 0;
  }
  console.error(failureMessages[status]);
  return 1;
}
