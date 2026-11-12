# Presentation (`v1.0-presentation`)

A 12-minute talk following `docs/PROJECT_DESIGN.md` §13 and framework §10.2. Every number on the slides comes from `results/summary/` (dataset v1, frozen in `results/data-freeze.json`); every chart comes from `npm run analyze` (`results/figures/`). The full write-up is `docs/results.md`.

- **Deck:** Claude Slides, https://claude.ai/artifact/BKQ4aS3eHrWERVxWNdCnbP (Miraj shares it from the deck's Share menu; it exports to PowerPoint or PDF). Speaker notes on every slide.
- **Fallback demo videos:** `results/dry-run/demo/<runId>-<policy>.webm`, real recordings of the player page on `volatile-v1` (local only, git-ignored). The deck's demo slide embeds a 45-second cut of the conservative one.

## Running order and speakers

| # | Slide | Speaker | Time | Hand-off line |
|---:|---|---|---:|---|
| 1 | Cover, then the question and hypotheses | Miraj | 0:45 | “Susmoy will show how a player makes this choice.” |
| 2 | How a player chooses quality | Susmoy | 1:15 | “Galib built the lab that lets us test it fairly.” |
| 3 | A controlled lab, not the open Internet | Galib | 1:30 | “Miraj will explain how we measured it.” |
| 4 | What we measured, and what counts | Miraj | 1:15 | “Here is what one run looks like.” |
| 5 | Gradual decline: both policies, then the demo | Susmoy | 2:00 | “Across all 18 runs, this is what we measured.” |
| 6 | No stalls to prevent, and a quality cost anyway | Miraj | 2:00 | “What did caution buy? Susmoy.” |
| 7 | What caution did buy | Susmoy | 1:30 | “Galib, what does it all add up to?” |
| 8 | The trade-off was never forced, and our limits | Galib | 1:15 | “So our answer is…” |
| 9 | Our answer | Miraj | 0:30 | — |

Total 12:00. Backup slides (trust and data freeze, pre-registered targets, why nobody stalled) stay after the answer. Rehearse twice with a timer (TEAM_ROLES §6 D6); cut words, not slides.

## Live demo (inside slide 5, about 60 s)

```bash
CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173 npm run server          # terminal 1
npm run build -w @abr-lab/player && npm run dev -w @abr-lab/player   # terminal 2
```

Open `http://127.0.0.1:4173/` in Chrome and choose **conservative-throughput-v1**, scenario **volatile-v1**, connection **Experiment server**, server URL `http://127.0.0.1:8080`. Press **Start run**. Narrate the dashboard for about 40 s: high capacity until 12 s, the drop to 1.3 Mbit/s at 12 s, back to 4.4 Mbit/s at 24 s, the severe 0.7 Mbit/s plateau at 36 s. Press **Reset** when done.

A demo started from the page is labelled `browser-player`, so it can never enter the counted dataset: the analysis counts only `runner-counted` runs.

**Run the live demo only on a server that includes PR #6.** Without that fix, the conservative policy can freeze the stream when it cancels a request at startup (it happened in 2 of 3 conservative demo recordings). If #6 is not merged by the talk, use the fallback.

## Fallback (if anything fails during the demo)

Go to the deck's demo slide (it plays the recording), or play the `.webm` files from `results/dry-run/demo/`. To re-record them:

```bash
npm run runner -- --mode demo --trace volatile-v1 --record results/dry-run/demo --player-url http://127.0.0.1:4173/
```

Demo mode needs Playwright's ffmpeg. On this machine `~/.cache/ms-playwright/ffmpeg-1013/ffmpeg-linux` links to the system ffmpeg 8 (Playwright 1.64 encodes VP9).

## Rules for what we say

- Say “observed in these three runs” and “9/9 pairs”; never “significant” or “proves”.
- Give medians with the full [min, max] range, compare pairs by repeat, and state completion as x/3.
- Present H1 as **not supported** (nobody stalled), not as a tie or a win.
- The hypotheses (slide 1) were pushed to GitHub before any counted run; do not edit them.
