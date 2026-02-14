#!/bin/bash

# Ensure test results directory exists
OUTPUT_DIR="tests/test-results"
mkdir -p "$OUTPUT_DIR"

# Generate timestamp for log filename
TIMESTAMP=$(date +"%Y-%m-%d-%H%M%S")
LOG_FILE="$OUTPUT_DIR/$TIMESTAMP.txt"

echo "Running tests and logging to $LOG_FILE"

# Run tests, pipe to stdout (for user to see) and capture to a temp file
TEMP_LOG="$OUTPUT_DIR/temp_raw_output.txt"
bun test tests/ 2>&1 | tee "$TEMP_LOG"

# Post-process the log: filter out [eval] lines and the specific header
# preserving only the final results and other test output
grep -v "\[eval\]" "$TEMP_LOG" | grep -v "=== Intent Detection Evaluation ===" > "$LOG_FILE"

# Clean up
rm "$TEMP_LOG"
