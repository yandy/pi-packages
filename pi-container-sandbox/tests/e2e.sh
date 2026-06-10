#!/bin/bash
# E2E tests for pi-container-sandbox v7
set -uo pipefail

WORKDIR="$(pwd)"
EXT="-e ./index.ts"
MODEL="--provider minimax-cn --model MiniMax-M3 --no-session --thinking off"
PASS=0; FAIL=0

cleanup() {
    docker ps -a --filter "name=pi-sbx-" --format '{{.Names}}' 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
    docker ps -a --filter "name=pi-test-" --format '{{.Names}}' 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
    rm -f "$WORKDIR/.pi/agent/sandbox.json"
}

check() {
    local name="$1" expected="$2" output="$3"
    if echo "$output" | grep -Eq "$expected"; then
        echo "  ✅ $name"; PASS=$((PASS + 1))
    else
        echo "  ❌ $name (want ~'$expected')"; FAIL=$((FAIL + 1))
        echo "       tail: $(echo "$output" | tail -c 400)"
    fi
}

pi_sync() {
    local prompt="$1" flags="${2:-}" t="${3:-90}"
    local out; out=$(timeout "$t" bash -c "pi $MODEL $flags $EXT '$prompt'" 2>&1) || true
    cleanup
    echo "$out"
}

# Start pi in background, wait for container, return CID (or empty)
# Uses a prompt the model will call tools for
pi_wait_container() {
    local prompt="${1:-Run bash command: sleep 30}" flags="${2:-}" wait_s="${3:-18}"
    # Start pi in background
    pi $MODEL $flags $EXT "$prompt" > /dev/null 2>&1 &
    local pid=$!
    # Poll for container
    local cid=""
    for i in $(seq 1 "$wait_s"); do
        sleep 1
        cid=$(docker ps --filter "name=pi-sbx-" --format '{{.Names}}' 2>/dev/null | head -1)
        [ -n "$cid" ] && break
    done
    # Return CID. Caller is responsible for killing PID and cleanup.
    echo "$cid"
    return 0
}

cleanup
echo "============================================"
echo " pi-container-sandbox E2E Tests v7"
echo "============================================"

# ═══ A: Image & Loading ═══
echo ""
echo "── A: Image & Loading ──"
check "A1: uid=1000"  "uid=1000"                "$(docker run --rm --entrypoint '' pi-container-sandbox:latest id 2>&1 || true)"
check "A2: ripgrep"   "ripgrep"                  "$(docker run --rm --entrypoint '' pi-container-sandbox:latest rg --version 2>&1 || true)"
check "A3: node"      "v[0-9]+\.[0-9]+\.[0-9]+" "$(docker run --rm --entrypoint '' pi-container-sandbox:latest node --version 2>&1 || true)"
check "A4: git"       "git version"              "$(docker run --rm --entrypoint '' pi-container-sandbox:latest git --version 2>&1 || true)"
timeout 10 pi $MODEL $EXT --help > /tmp/sbx-h.txt 2>&1 || true
check "A5: flags"     "container-size"           "$(cat /tmp/sbx-h.txt)"

# ═══ B: Tool Routing ═══
echo ""
echo "── B: Tool Routing ──"
check "B1: bash→uid"   "uid=1000"            "$(pi_sync 'Run bash command: id')"
check "B2: bash→/wspc" "/workspace"           "$(pi_sync 'Run bash command: pwd')"
check "B3: read→pkg"   "pi-container-sandbox" "$(pi_sync 'Read package.json, output the name field value')"

pi_sync 'Write file e2e-test.txt with content E2E_OK' > /dev/null
sleep 1
if [ -f "$WORKDIR/e2e-test.txt" ] && grep -q "E2E_OK" "$WORKDIR/e2e-test.txt" 2>/dev/null; then
    echo "  ✅ B4: write→host"; PASS=$((PASS + 1))
else
    echo "  ❌ B4: file not on host"; FAIL=$((FAIL + 1))
fi
rm -f "$WORKDIR/e2e-test.txt"

check "B5: grep"       "pi-container-sandbox" "$(pi_sync 'Run grep for name in package.json')"
check "B6: find"       "tiers|config|runtime"  "$(pi_sync 'Run find *.ts files in src/')"
check "B7: outside blk" "refusing|outside|denied|restricted" "$(pi_sync 'Read /etc/passwd')"

# ═══ P: Flags ═══
echo ""
echo "── P: Flag Tests ──"
check "P1: --noc=host" "$(whoami)" "$(pi_sync 'Run bash command: whoami' '--noc')"

# P2: --container-size small
cleanup
CID=$(pi_wait_container "Run bash command: sleep 30" "--container-size small" 18)
PID=$(jobs -p | head -1)
if [ -n "$CID" ]; then
    MEM=$(docker inspect "$CID" --format '{{.HostConfig.Memory}}' 2>/dev/null || echo "0")
    if [ "$MEM" -gt 0 ] && [ "$MEM" -le 1100000000 ]; then
        echo "  ✅ P2: small tier mem=$MEM"; PASS=$((PASS + 1))
    else
        echo "  ❌ P2: mem=$MEM (~1g)"; FAIL=$((FAIL + 1))
    fi
else
    echo "  ❌ P2: no container after 18s"; FAIL=$((FAIL + 1))
fi
kill $PID 2>/dev/null || true; cleanup; sleep 2

# ═══ C: Container State ═══
echo ""
echo "── C: Container State ──"
cleanup
CID=$(pi_wait_container "Run bash command: sleep 30" "" 18)
PID=$(jobs -p | head -1)

if [ -n "$CID" ]; then
    echo "  ✅ C1: created"; PASS=$((PASS + 1))
    check "C2: uid=1000"   "uid=1000"            "$(docker exec "$CID" id 2>&1 || true)"
    check "C3: /workspace" "/workspace"          "$(docker exec "$CID" pwd 2>&1 || true)"
    check "C4: no sock"    "No such|cannot access" "$(docker exec "$CID" sh -c 'ls /var/run/docker.sock 2>&1' 2>&1 || true)"
    check "C5: cwd mount"  "package.json"         "$(docker exec "$CID" sh -c 'ls /workspace/package.json 2>&1' | head -1)"

    CAPS=$(docker exec "$CID" sh -c 'cat /proc/1/status 2>/dev/null | grep CapEff' 2>&1) || true
    if [ -n "$CAPS" ] && echo "$CAPS" | grep -q "0000000000000000"; then
        echo "  ✅ C6: no caps"; PASS=$((PASS + 1))
    else
        echo "  ❌ C6: caps check failed ($CAPS)"; FAIL=$((FAIL + 1))
    fi

    NET=$(docker inspect "$CID" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo "?")
    if [ "$NET" != "none" ]; then
        echo "  ✅ C7: net on"; PASS=$((PASS + 1))
    else
        echo "  ❌ C7: net=$NET"; FAIL=$((FAIL + 1))
    fi
else
    echo "  ❌ C1-C7: no container"; FAIL=$((FAIL + 7))
fi
kill $PID 2>/dev/null || true; cleanup; sleep 2

# C8: --no-container-net
cleanup
CID=$(pi_wait_container "Run bash command: sleep 30" "--no-container-net" 18)
PID=$(jobs -p | head -1)
if [ -n "$CID" ]; then
    NET=$(docker inspect "$CID" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo "?")
    if [ "$NET" = "none" ]; then
        echo "  ✅ C8: --no-container-net"; PASS=$((PASS + 1))
    else
        echo "  ❌ C8: net=$NET"; FAIL=$((FAIL + 1))
    fi
else
    echo "  ❌ C8: no container"; FAIL=$((FAIL + 1))
fi
kill $PID 2>/dev/null || true; cleanup; sleep 2

# C9: /sandbox keep
cleanup
rm -f "$WORKDIR/.pi/agent/sandbox.json"
# /sandbox keep triggers session_start→container, then writes name to config
CID=$(pi_wait_container "/sandbox keep my-box" "" 18)
PID=$(jobs -p | head -1)
sleep 2
check "C9: keep→json" "my-box" "$(cat "$WORKDIR/.pi/agent/sandbox.json" 2>/dev/null || echo 'MISSING')"
kill $PID 2>/dev/null || true; cleanup; sleep 2
rm -f "$WORKDIR/.pi/agent/sandbox.json"

# C10: /sandbox tiers set
cleanup
rm -f "$WORKDIR/.pi/agent/sandbox.json"
CID=$(pi_wait_container "/sandbox tiers set large" "" 18)
PID=$(jobs -p | head -1)
sleep 2
check "C10: tiers→json" "large" "$(cat "$WORKDIR/.pi/agent/sandbox.json" 2>/dev/null || echo 'MISSING')"
kill $PID 2>/dev/null || true; cleanup; sleep 2
rm -f "$WORKDIR/.pi/agent/sandbox.json"

# ═══ Final ═══
echo ""
cleanup
[ -z "$(docker ps -a --filter 'name=pi-sbx-' -q 2>/dev/null)" ] && { echo "  ✅ no leftovers"; PASS=$((PASS + 1)); } || { echo "  ❌ leftovers"; FAIL=$((FAIL + 1)); }
echo ""
echo "============================================"
echo " $PASS passed, $FAIL failed"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
