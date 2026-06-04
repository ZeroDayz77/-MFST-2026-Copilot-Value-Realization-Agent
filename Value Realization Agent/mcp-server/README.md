# MCP Local Server

Local MCP server for testing the Copilot Value Analysis plugin.

## Setup

1. From the `mcp-server` folder, install dependencies:

```bash
npm install
```

1. Start the server:

```bash
npm start
```

The server listens on `http://localhost:3001/mcp` and supports two MCP methods:

- `tools/list` — returns the tools described in `appPackage/mcp-tools.json`
- `tools/call` — supports `analyze_copilot_value` for demo extraction

## Test example (curl)

```bash
# List tools
curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -d '{"method":"tools/list"}' | jq

# Call analyze tool
curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -d '{"method":"tools/call","params":{"name":"analyze_copilot_value","arguments":{"source_text":"seats: 200\nactive users: 80\nspend: $12,000","company_name":"Contoso"}}}' | jq
```
