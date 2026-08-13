# Security and privacy

## Your model never leaves your machine

A web app that asks for your project folder invites exactly one question, and it deserves
a direct answer.

**Nothing is uploaded. There is no server.**

The web app is static files on GitHub Pages. Your folder is read in the page, parsed in the
page, and rendered in the page. There is no backend to send it to, no telemetry, no
analytics, and no network request of any kind after the page itself has loaded.

You can verify this rather than take it on trust:

- Open your browser's **Network** tab, load a folder, and watch. Nothing goes out.
- Or read [`apps/web/src/`](apps/web/src/) — there is no `fetch` in it.
- Or work entirely offline. Load the page, disconnect, then open your folder. It works.

## Handoff files fetch nothing

An exported `handoff.html` is a single self-contained file: the viewer, the styles and your
model, inlined. It makes **no network requests at all** — no fonts, no CDN, no analytics.
Open it on an air-gapped machine and it behaves identically.

That is a deliberate constraint and it is asserted in the test suite, not just intended:
`packages/handoff/tests/` checks the built file for external references.

## What a handoff file does contain

Everything the tool parsed: table and column names, DAX, Power Query steps, data source
names, server hostnames, database names, and your report layout.

**It contains no data rows** — a PBIP holds a model definition, not its contents.

But treat a handoff file with the same care as the PBIP it came from. If your M expressions
name an internal server, that hostname is in the file. Before sending one outside your
organisation, open it and look — it is a single file and the source map lists every path in
one place, which makes this a two-minute check rather than an act of faith.

## The CLI

`pbi-lineage-lenz` reads the folder you point it at and writes the file you asked for. It
makes no network requests. `diff` shells out to `git` in your repository; nothing else runs
a subprocess.

## Reporting a vulnerability

Email **jonathan.jihwankim@gmail.com** rather than opening a public issue.

Please include what you found, how to reproduce it, and what an attacker could do with it.
You will get an acknowledgement within a few days.

Things worth reporting:

- any network request made by the web app or a handoff file
- a way to get a handoff file to execute content from the model it embeds — model names are
  author-controlled text and are escaped on the way in, so a way past that escaping matters
- a way to make the CLI read or write outside the paths it was given

## Supported versions

The latest published version is the supported one. This is a single-maintainer project;
fixes go to `main` and to the next release rather than to older lines.
