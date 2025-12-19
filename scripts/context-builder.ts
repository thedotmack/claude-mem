import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import type { Email } from './email-loader.js';

export interface ContextLayerInput {
  summary?: string;
  observations: Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    narrative: string | null;
    facts: string | null;
    created_at: string;
    from_email?: string;
    to_email?: string;
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

function extractEmailParticipants(email: Email): { from: string; to: string } {
  const extractAddress = (str: string): string => {
    const match = str.match(/<([^>]+)>/);
    return match ? match[1] : str;
  };

  const from = extractAddress(email.from);
  const to = email.to.length > 0 ? extractAddress(email.to[0]) : '';

  return { from, to };
}

function extractObservationParticipants(obs: ContextLayerInput['observations'][0]): { from: string; to: string } {
  const { from_email, to_email, title, facts } = obs;

  if (from_email && to_email) {
    return { from: from_email, to: to_email };
  }

  const extractFromText = (text: string): { from: string; to: string } => {
    const emailPattern = /<([^>]+@[^>]+)>/g;
    const matches = Array.from(text.matchAll(emailPattern));
    if (matches.length >= 2) {
      return { from: matches[0][1], to: matches[1][1] };
    }
    return { from: '', to: '' };
  };

  if (title) {
    const extracted = extractFromText(title);
    if (extracted.from && extracted.to) return extracted;
  }

  if (facts) {
    try {
      const factsList = JSON.parse(facts);
      if (Array.isArray(factsList) && factsList.length > 0) {
        const extracted = extractFromText(factsList[0]);
        if (extracted.from && extracted.to) return extracted;
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return { from: '', to: '' };
}

function buildSummarySection(summary: string | undefined): string {
  if (!summary) {
    return '# Investigation Summary\n\nNo summary available yet - this is the beginning of the investigation.\n';
  }

  return `# Investigation Summary\n\n${summary}\n`;
}

function buildIndexTable(observations: ContextLayerInput['observations'], limit: number = 100): string {
  if (observations.length === 0) {
    return '\n# Recent Observations Index\n\nNo observations recorded yet.\n';
  }

  const recentObs = observations.slice(0, limit);

  const rows = recentObs.map(obs => {
    const emoji = TYPE_EMOJI_MAP[obs.type] || '📝';
    const date = formatDate(obs.created_at);
    const time = formatTime(obs.created_at);
    const { from, to } = extractObservationParticipants(obs);
    const participants = from && to ? `${from}→${to}` : '';
    const type = obs.type;
    const title = (obs.title || '').slice(0, 50);

    return `| #${obs.id} | ${date} ${time} | ${participants.slice(0, 30)} | ${emoji} | ${type} | ${title} |`;
  });

  return `
# Recent Observations Index (Last ${recentObs.length})

| ID | Date | From→To | T | Type | Title |
|----|------|---------|---|------|-------|
${rows.join('\n')}
`;
}

function buildExpandedSection(observations: ContextLayerInput['observations'], limit: number = 20): string {
  if (observations.length === 0) {
    return '\n# Detailed Recent Observations\n\nNo observations to display yet.\n';
  }

  const recentObs = observations.slice(0, limit);

  const formatted = recentObs.map(obs => {
    const emoji = TYPE_EMOJI_MAP[obs.type] || '📝';
    const title = obs.title || 'Untitled';
    const subtitle = obs.subtitle ? `\n**${obs.subtitle}**` : '';

    let content = '';

    if (obs.narrative) {
      content += `\n${obs.narrative}`;
    }

    if (obs.facts) {
      try {
        const factsList = JSON.parse(obs.facts);
        if (Array.isArray(factsList) && factsList.length > 0) {
          content += '\n\n**Facts:**\n';
          factsList.forEach(fact => {
            content += `- ${fact}\n`;
          });
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return `**${emoji} #${obs.id}** ${title}${subtitle}${content}\n`;
  });

  return `
# Detailed Recent Observations (Last ${recentObs.length})

${formatted.join('\n---\n\n')}
`;
}

function buildCurrentEmailSection(email: Email, emailNumber: number, totalEmails: number): string {
  const { from, to } = extractEmailParticipants(email);
  const date = new Date(email.date).toISOString();
  const formattedDate = formatDate(date);
  const formattedTime = formatTime(date);

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

export function formatProgressiveContext(input: ContextLayerInput): string {
  const parts: string[] = [];

  parts.push(buildSummarySection(input.summary));
  parts.push(buildIndexTable(input.observations, 100));
  parts.push(buildExpandedSection(input.observations, 20));
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
