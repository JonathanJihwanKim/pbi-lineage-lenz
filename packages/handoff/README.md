# @pbi-lineage-lenz/handoff

Builds the self-contained HTML file behind
[PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).

The viewer, the styles and your model, inlined into one file. It makes **no network
requests at all** — no fonts, no CDN, no analytics — so it opens identically on an
air-gapped machine, and that constraint is asserted in the test suite rather than merely
intended.

```bash
npm install @pbi-lineage-lenz/handoff
```

```js
import { buildHandoff } from '@pbi-lineage-lenz/handoff';

const { html, bytes, warnings } = await buildHandoff(viewerModel, { title: 'Sales' });
```

The CLI and the browser both call this, and produce a byte-identical file.

Most people want the CLI rather than this package:

```bash
npx pbi-lineage-lenz handoff ./MyReport -o handoff.html
```

MIT © Jihwan Kim
