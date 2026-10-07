# Context variants

One folder per variant:

    <name>/
      manifest.json      { "name", "description", "createdFrom", "changes": [{ "file", "reason" }], "delete": [] }
      files/             copied over the project root in the variant's trials

`files/CLAUDE.md` replaces CLAUDE.md; `"delete": ["CLAUDE.md"]` removes it instead.
Run with `/context-lab eval <name>`: baseline and variant start from the same commit.
