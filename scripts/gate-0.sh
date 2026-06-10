#!/usr/bin/env bash
set +e

mkdir -p gates

synth_out="$(mktemp)"
ls_out="$(mktemp)"
test_out="$(mktemp)"

npx cdk synth >"$synth_out" 2>&1
synth_status=$?

npx cdk ls >"$ls_out" 2>&1
ls_status=$?

npm test >"$test_out" 2>&1
test_status=$?

mapfile -t stacks < <(grep -E '^launchtest-staging-(core|api|edge)$' "$ls_out")
stack_count="${#stacks[@]}"

stacks_json="["
for i in "${!stacks[@]}"; do
  if [[ "$i" -gt 0 ]]; then
    stacks_json+=","
  fi
  stacks_json+="\"${stacks[$i]}\""
done
stacks_json+="]"

pass_synth=false
pass_stacks=false
pass_test=false
overall=false

[[ "$synth_status" -eq 0 ]] && pass_synth=true
[[ "$stack_count" -eq 3 ]] && pass_stacks=true
[[ "$test_status" -eq 0 ]] && pass_test=true
if [[ "$pass_synth" == true && "$pass_stacks" == true && "$pass_test" == true ]]; then
  overall=true
fi

cat > gates/gate-0.json <<JSON
{
  "gate": 0,
  "checks": [
    {
      "name": "cdk synth exits 0",
      "expected": "0",
      "actual": "$synth_status",
      "pass": $pass_synth
    },
    {
      "name": "stack count via cdk ls",
      "expected": "3",
      "actual": "$stack_count",
      "pass": $pass_stacks
    },
    {
      "name": "npm test exits 0",
      "expected": "0",
      "actual": "$test_status",
      "pass": $pass_test
    }
  ],
  "stacks": $stacks_json,
  "diagnostics": {
    "cdkLsStatus": $ls_status
  },
  "pass": $overall
}
JSON

cat gates/gate-0.json

rm -f "$synth_out" "$ls_out" "$test_out"

if [[ "$overall" != true ]]; then
  exit 1
fi
