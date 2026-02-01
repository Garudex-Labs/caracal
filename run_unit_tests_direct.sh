#!/bin/bash
cd "$(dirname "$0")"

echo "Running unit tests directly..."
python3 -m pytest tests/unit/ -v --tb=short 2>&1 | tee unit_tests_output.txt
