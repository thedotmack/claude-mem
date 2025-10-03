import { OptionValues } from 'commander';
import { spawnSync } from 'child_process';
import { createStores } from '../services/sqlite/index.js';

/**
 * Store a memory to all three storage layers
 * Called by SDK via bash during streaming memory capture
 */
export async function storeMemory(options: OptionValues): Promise<void> {
  const { id, project, session, date, title, subtitle, facts, concepts, files } = options;

  // Validate required fields
  if (!id || !project || !session || !date) {
    console.error('Error: All fields required: --id, --project, --session, --date');
    process.exit(1);
  }

  // Validate hierarchical fields (required for v2 format)
  if (!title || !subtitle || !facts) {
    console.error('Error: Hierarchical format required: --title, --subtitle, --facts');
    process.exit(1);
  }

  try {
    const stores = await createStores();
    const timestamp = new Date().toISOString();

    // Ensure session exists
    const sessionExists = await stores.sessions.has(session);
    if (!sessionExists) {
      await stores.sessions.create({
        session_id: session,
        project,
        created_at: timestamp,
        source: 'save'
      });
    }

    // Parse JSON arrays if provided as strings
    let factsArray: string | undefined;
    let conceptsArray: string | undefined;
    let filesArray: string | undefined;

    try {
      factsArray = facts ? JSON.stringify(JSON.parse(facts)) : undefined;
    } catch (e) {
      factsArray = facts; // Store as-is if not valid JSON
    }

    try {
      conceptsArray = concepts ? JSON.stringify(JSON.parse(concepts)) : undefined;
    } catch (e) {
      conceptsArray = concepts; // Store as-is if not valid JSON
    }

    try {
      filesArray = files ? JSON.stringify(JSON.parse(files)) : undefined;
    } catch (e) {
      filesArray = files; // Store as-is if not valid JSON
    }

    // Layer 1: SQLite Memory Index
    const memoryExists = stores.memories.hasDocumentId(id);
    if (!memoryExists) {
      stores.memories.create({
        document_id: id,
        text: '', // Deprecated: hierarchical fields replace narrative text
        keywords: '',
        session_id: session,
        project,
        created_at: timestamp,
        origin: 'streaming-sdk',
        // Hierarchical fields (v2)
        title: title || undefined,
        subtitle: subtitle || undefined,
        facts: factsArray,
        concepts: conceptsArray,
        files_touched: filesArray
      });
    }

    // Layer 2: ChromaDB - Store hierarchical memory
    if (factsArray) {
      const factsJson = JSON.parse(factsArray);
      const conceptsJson = conceptsArray ? JSON.parse(conceptsArray) : [];
      const filesJson = filesArray ? JSON.parse(filesArray) : [];

      // Store each atomic fact as a separate ChromaDB document
      factsJson.forEach((fact: string, idx: number) => {
        spawnSync('claude-mem', [
          'chroma_add_documents',
          '--collection_name', 'claude_memories',
          '--documents', JSON.stringify([fact]),
          '--ids', JSON.stringify([`${id}_fact_${String(idx).padStart(3, '0')}`]),
          '--metadatas', JSON.stringify([{
            type: 'fact',
            parent_id: id,
            fact_index: idx,
            title,
            subtitle,
            project,
            session_id: session,
            created_at: timestamp,
            created_at_epoch: Date.parse(timestamp),
            keywords: '',
            concepts: JSON.stringify(conceptsJson),
            files_touched: JSON.stringify(filesJson),
            origin: 'streaming-sdk'
          }])
        ]);
      });

      // Store full narrative with hierarchical metadata
      spawnSync('claude-mem', [
        'chroma_add_documents',
        '--collection_name', 'claude_memories',
        '--documents', JSON.stringify([`${title}\n${subtitle}\n\n${factsJson.join('\n')}`]),
        '--ids', JSON.stringify([id]),
        '--metadatas', JSON.stringify([{
          type: 'narrative',
          title,
          subtitle,
          facts_count: factsJson.length,
          project,
          session_id: session,
          created_at: timestamp,
          created_at_epoch: Date.parse(timestamp),
          keywords: '',
          concepts: JSON.stringify(conceptsJson),
          files_touched: JSON.stringify(filesJson),
          origin: 'streaming-sdk'
        }])
      ]);
    }

    // Success output (SDK will see this)
    console.log(JSON.stringify({
      success: true,
      memory_id: id,
      project,
      session,
      date,
      timestamp,
      hierarchical: !!(title && subtitle && facts)
    }));

  } catch (error: any) {
    console.error(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error storing memory'
    }));
    process.exit(1);
  }
}