import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../../src/ui/viewer/components/Header.js';
import { TEAMBRAIN_START_URL } from '../../../src/ui/viewer/constants/promo.js';

function renderHeader(showTeamBrainLink?: boolean): string {
  return renderToStaticMarkup(
    <Header
      projects={[]}
      currentFilter=""
      onFilterChange={() => {}}
      isProcessing={false}
      queueDepth={0}
      themePreference="system"
      onThemeChange={() => {}}
      onContextPreviewToggle={() => {}}
      {...(showTeamBrainLink === undefined ? {} : { showTeamBrainLink })}
    />,
  );
}

describe('viewer header TeamBrain link', () => {
  it('keeps both purchase and TeamBrain promotions out of the personal viewer', () => {
    const html = renderHeader(true);
    expect(html).not.toContain('class="teambrain-cta"');
    expect(html).not.toContain('pro-trial-cta');
    expect(html).not.toContain('cmem.ai/pro');
    expect(html).not.toContain(`href="${TEAMBRAIN_START_URL}"`);
    expect(html).not.toContain('>TeamBrain</a>');
  });

  it('is gone once the install is in a team, and before settings have loaded', () => {
    expect(renderHeader(false)).not.toContain('teambrain-cta');
    expect(renderHeader()).not.toContain('teambrain-cta');
  });
});
