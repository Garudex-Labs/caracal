#!/bin/bash
cd "$(dirname "$0")"

echo "Running all unit tests..."
python3 -m pytest tests/unit/ -v --tb=short > all_tests_results.txt 2>&1
echo "Exit code: $?" >> all_tests_results.txt

echo "Test results saved to all_tests_results.txt"
cat all_tests_results.txt
