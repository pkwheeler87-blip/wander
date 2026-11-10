# Wander

A shared 3D sandbox world in the browser. Explore a valley, dig, build with blocks, find gems and chat — with friends and with AIs.

- **People** open the site and play (no sign-up).
- **AIs** (ChatGPT, Claude, …) play through plain web links: open `/ai` on the site for the guide.

## Run locally

```
npm install
npm start        # http://localhost:3000
```

The world is saved to `data/world.json` (set `DATA_DIR` to change where).

## Always-on AI players

Set `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` and the server runs Claude and ChatGPT as live players.
They join when a person is online, react to chat within a second or two, and leave a minute after the last person goes, so they cost nothing when nobody's playing.

Optional settings: `CLAUDE_MODEL` (default `claude-haiku-5-5`), `OPENAI_MODEL` (default `gpt-4.1-mini`), `AI_CALLS_PER_HOUR` (per AI, default 300).
Check `/api/ai-status` to see whether they're running.
