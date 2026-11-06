#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs. All Rights Reserved.
# Real distributed contracts and upgrade/restart checks in an installed kind chart.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
context="$(kubectl config current-context)"
if [[ "${CARACAL_VERIFY_DISPOSABLE:-}" != yes || "$context" != kind-caracal-* ]]; then
    echo 'error: requires CARACAL_VERIFY_DISPOSABLE=yes and a kind-caracal-* context' >&2
    exit 1
fi
namespace="${CARACAL_VERIFY_NAMESPACE:-caracal}"
release="${CARACAL_VERIFY_RELEASE:-caracal}"
work="$(mktemp -d)"
pids=()
k() { kubectl -n "$namespace" "$@"; }
stopForwards() {
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
    pids=()
}
cleanup() {
    stopForwards
    k delete pod,service verification-upstream --ignore-not-found >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

image="$(node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parse} from 'yaml'; console.log(parse(readFileSync('infra/docker/docker-compose.yml','utf8')).services.replayVolumeInit.image)")"
node --input-type=module - "$image" "$namespace" "$work/upstream.json" <<'JS'
import {writeFileSync} from 'node:fs';
const [image,namespace,file] = process.argv.slice(2);
writeFileSync(file,JSON.stringify({apiVersion:'v1',kind:'Pod',metadata:{name:'verification-upstream',namespace,labels:{run:'verification-upstream'}},spec:{automountServiceAccountToken:false,securityContext:{runAsNonRoot:true,runAsUser:65532,runAsGroup:65532,fsGroup:65532,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'upstream',image,command:['sh','-c','mkdir -p /tmp/www; echo verified > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www'],securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},resources:{requests:{cpu:'10m',memory:'16Mi'},limits:{cpu:'100m',memory:'64Mi'}},volumeMounts:[{name:'scratch',mountPath:'/tmp'}],readinessProbe:{httpGet:{path:'/',port:8080},periodSeconds:1}}],volumes:[{name:'scratch',emptyDir:{medium:'Memory',sizeLimit:'16Mi'}}]}}),{mode:0o600});
JS
k apply -f "$work/upstream.json"
k expose pod verification-upstream --port=8080
k wait --for=condition=Ready pod/verification-upstream --timeout=180s

# Presence of a private test upstream is explicitly scoped to this disposable
# chart; production egress defaults and admission policy are not weakened.
node --input-type=module - "$namespace" "$work/egress.json" <<'JS'
import {writeFileSync} from 'node:fs';
const [namespace,file] = process.argv.slice(2);
const extraEnv = [{name:'CARACAL_PRIVATE_EGRESS_HOSTS',value:`verification-upstream.${namespace}.svc.cluster.local`}];
writeFileSync(file,JSON.stringify({networkPolicy:{extraEgress:[{to:[{podSelector:{matchLabels:{run:'verification-upstream'}}}],ports:[{protocol:'TCP',port:8080}]}]},services:Object.fromEntries(['api','sts','gateway'].map(name=>[name,{extraEnv}]))}),{mode:0o600});
JS
helm upgrade "$release" infra/helm/caracal -n "$namespace" --reuse-values -f "$work/egress.json" --wait --wait-for-jobs --timeout=8m

secret="$(helm get values "$release" -n "$namespace" -o json | node -e 'let x="";process.stdin.on("data",c=>x+=c).on("end",()=>console.log(JSON.parse(x).secrets?.runtimeSecretName??"caracal-runtime"))')"
k get secret "$secret" -o jsonpath='{.data.caracalAdminToken}' | base64 --decode > "$work/admin-token"

forward() {
    local name="$1" target="$2" log="$work/$1.forward.log"
    kubectl -n "$namespace" port-forward "service/${release}-caracal-${name}" ":${target}" --address=127.0.0.1 >"$log" 2>&1 &
    pids+=("$!")
    for _ in $(seq 1 60); do
        if grep -q 'Forwarding from' "$log"; then
            sed -n 's/Forwarding from 127.0.0.1:\([0-9]*\).*/http:\/\/127.0.0.1:\1/p' "$log" | head -1
            return
        fi
        sleep 0.5
    done
    cat "$log" >&2
    return 1
}
contract() {
    # Do not use command substitution for forward(): its PID must remain in the
    # parent shell's cleanup list, and a new Pod needs a new port-forward.
    stopForwards
    forward api 3000 > "$work/api-url"
    forward coordinator 4000 > "$work/coordinator-url"
    forward sts 8080 > "$work/sts-url"
    forward gateway 8081 > "$work/gateway-url"
    forward web 3002 > "$work/web-url"
    curl -fsS --max-time 8 "$(cat "$work/web-url")/ready" >/dev/null
    curl -fsS --max-time 8 "$(cat "$work/web-url")/" >/dev/null
    CARACAL_API_URL="$(cat "$work/api-url")" \
    CARACAL_COORDINATOR_URL="$(cat "$work/coordinator-url")" \
    CARACAL_STS_URL="$(cat "$work/sts-url")" \
    CARACAL_GATEWAY_URL="$(cat "$work/gateway-url")" \
    CARACAL_E2E_UPSTREAM_URL="http://verification-upstream.${namespace}.svc.cluster.local:8080" \
    CARACAL_ADMIN_TOKEN_FILE="$work/admin-token" node tests/typescript/e2e/protected-resource.mjs
}
contract
for kind in deployment statefulset; do
    k rollout restart "$kind" -l app.kubernetes.io/part-of=caracal
    while read -r object; do k rollout status "$object" --timeout=180s; done < <(k get "$kind" -l app.kubernetes.io/part-of=caracal -o name)
done
contract
helm upgrade "$release" infra/helm/caracal -n "$namespace" --reuse-values --wait --wait-for-jobs --timeout=8m
contract
echo 'helm distributed contract, persistent replay workload restarts, and same-version upgrade passed'
