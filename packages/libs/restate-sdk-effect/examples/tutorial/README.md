# Tutorial

Six tiers, one endpoint. Each file is a service you can call with `curl`.

```bash
# 1. start Restate (once)
docker run --rm -p 8080:8080 -p 9070:9070 ghcr.io/restatedev/restate:latest

# 2. start the tutorial endpoint
pnpm --filter @restatedev/restate-sdk-effect start:tutorial

# 3. register it
restate deployments register http://localhost:9080
```

## Tier 1 — journaled steps and concurrency (`01-basics.ts`)

```bash
curl localhost:8080/basics/hello      --json '"world"'
curl localhost:8080/basics/sequential --json '"o-1"'
curl localhost:8080/basics/parallel   --json '"o-2"'   # both steps at once
curl localhost:8080/basics/first      --json '"o-3"'   # race; loser torn down
curl localhost:8080/basics/fanOut     --json '["a","b","c","d","e"]'
```

## Tier 2 — durable time (`02-durable-time.ts`)

```bash
curl localhost:8080/time/withDeadline --json '"o-9"'
curl localhost:8080/time/withRetry    --json 'null'
# suspends for 24 hours; the process can exit and the invocation still resumes
curl localhost:8080/time/reminder     --json '"take a break"'
```

## Tier 3 — sagas (`03-saga.ts`)

```bash
curl localhost:8080/saga/process --json '{"orderId":"o-1","fail":false}'
curl localhost:8080/saga/process --json '{"orderId":"o-2","fail":true}'   # compensates
curl localhost:8080/saga/scoped  --json '"o-3"'
```

## Tier 4 — virtual-object state (`04-state.ts`)

```bash
curl localhost:8080/cart/alice/add   --json '{"sku":"book","price":12}'
curl localhost:8080/cart/alice/add   --json '{"sku":"pen","price":3}'
curl localhost:8080/cart/alice/total --json 'null'
curl localhost:8080/cart/alice/items --json 'null'
curl localhost:8080/cart/alice/clear --json 'null'
```

## Tier 5 — a workflow (`05-workflow.ts`)

```bash
# starts and waits for a decision (up to 7 days)
curl localhost:8080/approval/req-1/run/send --json '{"amount":900}'
curl localhost:8080/approval/req-1/status   --json 'null'
curl localhost:8080/approval/req-1/decide   --json 'true'
```

## Tier 6 — application services (`06-layers.ts`)

```bash
curl localhost:8080/users/lookup --json '"u-1"'
curl localhost:8080/users/lookup --json '""'    # declared domain error
```
