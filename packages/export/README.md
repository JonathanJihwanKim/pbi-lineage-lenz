# @pbi-lineage-lenz/export

Documentation formats for
[PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).

Turns an analyzed model into markdown — including a mermaid ER diagram GitHub renders
inline — or into JSON for whatever you want to build on top.

```bash
git clone https://github.com/JonathanJihwanKim/pbi-lineage-lenz
cd pbi-lineage-lenz && npm install
```

The copy on npm stops at 1.x; 2.x is released on GitHub only. In the clone this package is
`packages/export`, and npm workspaces resolve `@pbi-lineage-lenz/export` to it.

```js
import { toMarkdown, toJson } from '@pbi-lineage-lenz/export';

writeFileSync('MODEL.md',   toMarkdown(model));
writeFileSync('model.json', toJson(model));
```

The markdown leads with the model's shape — which tables are facts, which are dimensions,
which is a bridge — because that is what a reader needs before any table listing means
anything.

Most people want the CLI rather than this package:

```bash
pbi-lineage-lenz docs ./MyReport --format md -o MODEL.md
```

MIT © Jihwan Kim
