// Fixture: reads stdin but never writes anything, so the MCP `initialize`
// handshake never completes. Used to exercise the mcp-client 5s timeout.
process.stdin.resume();
setInterval(() => {}, 60_000).unref();
