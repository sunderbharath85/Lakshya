#!/bin/bash
# Stand-in for a coding CLI in tests: shows a prompt and echoes whatever is typed into it.
echo "fake agent ready ($*)" | cut -c1-60
while IFS= read -r line; do
  echo "got: $line"
  printf '> '
done
