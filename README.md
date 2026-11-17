# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/LearnandLive0/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/LearnandLive0/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks 200 pre-token protocols by implied token value, from a sealed DeFiLlama snapshot (758 protocols, as of 2026-11-14). The 40-protocol watchlist is every pre-token protocol with at least $50M of TVL; the early radar adds 160 more below that floor. Each row carries its model inputs (TVL, seven-day growth, age with no token) and a concrete farm plan with costs and times. The dashboard is static and renders with no network.

The model (radar-2): implied = TVL x 0.25 x size x growth x maturity, where size damps large protocols slightly, growth counts a fall more than a rise of the same size, and maturity is an S-ramp on how long the protocol has run with no token. No protocol name is special-cased.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads a snapshot in the sealed format and writes `out/board.json`, `out/data.js`, `out/dashboard/` (3 files), `out/screenshots/` (3 images) and `out/dossier.json`.

The three screenshots are stored in the repository as base64 text (`screenshots/*.png.b64`) and decoded into `out/screenshots/` at run time, because the push path GitHub offers this entry carries text only. The decoded bytes are exactly the PNGs the dashboard was screenshotted from.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
