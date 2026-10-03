#!/bin/bash

# Smoke test for the Spare API

API_URL="${API_URL:-http://localhost:3001}"

echo "Testing the Spare API at $API_URL"
echo "====================="
echo ""

# Check if server is running
echo "1. Checking server health..."
HEALTH=$(curl -s "$API_URL/health")
if [ $? -eq 0 ] && [ -n "$HEALTH" ]; then
    echo "✅ Server is running"
    echo "   Response: $HEALTH"
else
    echo "❌ Server is not running!"
    echo "   Start the server with: npm run dev"
    exit 1
fi

echo ""
echo "2. Spare MCP tool catalog..."
CATALOG=$(curl -s "$API_URL/api/mcp/tools")
echo "$CATALOG" | python3 -c 'import json,sys; c=json.load(sys.stdin); print("   " + ", ".join(t["name"] for t in c["tools"]))' 2>/dev/null || echo "   $CATALOG"

echo ""
echo "3. Spare MCP initialize (JSON-RPC)..."
curl -s -X POST "$API_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
    | python3 -m json.tool 2>/dev/null | head -12

echo ""
echo "4. Round-up preview (no chain access)..."
curl -s "$API_URL/api/spare/roundup-preview?amountUsd=3.75&roundTo=1&multiplier=3" \
    | python3 -m json.tool 2>/dev/null || true

echo ""
echo "✅ Test complete!"
