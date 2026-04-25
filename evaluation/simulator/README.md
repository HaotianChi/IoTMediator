# Evaluation Simulator

This folder provides the minimal replay path for evaluation:

1. load fixed raw logs from `evaluation/data`,
2. replay raw logs through runtime hooks,
3. collect verification/handling outputs.

## Files

- `run-paper-eval.js`  
  Replay raw data and compute replay metrics.
- `run-suite.js`  
  Shared scenario replay engine.

## Usage

Replay and evaluate:

```bash
npm run sim:eval
```

Replay from default raw logs:

```bash
node evaluation/simulator/run-paper-eval.js
```

## Output

Replay results:

- `evaluation/results/table7_replay.json`
- `evaluation/results/table8_replay.json`
- `evaluation/results/table9_replay.json`
- `evaluation/results/eval_replay_summary.json`
