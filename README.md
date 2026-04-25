# IoTMediator (USENIX Security 2023)

[中文说明 (Chinese)](README.zh.md)

## Overview

This repository contains the IoTMediator implementation from the USENIX Security 2023 paper:
[Detecting and Handling IoT Interaction Threats in Multi-Platform Multi-Control-Channel Smart Homes](https://www.usenix.org/conference/usenixsecurity23/presentation/chi).

The core runtime pipeline follows the paper overview:

1. `screen.js`: static candidate generation for CAI/CMAI from rules and devices.
2. `verification.js`: runtime pattern verification over event/command streams.
3. `handling.js`: mitigation decision and enforcement (`allow` / `block`).

`hooks.js` provides the unified stream hook that connects device/platform events to the verification and handling pipeline.

## Current Project Structure

The current codebase is organized as:

- `index.js`: runtime entry point for service mode.
- `hooks.js`, `screen.js`, `verification.js`, `handling.js`: core detection and handling logic.
- `messenger/core`: shared runtime data and utility modules.
- `messenger/connectors`: device/platform-facing connector implementations.
- `messenger/adapters`: platform adapter/router layer used by `index.js`.
- `routes`, `views`, `public`, `config`, `bin`: web and server runtime components.
- `evaluation`: paper-oriented replay and benchmark scripts/data.

### `messenger` Layer Mapping

To match the paper-style architecture view:

- `messenger/core` maps to mediator internal state and shared services.
- `messenger/connectors` maps to device/platform integration endpoints.
- `messenger/adapters` maps to adapter/router boundaries exposed to platforms.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Add local environment configuration:

```bash
cp .env.example .env
```

3. Default behavior is replay evaluation only. Keep the following switch as `false` in `.env`:

```bash
IOTMEDIATOR_REAL_INTEGRATION=false
```

4. Run paper replay evaluation:

```bash
npm run sim:eval
```

To enable real connector routes and device/platform integration, set:

```bash
IOTMEDIATOR_REAL_INTEGRATION=true
```

and fill the optional credentials in `.env`.

## Evaluation

The evaluation flow replays fixed logs from `evaluation/data` through:

`hooks -> verification -> handling`

Outputs are written to `evaluation/results`:

- `evaluation/results/table7_replay.json`
- `evaluation/results/table8_replay.json`
- `evaluation/results/table9_replay.json`
- `evaluation/results/eval_replay_summary.json`

`eval_replay_summary.json` stores `raw_data` as repository-relative paths for cross-machine reproducibility.

Direct runner:

```bash
node evaluation/simulator/run-paper-eval.js
```

## Notes

- Real integrations use `index.js` + `messenger/connectors` + `messenger/adapters`.
- Real connector behavior was last validated in 2023; API compatibility with newer platform versions is not guaranteed.

## Citation

If this repository is helpful for your research, please cite:

```bibtex
@inproceedings{chi2023detecting,
  title={Detecting and Handling {IoT} interaction threats in multi-platform multi-control-channel smart homes},
  author={Chi, Haotian and Zeng, Qiang and Du, Xiaojiang},
  booktitle={32nd USENIX Security Symposium},
  pages={1559--1576},
  year={2023}
}
```
