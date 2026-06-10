#!/usr/bin/env bash
set -euo pipefail

mkdir -p gates

dist_url="${DIST_URL:-https://d12p64mor0h8l0.cloudfront.net}"
bucket="${SITE_BUCKET:-launchtest-staging-site-109734929935}"
waf_name="${WAF_NAME:-launchtest-staging-waf}"
waf_id="${WAF_ID:-8c9256bb-b018-482a-8257-d3496a6f90c0}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check_json='[]'
add_check() {
  local name="$1" expected="$2" actual="$3" pass="$4"
  check_json="$(jq \
    --arg name "$name" \
    --arg expected "$expected" \
    --arg actual "$actual" \
    --argjson pass "$pass" \
    '. + [{name:$name, expected:$expected, actual:$actual, pass:$pass}]' <<<"$check_json")"
}

curl_probe() {
  local url="$1" out="$2"
  curl -ksS -L -o "$out.body" -D "$out.headers" -w '%{http_code} %{content_type}' "$url"
}

root_actual="$(curl_probe "$dist_url/" "$tmp/root")"
root_status="${root_actual%% *}"
root_type="${root_actual#* }"
add_check "GET dist /" "200 text/html" "$root_status $root_type" "$([[ "$root_status" == "200" && "$root_type" == *text/html* ]] && echo true || echo false)"

spa_actual="$(curl_probe "$dist_url/some/spa/route" "$tmp/spa")"
spa_status="${spa_actual%% *}"
add_check "GET dist /some/spa/route" "200" "$spa_status" "$([[ "$spa_status" == "200" ]] && echo true || echo false)"

s3_actual="$(curl_probe "https://${bucket}.s3.us-east-1.amazonaws.com/index.html" "$tmp/s3")"
s3_status="${s3_actual%% *}"
add_check "direct S3 URL" "403" "$s3_status" "$([[ "$s3_status" == "403" ]] && echo true || echo false)"

health_actual="$(curl_probe "$dist_url/v1/healthz" "$tmp/health")"
health_status="${health_actual%% *}"
health_body="$(cat "$tmp/health.body")"
add_check "dist /v1/healthz" "200 JSON" "$health_status $health_body" "$([[ "$health_status" == "200" && "$health_body" == *'{'* ]] && echo true || echo false)"

items_actual="$(curl_probe "$dist_url/v1/items" "$tmp/items")"
items_status="${items_actual%% *}"
items_body="$(cat "$tmp/items.body")"
add_check "dist /v1/items no token" "401 JSON, not 200 HTML" "$items_status $items_body" "$([[ "$items_status" == "401" && "$items_body" == *'{'* && "$items_body" != *'<html'* ]] && echo true || echo false)"

waf_json="$(aws wafv2 get-web-acl --scope CLOUDFRONT --region us-east-1 --name "$waf_name" --id "$waf_id" --output json)"
rule_count="$(jq '.WebACL.Rules | length' <<<"$waf_json")"
add_check "wafv2 get-web-acl rule count" "4" "$rule_count" "$([[ "$rule_count" == "4" ]] && echo true || echo false)"

pass="$(jq 'all(.[]; .pass == true)' <<<"$check_json")"
jq -n \
  --argjson gate 5 \
  --arg distUrl "$dist_url" \
  --arg bucket "$bucket" \
  --arg wafName "$waf_name" \
  --arg wafId "$waf_id" \
  --argjson checks "$check_json" \
  --argjson pass "$pass" \
  '{gate:$gate, distributionUrl:$distUrl, siteBucket:$bucket, waf:{name:$wafName,id:$wafId}, checks:$checks, pass:$pass}' | tee gates/gate-5.json

[[ "$pass" == "true" ]]
