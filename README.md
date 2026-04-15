# HiveClear — Multi-Party Settlement — MCP Server

HiveClear is an MCP server for multi-party settlement with validator consensus. It coordinates USDC settlements between multiple parties, using a network of validators that vote to approve, reject, or dispute each transaction. Settlements are finalized when 67% of total voting power approves.

## MCP Tools

| Tool | Description |
|------|-------------|
| `hiveclear_submit_settlement` | Submit a settlement for multi-party validator consensus. Accepts an array of parties (DID, role, amount), settlement type, and optional memo. |
| `hiveclear_get_status` | Get the current status of a settlement by ID, including vote breakdown from each validator. |
| `hiveclear_get_stats` | Get clearing network statistics: volume today, fees today, consensus approval rate, and total settlement count. |
| `hiveclear_list_validators` | List all active validators in the consensus network with voting power, bond amount, uptime, and earnings. |

## Usage

Send JSON-RPC 2.0 requests to the `/mcp` endpoint:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "hiveclear_get_stats",
    "arguments": {}
  }
}
```

### Settlement Flow

1. **Submit** a settlement with two or more parties via `hiveclear_submit_settlement`
2. Validators vote to approve or reject (67% threshold required)
3. **Check status** with `hiveclear_get_status` to see vote progress and final outcome
4. Approved settlements have fees distributed: 70% to validators, 20% to reward pool, 10% to platform

## Running

```bash
npm install
npm start
```

The server listens on port 3001 by default (`PORT` env var to override).

## License

Proprietary
