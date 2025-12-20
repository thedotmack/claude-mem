import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import type { Email } from './email-loader.js';

interface ContextLayerInput {
  summary?: string;
  observations: Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    narrative: string | null;
    facts: string | null;
    created_at: string;
  }>;
  currentEmail: Email;
  emailNumber: number;
  totalEmails: number;
}

const TYPE_EMOJI_MAP: Record<string, string> = {
  'entity': '👤',
  'relationship': '🔗',
  'timeline-event': '📅',
  'evidence': '📄',
  'anomaly': '⚠️',
  'conclusion': '⚖️',
};

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day}`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}


function buildSummarySection(summary: string | undefined): string {
  if (!summary) {
    return '# Investigation Summary\n\nNo summary available yet - this is the beginning of the investigation.\n';
  }

  return `# Investigation Summary\n\n${summary}\n`;
}

function buildIndexTable(observations: ContextLayerInput['observations']): string {
  if (observations.length === 0) {
    return '\n# Recent Observations Index\n\nNo observations recorded yet.\n';
  }

  const rows = observations.map(obs => {
    const emoji = TYPE_EMOJI_MAP[obs.type] || '📝';
    const date = formatDate(obs.created_at);
    const time = formatTime(obs.created_at);
    const title = obs.title || '';

    return `| #${obs.id} | ${date} ${time} | ${emoji} | ${obs.type} | ${title} |`;
  });

  return `
# Recent Observations Index (Last ${observations.length})

| ID | Date | T | Type | Title |
|----|------|---|------|-------|
${rows.join('\n')}
`;
}

function parseFacts(facts: string | null): string[] | null {
  if (!facts) return null;
  try {
    const parsed = JSON.parse(facts);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.warn(`Failed to parse facts JSON: ${facts.slice(0, 100)}...`);
    return null;
  }
}

function buildExpandedSection(observations: ContextLayerInput['observations']): string {
  if (observations.length === 0) {
    return '\n# Detailed Recent Observations\n\nNo observations to display yet.\n';
  }

  const formatted = observations.map(obs => {
    const emoji = TYPE_EMOJI_MAP[obs.type] || '📝';
    const title = obs.title || 'Untitled';
    const subtitle = obs.subtitle ? `\n**${obs.subtitle}**` : '';

    let content = '';

    if (obs.narrative) {
      content += `\n${obs.narrative}`;
    }

    const factsList = parseFacts(obs.facts);
    if (factsList && factsList.length > 0) {
      content += '\n\n**Facts:**\n';
      factsList.forEach(fact => {
        content += `- ${fact}\n`;
      });
    }

    return `**${emoji} #${obs.id}** ${title}${subtitle}${content}\n`;
  });

  return `
# Detailed Recent Observations (Last ${observations.length})

${formatted.join('\n---\n\n')}
`;
}

function buildCurrentEmailSection(email: Email, emailNumber: number, totalEmails: number): string {
  const formattedDate = formatDate(email.date);
  const formattedTime = formatTime(email.date);

  const toList = email.to.join(', ');
  const ccList = email.cc && email.cc.length > 0 ? `\n**CC:** ${email.cc.join(', ')}` : '';

  return `
# Current Email (${emailNumber}/${totalEmails})

**From:** ${email.from}
**To:** ${toList}${ccList}
**Date:** ${formattedDate} ${formattedTime}
**Subject:** ${email.subject}

**Body:**
${email.body}
`;
}

function formatProgressiveContext(input: ContextLayerInput): string {
  const parts: string[] = [];

  parts.push(buildSummarySection(input.summary));
  parts.push(buildIndexTable(input.observations));
  parts.push(buildExpandedSection(input.observations));
  parts.push(buildCurrentEmailSection(input.currentEmail, input.emailNumber, input.totalEmails));

  return parts.join('\n');
}

export function buildContextForEmail(
  sessionStore: SessionStore,
  email: Email,
  emailNumber: number,
  totalEmails: number,
  project: string
): string {
  const allObservations = sessionStore.getAllRecentObservations(100);

  const observations = allObservations
    .filter(obs => obs.project === project)
    .map(obs => ({
      id: obs.id,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      narrative: obs.text,
      facts: null,
      created_at: obs.created_at,
    }));

  const allSummaries = sessionStore.getAllRecentSummaries(1);
  const latestSummary = allSummaries.find(s => s.project === project);

  const summary = latestSummary
    ? `${latestSummary.request || ''}\n\n${latestSummary.learned || ''}`
    : undefined;

  return formatProgressiveContext({
    summary,
    observations,
    currentEmail: email,
    emailNumber,
    totalEmails,
  });
}
