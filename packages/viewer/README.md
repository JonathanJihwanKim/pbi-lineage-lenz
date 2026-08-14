# @pbi-lineage-lenz/viewer

The browser UI behind [PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).

Renders an analyzed model as five lenses — overview, model shape, source map, measures and
pages — from the plain data
[`@pbi-lineage-lenz/core`](https://www.npmjs.com/package/@pbi-lineage-lenz/core) produces.

```bash
npm install @pbi-lineage-lenz/viewer
```

```js
import { mountViewer } from '@pbi-lineage-lenz/viewer';

mountViewer(document.querySelector('#app'), viewerModel);
```

No framework and no build step: plain ES modules and one stylesheet. It touches the DOM and
nothing else — no network, no file system — which is what lets the same code run in the web
app and inside a self-contained handoff file.

Most people want the CLI rather than this package:

```bash
npx pbi-lineage-lenz handoff ./MyReport -o handoff.html
```

MIT © Jihwan Kim
