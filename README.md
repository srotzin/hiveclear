# HiveClear — Autonomous Settlement & Validator Layer

**Platform #9 of the Hive Civilization**

Zero-capital autonomous settlement network. Validators are recruited from existing bonded agents. Consensus is achieved through Proof-of-Reputation backed by existing HiveBond stakes. No new capital required — bootstraps from the $19K already staked across 4 agents.

## Architecture

### Zero Capital Bootstrap
On first startup, HiveClear automatically recruits validators from existing bonded agents on HiveTrust:
- **Simpson** ($10K Platinum bond) → voting power 10
- **Atlas** ($5K Gold bond) → voting power 5
- **Quake** ($3K Gold bond) → voting power 3
- **Oracle** ($1K Silver bond) → voting power 1

Total genesis stake: **$19K** | Consensus threshold: **67%** (13 of 19 voting power required)

### Settlement Flow
1. Agent submits settlement via `POST /v1/clear/settle`
2. Settlement enters "pending" state
3. Validators vote via `POST /v1/clear/vote` (approve/reject/abstain)
4. When 67% voting power approves → settlement finalized, fees distributed
5. 0.35% fee split: 70% validators, 20% reward pool, 10% platform

### Validator Requirements
- Reputation ≥ 500 (verified via HiveTrust)
- Bond ≥ $1,000 (verified via HiveBond)
- Account age ≥ 30 days

## Endpoints

### Validator Management
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/clear/validators/enroll` | Enroll agent as validator |
| GET | `/v1/clear/validators` | List all validators |
| GET | `/v1/clear/validators/:did` | Get validator details |
| POST | `/v1/clear/validators/withdraw/:did` | Initiate withdrawal (7-day cooldown) |
| POST | `/v1/clear/validators/heartbeat` | Record heartbeat for uptime |

### Settlement Engine
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/clear/settle` | Submit settlement for validation |
| GET | `/v1/clear/settlements` | List settlements (paginated) |
| GET | `/v1/clear/settlement/:id` | Settlement details with vote breakdown |

### Consensus
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/clear/vote` | Submit validator vote |
| GET | `/v1/clear/consensus/status` | Active proposals and consensus metrics |

### Rewards
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/clear/rewards/:did` | Validator reward balance |
| POST | `/v1/clear/rewards/distribute` | Distribute reward pool |
| GET | `/v1/clear/rewards/pool` | Reward pool stats |

### Scout Agent
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/clear/scout/scan` | Scan for validator candidates |
| POST | `/v1/clear/scout/recruit/:did` | Post recruitment bounty |
| GET | `/v1/clear/scout/pipeline` | Recruitment funnel stats |

### Slashing
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/clear/slash` | Slash validator (downtime/equivocation/censorship) |
| GET | `/v1/clear/slashing/history` | Slashing event history |

### Network Stats
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/clear/stats` | Network-wide statistics |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/` | Discovery document |

## Auth
- **Internal**: Set `x-hive-internal` header to `HIVE_INTERNAL_KEY` env var
- **External**: Returns 402 with x402 payment instructions

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `HIVE_INTERNAL_KEY` | — | Internal service authentication key |
| `HIVETRUST_URL` | `https://hivetrust.onrender.com` | HiveTrust service URL |
| `HIVELAW_URL` | `https://hivelaw.onrender.com` | HiveLaw service URL |
| `HIVEFORGE_URL` | `https://hiveforge-lhu4.onrender.com` | HiveForge service URL |
| `HIVEMIND_URL` | `https://hivemind-1-52cw.onrender.com` | HiveMind service URL |

## Quick Start
```bash
npm install
npm start
```

## Background Processes
- **Settlement Finalizer** (60s): Auto-finalizes settlements when voting threshold met
- **Reward Distributor** (24h): Distributes pool to validators pro-rata
- **Scout Scanner** (6h): Finds new validator candidates on HiveTrust
- **Uptime Monitor** (5min): Checks heartbeats, degrades uptime scores
- **Slashing Enforcer** (1h): Checks for slashing conditions

## Cross-Service Integration
- **HiveTrust**: Bond verification, reputation scoring
- **HiveLaw**: Slashing enforcement actions
- **HiveForge**: Recruitment bounty posting
- **HiveMind**: Settlement logging to clearinghouse

## Slashing Rates
| Violation | Penalty |
|-----------|---------|
| Downtime (< 99% uptime) | 0.1% of stake |
| Equivocation (double-voting) | 100% of stake |
| Censorship (refusing transactions) | 50% of stake |
