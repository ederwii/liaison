#!/bin/bash
# Prints the shell alias lines for this engine. Usage: aliases.sh <supervised|unattended>
# ./setup wraps the output in a "# liaison start" / "# liaison end" block in the user's shell rc.
mode="${1:-supervised}"
echo "alias claude3='CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 claude'"
echo "alias claude5='CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 claude'"
if [ "$mode" = "unattended" ]; then
  echo "alias liaison-coordinator='CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 claude --dangerously-skip-permissions'"
fi
