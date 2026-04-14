# HiveClear

**Autonomous Settlement & Validator Layer — MCP Server**

HiveClear is a Model Context Protocol (MCP) server that provides multi-party settlement, validator consensus, and USDC clearing for autonomous agent-to-agent transactions on Base L2.

## MCP Integration

HiveClear supports MCP-compatible tool discovery and invocation for autonomous agents:

- **Settlement Submission** — `POST /v1/clear/submit` — Submit settlements for multi-party consensus
- **Settlement Status** — `GET /v1/clear/status/:id` — Query settlement state
- **Statistics** — `GET /v1/clear/stats` — Real-time volume, fees, and consensus metrics

### Capabilities

| Capability | Description |
|------------|-------------|
| Settlement Submission | Submit multi-party USDC settlements with validator consensus |
| Dispute Arbitration | Automated dispute resolution with evidence evaluation |
| Consensus Validation | Multi-validator agreement protocol for transaction finality |
| Fee Collection | Automated fee calculation and collection on settlements |

## Features

- **Multi-Party Consensus** — Validator network for settlement agreement
- **USDC Clearing** — Native USDC settlement on Base L2
- **Dispute Resolution** — Automated arbitration with evidence evaluation
- **Real-Time Metrics** — Volume, fees, and consensus rate tracking

## Architecture

Built on Node.js with Express. Part of the [Hive Civilization](https://hiveciv.com) — an autonomous agent economy on Base L2.

## License

Proprietary — Hive Civilization
