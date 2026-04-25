# IoTMediator（USENIX Security 2023）

[English](README.md)

## 项目概览

本仓库为 USENIX Security 2023 论文的开源实现：
[Detecting and Handling IoT Interaction Threats in Multi-Platform Multi-Control-Channel Smart Homes](https://www.usenix.org/conference/usenixsecurity23/presentation/chi)。

核心流程：

1. `screen.js`：CAI/CMAI 候选生成。
2. `verification.js`：事件/命令流运行时验证。
3. `handling.js`：策略决策与执行结果（`allow` / `block`）。

## 仓库结构

- `screen.js`、`verification.js`、`handling.js`、`hooks.js`：核心逻辑。
- `evaluation/`：回放数据、模拟器与结果输出。
- `messenger/core`：运行时公共模块与数据访问。
- `messenger/connectors`：设备/平台连接器实现。
- `messenger/adapters`：适配与路由层。
- `routes/`、`views/`、`public/`、`config/`、`bin/`：Web 与服务组件。
- `index.js`：服务入口。

## 复现实验

1. 安装依赖：

```bash
npm install
```

2. 创建本地环境文件：

```bash
cp .env.example .env
```

3. 保持回放开关为关闭真实联调：

```bash
IOTMEDIATOR_REAL_INTEGRATION=false
```

4. 执行回放评估：

```bash
npm run sim:eval
```

可直接运行：

```bash
node evaluation/simulator/run-paper-eval.js
```

## 输出文件

回放结果写入 `evaluation/results`：

- `table7_replay.json`
- `table8_replay.json`
- `table9_replay.json`
- `eval_replay_summary.json`

`eval_replay_summary.json` 的 `raw_data` 使用仓库相对路径。

## 引用

```bibtex
@inproceedings{chi2023detecting,
  title={Detecting and Handling {IoT} interaction threats in multi-platform multi-control-channel smart homes},
  author={Chi, Haotian and Zeng, Qiang and Du, Xiaojiang},
  booktitle={32nd USENIX Security Symposium},
  pages={1559--1576},
  year={2023}
}
```
