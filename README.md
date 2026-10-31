# Peek Latency Trainer

A small Babylon.js app that simulates getting peeked in an FPS: hold an angle, react when
the peeker clears the corner, and see how each player's ping, jitter, packet loss, tick
rate and interp buffer decide who wins. Everything runs in the browser. The network is
simulated, so there is no server.

**Live:** https://davidwnek.github.io/latency-trainer/

## What it tests

- **Hold & shoot:** click or tap when he appears. The round shows when the server saw him,
  your reaction time, and whether your shot reached the server first.
- **Dodge:** step behind cover instead. It shows whether you escaped, died in the open, or
  were killed behind cover because his delayed screen still showed you.
- **Questionnaire:** answer what you run into in real matches, then compare it with what
  the tests measure.
- **Measure my connection:** times real round trips from your device and copies the jitter
  into the sim.

## Run it

```bash
npm install
npm run dev
```

To try it on a phone on the same Wi-Fi, run `npm run dev -- --host` and open the Network
address it prints.

```bash
npm test
npm run build
```

## Deploy

Every push to `main` runs the tests, builds, and publishes `dist/` to GitHub Pages through
`.github/workflows/deploy.yml`.
