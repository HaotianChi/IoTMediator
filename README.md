# IoTMediator (USENIX Security 2023)

[中文说明 (Chinese)](README.zh.md)

## Overview

IoTMediator is the open-source code release for the USENIX Security 2023 paper:
[Detecting and Handling IoT Interaction Threats in Multi-Platform Multi-Control-Channel Smart Homes](https://www.usenix.org/conference/usenixsecurity23/presentation/chi).

Core pipeline:

1. `screen.js`: candidate generation for CAI/CMAI.
2. `verification.js`: runtime verification on event/command streams.
3. `handling.js`: policy decision and enforcement result (`allow` / `block`).

## Repository Layout

- `screen.js`, `verification.js`, `handling.js`, `hooks.js`: core logic.
- `evaluation/`: replay datasets, simulators, and result files.
- `messenger/core`: shared runtime utilities and data access.
- `messenger/connectors`: platform/device connector implementations.
- `messenger/adapters`: adapter/router layer.
- `routes/`, `views/`, `public/`, `config/`, `bin/`: web/service runtime components.
- `index.js`: service entry.

## Reproduction

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Keep replay mode enabled:

```bash
IOTMEDIATOR_REAL_INTEGRATION=false
```

4. Run replay evaluation:

```bash
npm run sim:eval
```

Direct runner:

```bash
node evaluation/simulator/run-paper-eval.js
```

## Outputs

Replay outputs are written to `evaluation/results`:

- `table7_replay.json`
- `table8_replay.json`
- `table9_replay.json`
- `eval_replay_summary.json`

`eval_replay_summary.json` records `raw_data` with repository-relative paths.

## Citation

```bibtex
@inproceedings{chi2023detecting,
  title={Detecting and Handling {IoT} interaction threats in multi-platform multi-control-channel smart homes},
  author={Chi, Haotian and Zeng, Qiang and Du, Xiaojiang},
  booktitle={32nd USENIX Security Symposium},
  pages={1559--1576},
  year={2023}
}
```
