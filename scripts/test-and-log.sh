#!/bin/bash

# Ensure test results directory exists
OUTPUT_DIR="tests/test-results"
mkdir -p "$OUTPUT_DIR"

# Generate timestamp for log filename
TIMESTAMP=$(date +"%Y-%m-%d-%H%M%S")
LOG_FILE="$OUTPUT_DIR/$TIMESTAMP.txt"

echo "Running tests and logging to $LOG_FILE"

# Run tests and pipe output to both console and file
# redirect stderr to stdout so we capture errors too
bun test tests/ 2>&1 | tee "$LOG_FILE"

# Extract just the relevant metrics if needed, or keep the whole log
# For now, keeping the whole log is safer for debugging.
