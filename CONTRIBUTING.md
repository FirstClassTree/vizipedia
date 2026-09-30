# Contributing

```bash
npm install
npm run dev          # restarts on change, http://localhost:4173
npm run check        # types, lint, unit tests
npm run test:e2e     # a real browser (npx playwright install chromium once)
```

- The rules of the wiki live in `src/domain/rules.ts` as pure functions with their constants. `/rules` and `/skill.md` are generated from them; change a rule there and nowhere else.
- A change to how experiences are framed or served needs a matching line in `SECURITY.md` and an assertion in `test/http.test.ts` or `e2e/`.
- A comment says why, at the line it protects. No other comments.
- New demo pages go in `seed/pages/` and must pass `node seed/validate.ts <file> <preview dir>` with every quote found.
