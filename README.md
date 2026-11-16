# markdown-render-speed-02-r2

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bnbf/markdown-render-speed-02-r2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bnbf/markdown-render-speed-02-r2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, byte-exact Markdown parser written from scratch in JavaScript. It renders Markdown to HTML identical to marked 18.1.3 on the 720 practice cases, using a hand-written single-pass scanner with direct-to-HTML output — no token tree, no dependencies, no lookup tables.

## Run it

```sh
node main.ts
```

`main.ts` reads `/input/cases.json` (720 `{id, markdown}` cases) and writes `/output/html.json` with the rendered HTML for each case, byte-identical to marked 18.1.3.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bsqaxrmg&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
