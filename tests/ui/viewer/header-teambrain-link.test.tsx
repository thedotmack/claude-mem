import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../../src/ui/viewer/components/Header.js';
import { TEAMBRAIN_START_URL } from '../../../src/ui/viewer/constants/promo.js';

describe('viewer header TeamBrain link', () => {
  it('links to the TeamBrain start page', () => {
    const html = renderToStaticMarkup(
      <Header
        projects={[]}
        currentFilter=""
        onFilterChange={() => {}}
        isProcessing={false}
        queueDepth={0}
        themePreference="system"
        onThemeChange={() => {}}
        onContextPreviewToggle={() => {}}
        showTeamBrainLink={true}
      />,
    );
    expect(html).toContain('class="teambrain-cta"');
    expect(html).toContain(`href="${TEAMBRAIN_START_URL}"`);
    expect(html).toContain('>TeamBrain</a>');
  });
});
