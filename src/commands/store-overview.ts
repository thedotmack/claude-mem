import { OptionValues } from 'commander';
import { createStores } from '../services/sqlite/index.js';

/**
 * Store a session overview
 * Called by SDK via bash at session end
 */
export async function storeOverview(options: OptionValues): Promise<void> {
  const { project, session, content } = options;

  // Validate required fields
  if (!project || !session || !content) {
    console.error('Error: All fields required: --project, --session, --content');
    process.exit(1);
  }

  try {
    const stores = await createStores();
    const timestamp = new Date().toISOString();

    // Create one overview per session (rolling log architecture)
    stores.overviews.upsert({
      session_id: session,
      content,
      created_at: timestamp,
      project,
      origin: 'streaming-sdk'
    });

    // Success output (SDK will see this)
    console.log(JSON.stringify({
      success: true,
      project,
      session,
      timestamp
    }));

  } catch (error: any) {
    console.error(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error storing overview'
    }));
    process.exit(1);
  }
}