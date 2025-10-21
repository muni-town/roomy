#!/bin/bash

# Mobile Safari Testing Helper Script
# This script helps you quickly test your app on a real iPhone/iPad

set -e

echo "🧪 Mobile Safari Testing Setup"
echo "================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
    echo -e "${RED}❌ ngrok is not installed${NC}"
    echo ""
    echo "Install ngrok:"
    echo "  macOS:  brew install ngrok"
    echo "  Linux:  snap install ngrok"
    echo "  Or download from: https://ngrok.com/download"
    echo ""
    exit 1
fi

echo -e "${GREEN}✓${NC} ngrok is installed"

# Check if dev server is already running
if lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Dev server is already running on port 5173"
    SERVER_RUNNING=true
else
    echo -e "${YELLOW}⚠${NC} Dev server is not running"
    echo ""
    echo "Starting dev server..."
    
    # Start dev server in background
    npm run dev &
    DEV_SERVER_PID=$!
    SERVER_RUNNING=false
    
    echo "Waiting for dev server to start..."
    sleep 5
    
    # Check if server started successfully
    if lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} Dev server started successfully"
    else
        echo -e "${RED}❌ Failed to start dev server${NC}"
        exit 1
    fi
fi

echo ""
echo "Starting ngrok tunnel..."
echo ""

# Start ngrok and capture the output
ngrok http 5173 --log=stdout > /tmp/ngrok.log &
NGROK_PID=$!

# Wait for ngrok to start and get the URL
sleep 3

# Extract the public URL from ngrok
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok-free\.dev' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo -e "${RED}❌ Failed to get ngrok URL${NC}"
    echo "Check ngrok dashboard at: http://localhost:4040"
    exit 1
fi

# Display instructions
clear
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║          🎉 Mobile Safari Testing Ready!                      ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}Public URL:${NC} ${BLUE}${NGROK_URL}${NC}"
echo ""
echo "📱 TESTING INSTRUCTIONS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1️⃣  Open Safari on your iPhone/iPad"
echo ""
echo "2️⃣  Navigate to:"
echo "    ${NGROK_URL}"
echo ""
echo "3️⃣  Test the diagnostic page:"
echo "    ${NGROK_URL}/debug"
echo ""
echo "4️⃣  Open Web Inspector (optional but recommended):"
echo "    • On iPhone: Settings → Safari → Advanced → Web Inspector (ON)"
echo "    • On Mac: Connect iPhone via USB"
echo "    • Safari → Develop → [Your iPhone] → [Page Name]"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🔍 WHAT TO CHECK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "In Safari Console (via Web Inspector or debug page):"
echo ""
echo "  crossOriginIsolated     → should be: true ✅"
echo "  SharedArrayBuffer       → should be: function ✅"
echo "  OPFS access             → should be: SUCCESS ✅"
echo "  sqliteStatus.vfsType    → should be: 'opfs-sahpool' or 'opfs' ✅"
echo "  Database operations     → should work ✅"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🧪 QUICK TEST COMMANDS (in Safari console):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  // Check isolation"
echo "  console.log('Isolated:', crossOriginIsolated);"
echo ""
echo "  // Check VFS type"
echo "  console.log('VFS:', sqliteStatus.vfsType);"
echo ""
echo "  // Test database"
echo "  await debugWorkers.testSqliteConnection();"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 MONITORING"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  • ngrok dashboard:  http://localhost:4040"
echo "  • Dev server logs:  (visible in this terminal)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop testing${NC}"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    
    # Kill ngrok
    if [ ! -z "$NGROK_PID" ]; then
        kill $NGROK_PID 2>/dev/null || true
        echo "  ✓ Stopped ngrok"
    fi
    
    # Kill dev server only if we started it
    if [ "$SERVER_RUNNING" = false ] && [ ! -z "$DEV_SERVER_PID" ]; then
        kill $DEV_SERVER_PID 2>/dev/null || true
        echo "  ✓ Stopped dev server"
    fi
    
    # Clean up log file
    rm -f /tmp/ngrok.log
    
    echo ""
    echo "✨ Cleanup complete!"
    exit 0
}

# Set trap to cleanup on script exit
trap cleanup EXIT INT TERM

# Keep script running and show dev server logs
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 DEV SERVER LOGS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Wait indefinitely
wait