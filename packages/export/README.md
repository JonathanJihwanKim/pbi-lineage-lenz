# @pbi-lineage-lenz/export

Documentation formats for
[PBI Lineage Lenz](https://github.com/JonathanJihwanKim/pbi-lineage-lenz).

Turns an analyzed model into markdown — including a mermaid ER diagram GitHub renders
inline — or into JSON for whatever you want to build on top.

```bash
npm install @pbi-lineage-lenz/export
```

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
npx pbi-lineage-lenz docs ./MyReport --format md -o MODEL.md
```

MIT © Jihwan Kim
