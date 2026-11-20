# Public visual evaluation corpus

Eight cases, nine images: small-text screenshot, terminal error, labeled chart,
diagram, generated art, photograph, dark UI, and two-image attribution.
`manifest.json` records SHA-256, source dimensions, selected recipe, critical
facts and expected image labels. No private user screenshot is included.
Critical facts are grading data and never sent as the model prompt. Mock/dry-run
success is not model qualification. Exact-fact matching is deliberately
conservative; Phase 7 needs human review of equivalent paraphrases and fabricated
critical facts. The full event/observation/parser flow is also a Phase 7 gate.

Seven cases are generated locally by `scripts/media/generate-corpus.ts` from
fixed synthetic vector art. SVG is only an authoring input to Sharp for the
fixture generator; the actual media converter accepts PNG/JPEG/WebP only.
Generated pixel artifacts are committed with hashes so a font/encoder change
is visible. No provider or image-generation API is used by the generator.

The photograph is NASA's Apollo 17 Blue Marble image AS17-148-22727, photographed
December 7, 1972. Credit: Earth Science and Remote Sensing Unit, NASA Johnson
Space Center. The committed 1024x1024 JPEG is unmodified from the primary
[NASA SVS asset](https://svs.gsfc.nasa.gov/vis/a030000/a030600/a030613/blue_marble_apollo_17_19721207_print.jpg)
listed on the [NASA SVS source page](https://svs.gsfc.nasa.gov/30613/).
This U.S. government photograph is used as an informational test fixture under
[NASA's image/media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
It includes no NASA logo or identifiable person, and no NASA endorsement is
implied. The manifest records the exact downloaded source SHA-256.

Rebuild synthetic artifacts locally with `rtk bun scripts/media/generate-corpus.ts`
in L or `rtk node --import tsx scripts/media/generate-corpus.ts` in P. The NASA
JPEG must already be present; regeneration performs no network requests.
Run the zero-request CLI with `rtk bun scripts/media/evaluate.ts` (L) or
`rtk node --import tsx scripts/media/evaluate.ts` (P). Live execution is
deliberately unavailable in the CLI until Phase 7 supplies the provider/full-flow
adapter; the injected execution seam is tested with mocks and explicit limits.
