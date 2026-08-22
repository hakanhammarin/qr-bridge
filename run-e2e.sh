#!/bin/bash
pids=(); for i in 0 1 2 3 4 5 6 7 8 9; do node --max-old-space-size=1400 test-e2e.js $i > /tmp/e2e$i.log 2>&1 & pids+=($!); done
rc=0; for pid in "${pids[@]}"; do wait $pid || rc=1; done
echo "scenario                            frames  drop%  read%  px/mod  crcRej  complete  bytes-match  root-ok"
echo "--------------------------------------------------------------------------------------------------"
cat /tmp/e2e{0,1,2,3,4,5,6,7,8,9}.log
exit $rc
