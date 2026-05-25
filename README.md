![Model Lenz](docs/hero.png)

# Model Lenz

*Open-source static analyzer for Power BI PBIP projects. For any DAX measure, it shows every table that measure depends on (directly through the expression, and indirectly through active relationships).*

[![PyPI](https://img.shields.io/pypi/v/model-lenz.svg)](https://pypi.org/project/model-lenz/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue.svg)](https://www.python.org/downloads/)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/JonathanJihwanKim?label=Sponsor&logo=GitHub)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-%E2%98%95-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)
[![Microsoft MVP](https://img.shields.io/badge/Microsoft-MVP-5E5E5E?logo=microsoft)](https://mvp.microsoft.com/en-us/PublicProfile/5005958)

**If Model Lenz has saved you time on a model review, sponsor here — it takes 30 seconds:**

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)

---

## Why Model Lenz

- **One screenshot ends the "which tables does this measure actually touch?" thread.** Direct DAX refs, transitively-resolved sub-measures, and indirectly-walked relationships (with `USERELATIONSHIP` overrides) — all in one graph you can paste into a PR.
- **Both names on every node, no mode toggle.** A Power BI developer sees the semantic-model name they type in DAX. A data engineer sees the BigQuery FQN / SQL `[schema].[table]` / Snowflake `DB.SCHEMA.TABLE` / file path on the same node. Both sides read the same screenshot.
- **Diff two PBIPs (or two Git refs) on the graph itself.** Green / amber / red borders on table cards and relationship edges show what changed. Catches the table-set drift that reviewers miss when they read DAX line by line.
- **Read-only, local, ad-free, no XMLA, no phoning home.** Runs from a single Python wheel. Source control is the only prerequisite.

---

## Use it in 30 seconds

```bash
uv tool install model-lenz                              # or: pipx install model-lenz
model-lenz demo                                         # bundled 5-table PBIP, opens in browser
model-lenz serve "C:\path\to\Sales.SemanticModel"      # your own PBIP
```

Nothing to clone. The wheel ships the CLI, the React UI, and a tiny demo PBIP.

Need help with PATH on Windows, updates, path forms, or troubleshooting? → [docs/install.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/install.md)

---

## Sponsor

Model Lenz is free, ad-free, never phones home. Sponsorship is what decides what ships next. Right now your contribution funds:

- **`model-lenz check` for CI (v0.4).** Fail a PR build on orphan measures, ambiguous propagation paths, or a sudden indirect-table-set blow-up.
- **Annotation layer on sub-graph exports.** Inline reviewer comments on exported SVG / Mermaid attached to a PR.
- **Snowflake-native-SQL, Databricks, Synapse Serverless connectors.** Each opens a class of warehouses Model Lenz currently labels with low confidence.

If the tool already saved you a model-review headache, that's the trade — one click, one coffee, more features for everyone:

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)

Sponsor at the $10+ tier and you'll be listed (with your consent) in the [Hall of Sponsors](#hall-of-sponsors). Top tier on GitHub Sponsors includes a 30-minute monthly call with a Microsoft MVP.

---

## What's in the box

- **`serve`** — interactive measure-dependency graph for any PBIP. Switch PBIPs in-app via the header **Open…** button; no server restart.
- **`diff`** — two PBIPs (or two Git refs via `--git`) side-by-side on the same graph canvas, with a List tab for the per-entity audit. → [docs/diff.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/diff.md)
- **`summary` / `inspect`** — counts, classification breakdown, full parsed model as JSON. CI-friendly.
- **Share + embed** — **Copy link** (selection + depth in URL), **Copy MD** (one-pager handoff card), **Copy Mermaid**, **Download SVG**. Diff exports color both borders and arrows; removed edges render dashed.

Full CLI reference and feature table: [docs/cli.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/cli.md). Concepts and FAQ: [docs/faq.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/faq.md).

---

## Roadmap

- **v0.3.x — diff polish.** _Shipped._ Graph-canvas diff, shareable URLs, Markdown handoff cards, Mermaid / SVG exports, Git-ref diff mode. v0.3.2 colored relationship arrows in Mermaid diff exports.
- **v0.4 — guardrails before the merge.** `model-lenz check` CI gate · annotation layer on sub-graph exports.
- **Later.** DMV / XMLA mode for deployed semantic models · `.pbix` adapter · perspective-aware views · Kimball-style bus-layout auto-arrangement.

> **Not on this roadmap by design:** report-layer (PBIR) measure-usage — which pages and visuals consume each measure. That's what **[PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)** is for.

Have something else you'd like to see? Open a [feature request](https://github.com/JonathanJihwanKim/pbip_model_lenz/issues/new?template=feature_request.yml). [Sponsorship](#sponsor) decides what ships first.

---

## Also by Jihwan Kim

- **[PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer)**. Trace any visual back to its source columns through DAX. Browser-based, 100% client-side. *"Where does the number on this card actually come from?"*
- **[PBIP Documenter](https://github.com/JonathanJihwanKim/pbip-documenter)**. Generate bidirectional documentation (measures, tables, relationships, M-steps, native SQL) from PBIP/TMDL in seconds. *"Can I hand someone a readable spec of this model without writing one?"*

Together with Model Lenz, the three tools cover the model side, the report side, and the documentation side of a PBIP project without overlap.

---

## More detail when you need it

- **Install / update / troubleshooting:** [docs/install.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/install.md)
- **CLI reference + feature table:** [docs/cli.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/cli.md)
- **Diff walkthrough + share / export buttons:** [docs/diff.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/diff.md)
- **FAQ + concept primer:** [docs/faq.md](https://github.com/JonathanJihwanKim/pbip_model_lenz/blob/main/docs/faq.md)
- **Architecture + contributor tour:** [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Support development

Free tools survive when the people who get value from them give back. If Model Lenz saved you time on a model review, an audit, or a *"wait, where does this column actually come from?"* conversation, here's where:

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/JonathanJihwanKim)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/jihwankim)

GitHub Sponsors runs $2 / $5 / $10 / $25 / $50 per month. Buy Me a Coffee is one-time, any amount. Both go to the same person.

### Hall of Sponsors

*Your name here. Sponsor at the $10+ tier and you'll be listed (with your consent) here on the README and on the project website.*

---

## License

[MIT](LICENSE). Use it commercially, fork it, ship it inside whatever you're building. Attribution appreciated but not required.
