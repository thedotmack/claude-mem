import { OptionValues } from 'commander';
import path from 'path';
import fs from 'fs';

const SESSION_DIR = path.join(process.env.HOME || '', '.claude-mem', 'sessions');

/**
 * Update session metadata (title/subtitle) in the streaming session JSON file
 * Called by SDK when generating session title at the start
 */
export async function updateSessionMetadata(options: OptionValues): Promise<void> {
  const { project, session, title, subtitle } = options;

  // Validate required fields
  if (!project || !session) {
    console.error(JSON.stringify({
      success: false,
      error: 'Missing required fields: --project, --session'
    }));
    process.exit(1);
  }

  if (!title) {
    console.error(JSON.stringify({
      success: false,
      error: 'Missing required field: --title'
    }));
    process.exit(1);
  }

  try {
    // Load existing session file
    const sessionFile = path.join(SESSION_DIR, `${project}_streaming.json`);

    if (!fs.existsSync(sessionFile)) {
      console.error(JSON.stringify({
        success: false,
        error: `Session file not found: ${sessionFile}`
      }));
      process.exit(1);
    }

    let sessionData: any = {};
    try {
      sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    } catch (e) {
      console.error(JSON.stringify({
        success: false,
        error: 'Failed to parse session file'
      }));
      process.exit(1);
    }

    // Update metadata
    sessionData.promptTitle = title;
    if (subtitle) {
      sessionData.promptSubtitle = subtitle;
    }
    sessionData.updatedAt = new Date().toISOString();

    // Write back to file
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));

    // Output success
    console.log(JSON.stringify({
      success: true,
      title,
      subtitle: subtitle || null,
      project,
      session
    }));

  } catch (error: any) {
    console.error(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error updating session metadata'
    }));
    process.exit(1);
  }
}
