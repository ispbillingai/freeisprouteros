#!/bin/sh
set -eu
PROJECT=${FREEISP_PROJECT:-$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)}
sh "$PROJECT/tools/linux/build.sh"
python3 "$PROJECT/tests/test_linux_appliance.py"
python3 "$PROJECT/tools/linux/test_vm.py"
