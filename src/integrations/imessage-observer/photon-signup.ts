/**
 * Sign in to Photon from `claude-mem imessage setup`, so nobody has to dig a
 * project id and secret out of a dashboard.
 *
 * It drives Photon's own command-line tool (`@photon-ai/cli`, the Stable
 * release under its `legacy` tag):
 *
 *   1. `photon login` prints a link and a code and opens the browser. The
 *      person approves the sign-in there; nothing is typed into claude-mem.
 *   2. `photon projects ls --json` lists their projects; setup picks the only
 *      one or asks which.
 *   3. `photon projects secret <id> --json` prints that project's existing
 *      secret. It does not rotate it, so other apps on the project keep working.
 *
 * The runner and the question prompt are passed in, so tests drive the flow
 * without Photon or a terminal.
 */
import type { PhotonProjectCredentials } from './photon-cloud.js';

export const PHOTON_CLI = '@photon-ai/cli@legacy';
export const PHOTON_DASHBOARD_URL = 'https://app.photon.codes';

export interface CliResult { status: number | null; stdout: string }
export type PhotonCliRunner = (args: string[], options: { interactive: boolean }) => Promise<CliResult> | CliResult;

export interface SignupIo {
  run: PhotonCliRunner;
  ask(question: string): Promise<string>;
  log(message: string): void;
}

interface PhotonProject { id: string; name?: string; status?: string; platforms?: string[] }

export class PhotonSignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotonSignupError';
  }
}

function parseJson<T>(result: CliResult, what: string): T {
  if (result.status !== 0) throw new PhotonSignupError(`Photon could not ${what}.`);
  // The JSON is the last thing printed; anything before it is the tool's own chatter.
  const text = result.stdout.trim();
  const start = text.search(/[[{]/);
  try {
    return JSON.parse(start >= 0 ? text.slice(start) : text) as T;
  } catch {
    throw new PhotonSignupError(`Photon's answer to "${what}" was not readable.`);
  }
}

async function pickProject(projects: PhotonProject[], io: SignupIo): Promise<PhotonProject> {
  if (projects.length === 1) return projects[0]!;
  io.log('Your Photon projects:');
  projects.forEach((project, index) => {
    const platforms = project.platforms?.length ? ` (${project.platforms.join(', ')})` : '';
    io.log(`  ${index + 1}. ${project.name ?? project.id}${platforms}`);
  });
  for (let tries = 0; tries < 3; tries += 1) {
    const answer = (await io.ask(`Which project has your iMessage line? [1-${projects.length}]: `)).trim();
    const choice = Number.parseInt(answer, 10);
    if (choice >= 1 && choice <= projects.length) return projects[choice - 1]!;
  }
  throw new PhotonSignupError('No project was picked.');
}

export async function signInWithPhoton(io: SignupIo): Promise<PhotonProjectCredentials & { projectName: string }> {
  io.log(`Signing in to Photon with Photon's own tool (npx ${PHOTON_CLI} login).`);
  io.log('It shows a link and a code and opens your browser. Approve the sign-in there.');
  const login = await io.run(['login'], { interactive: true });
  if (login.status !== 0) throw new PhotonSignupError('The Photon sign-in did not finish.');

  const listed = parseJson<PhotonProject[] | { projects?: PhotonProject[] }>(await io.run(['projects', 'ls', '--json'], { interactive: false }), 'list your projects');
  const projects = (Array.isArray(listed) ? listed : listed.projects ?? []).filter(project => project && typeof project.id === 'string');
  if (projects.length === 0) {
    throw new PhotonSignupError(`Your Photon account has no project yet. Create one at ${PHOTON_DASHBOARD_URL}, add an iMessage line to it, then run setup again.`);
  }
  const project = await pickProject(projects, io);

  const secret = parseJson<{ projectSecret?: string }>(await io.run(['projects', 'secret', project.id, '--json'], { interactive: false }), 'read the project secret');
  if (!secret.projectSecret) {
    throw new PhotonSignupError(`The Photon project "${project.name ?? project.id}" has no secret yet. Create one on ${PHOTON_DASHBOARD_URL} (project Settings), then run setup again.`);
  }
  return { projectId: project.id, projectSecret: secret.projectSecret, projectName: project.name ?? project.id };
}
