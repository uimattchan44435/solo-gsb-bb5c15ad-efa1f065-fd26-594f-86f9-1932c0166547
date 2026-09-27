# verifiable-draw

可验证的公开抽签 API：承诺-揭示（commit-reveal）协议 + 基于 SHA-256 拒绝采样的 Fisher-Yates 洗牌，保证中奖顺序**无偏、可复算、可审计**。当前版本（**v3 协议**）以**有序分组名额**建模：创建抽签时提交 `groups`（每组含唯一 `name`、非空且全局不重复的 `candidates`、不超过本组人数的非负 `quota`，总名额至少 1），承诺把**组名、组顺序、各组归属候选与 quota** 全部绑进快照——任何一项改动都会使校验失败；揭示后每组独立洗牌，返回各组的顺序与中奖者。**已揭示的 v3 抽签支持中奖者放弃与候补递补**：每次放弃在事务中追加一条带序号的事件，按该组洗牌顺序选首位未中奖且未放弃者递补（候补耗尽则名额空缺），事件日志可重放审计。支持两种熵来源：

- **单 nonce 模式**（兼容旧流程）：调用方揭示一次公共 nonce。
- **多人承诺模式**：创建抽签时声明参与者名单，每人先提交 `SHA-256(secret)` 承诺、再揭示 secret；全部揭示后，服务端按**固定参与者顺序**拼接各人 secret 的哈希作为 nonce。任一方都无法单独左右结果，整条贡献链可审计。

v1 / v2 旧记录（扁平 `candidates`/`count`）升级后**继续可查可验**，校验时按记录持久化的协议版本自动选择对应算法；放弃/递补仅适用于 v3 抽签，v1/v2 记录开奖即终态。

技术栈：Node.js 24 + Fastify 5 + SQLite（Node 内置 `node:sqlite`，零原生依赖）。

## 一键启动（Docker Compose）

单条命令构建并启动（首次启动自动建表，无需手动迁移）：

```bash
docker compose up --build
```

服务地址：**http://localhost:3000** （容器映射端口 `3000:3000`）。旧版数据库在启动时自动逐级迁移：

- v0 → v1：重建 `draws` 表以支持多人承诺阶段；
- v1 → v2：`draws` 表增加 `protocol_version` / `snapshot_digest` 两列；
- v2 → v3：`draws` 表增加 `groups` 列（v3 分组定义 JSON），旧行该列为空，仍按其原版本（v1/v2）验证，**可查可验不受影响**；
- v3 → v4：新增 `forfeit_events` 表（v3 已揭示抽签的放弃/递补事件日志），既有抽签与结果不受影响。

常用命令：

```bash
docker compose up --build -d   # 后台运行
docker compose ps              # 查看状态（含 healthcheck）
docker compose logs -f app     # 跟踪日志
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除抽签数据
```

健康检查：`GET http://localhost:3000/health` → `{"status":"ok"}`。

不使用容器时：`npm ci && npm start`（需 Node.js ≥ 22.13），同样监听 **http://localhost:3000**。

## 配置（环境变量，均有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_PATH` | 容器内 `/app/data/draws.db`，本地 `./data/draws.db` | SQLite 文件路径 |

SQLite 数据通过 compose 的命名卷 `draw-data` 持久化。

## 抽签流程

### 创建：有序分组名额

创建时提交**有序** `groups`：

```jsonc
{
  "groups": [
    { "name": "red",       "quota": 2, "candidates": ["alice", "bob", "carol"] },
    { "name": "blue",      "quota": 1, "candidates": ["dave", "erin"] },
    { "name": "observers", "quota": 0, "candidates": ["frank", "grace"] }
  ]
}
```

约束（违反任一项返回 `400`）：

- 至少 1 个组；`name` 非空且**组名唯一**；
- 每组 `candidates` **非空**，候选名非空，组内不重复且**全局不重复**（同一候选不能出现在多组）；
- `quota` 为非负整数，且 **quota ≤ 该组候选人数**；
- 所有组的 **quota 总和至少为 1**（允许个别组 quota 为 0，这些组照常洗牌但不产出中奖者）。

服务端生成 32 字节随机 seed，按组序构造 v3 快照摘要，**只返回** `version`、`snapshotDigest` 与 `commitment = SHA-256("v3:<seed>:<snapshotDigest>")`，seed 在揭示前不会出现在任何响应中。

### 单 nonce 模式（默认）

1. **创建（承诺）**：提交 `groups`（不传 `participants`）。
2. **揭示**：调用方提交一次 `nonce`（仅一次，重复提交返回 409）。服务端在**同一事务**（`BEGIN IMMEDIATE`）中锁定该抽签、落库 nonce、揭示 seed，并对**每一组**用该组独立的随机流执行拒绝采样 Fisher-Yates，持久化各组顺序与中奖者。
3. **校验**：任何人用「版本 + 承诺 + seed + nonce + groups」即可独立重算承诺与每组结果；v3 承诺把组名、组顺序、归属候选与 quota 全部绑进快照。

### 多人承诺模式（熵汇聚）

创建抽签时额外声明 `participants`（2–100 人，名单去重，顺序即后续 nonce 的拼接顺序），随后分两个阶段进行，所有写操作都在 `BEGIN IMMEDIATE` 事务内锁定抽签并**拒绝重复或越序操作**：

1. **承诺阶段（`pending → committed`）**：每位参与者调用
   `POST /draws/:id/participants/:name/commitment` 提交 `commitment = SHA-256(secret)`（64 位小写 hex）。第一个承诺落地后抽签进入 `committed` 阶段；同一参与者重复承诺返回 `409`；未声明的名字返回 `400`。承诺与揭示均允许乱序到达。
2. **揭示阶段（`committed → revealed`）**：
   - 只要还有参与者未承诺，任何揭示都会被拒绝（`409`，响应里给出 `waitingFor` 名单）。
   - 参与者调用 `POST /draws/:id/participants/:name/reveal` 提交 secret，服务端校验 `SHA-256(secret)` 与其承诺一致（不一致返回 `409`），重复揭示返回 `409`。
   - **最后一个揭示在同一事务内**：按创建时的固定参与者顺序拼接 `SHA-256(secret_i)` 得到 nonce（每段固定 64 hex，无分隔符、无歧义），对每组复用同一套洗牌算法算出结果并落库、揭示 seed。
3. **审计**：完成后的响应（及 `GET /draws/:id`）包含 `contributions` 列表——每位参与者的位置、承诺、secret、secret 哈希与两个时间戳。任何人都能用它重新拼出 nonce，再通过 `/verify` 独立复算。

### 放弃与递补（仅已揭示的 v3 抽签）

揭示之后，任何**当前有效中奖者**都可以放弃名额，服务端按确定性规则递补：

1. **提交放弃**：`POST /draws/:id/forfeits`，请求体 `{"group": "<组名>", "candidate": "<候选名>"}`。只有该组**当前有效**中奖者能放弃（原始中奖者或已递补上任者）；从未中奖、已放弃或他组候选一律 `409`。
2. **事务内追加事件**：每次放弃在 `BEGIN IMMEDIATE` 事务中向 `forfeit_events` 追加一条带**连续序号**（每抽签从 1 开始）的事件，记录组名、放弃者、递补者与时间戳；并发放弃不会交错。
3. **确定性递补**：递补者为该组**洗牌顺序中首位从未中奖且未放弃**的候选；候补耗尽时递补者为 `null`，该名额**空缺**。
4. **查询与审计**：`GET /draws/:id` 同时返回原始开奖结果（每组 `order`/`winners`）、当前有效中奖名单（每组 `effectiveWinners`，按名额槽位对齐，`null` 表示空缺）与放弃递补事件（`forfeits`，按序号排列）；`GET /draws/:id/verify` 按事件顺序**重放**整条日志，发现非当前中奖者放弃、跳过更靠前候补或重复递补即判定不一致。

v1/v2 旧记录开奖即终态，不提供放弃接口（调用返回 `409`）。

## API

### 1. 创建抽签（v3 分组）

```bash
curl -X POST http://localhost:3000/draws \
  -H 'content-type: application/json' \
  -d '{"groups":[
        {"name":"red","quota":2,"candidates":["alice","bob","carol"]},
        {"name":"blue","quota":1,"candidates":["dave","erin"]}
      ]}'
```

```json
{ "drawId": "bde4b5b9-…", "mode": "single", "status": "pending", "version": "v3",
  "commitment": "9a34e8f9…", "snapshotDigest": "3e93e0a1…",
  "groups": [ { "name": "red", "quota": 2, "candidates": ["alice", "bob", "carol"], "candidateCount": 3 },
              { "name": "blue", "quota": 1, "candidates": ["dave", "erin"], "candidateCount": 2 } ],
  "groupCount": 2, "totalQuota": 3, "candidateCount": 5, "createdAt": "…" }
```

### 2. 揭示（nonce 只能提交一次）

```bash
curl -X POST http://localhost:3000/draws/<drawId>/reveal \
  -H 'content-type: application/json' \
  -d '{"nonce":"public-input-2026-09-27"}'
```

```jsonc
{ "drawId": "…", "status": "revealed", "version": "v3", "commitment": "9a34e8f9…",
  "snapshotDigest": "3e93e0a1…", "seed": "bf723339…", "nonce": "public-input-2026-09-27",
  "groups": [ { "name": "red",  "quota": 2, "candidates": ["…"], "candidateCount": 3 },
              { "name": "blue", "quota": 1, "candidates": ["…"], "candidateCount": 2 } ],
  "results": [
    { "name": "red",  "quota": 2, "order": ["carol", "bob", "alice"], "winners": ["carol", "bob"],
      "effectiveWinners": ["carol", "bob"],
      "candidates": ["alice","bob","carol"], "candidateCount": 3 },
    { "name": "blue", "quota": 1, "order": ["erin", "dave"], "winners": ["erin"],
      "effectiveWinners": ["erin"],
      "candidates": ["dave","erin"], "candidateCount": 2 }
  ],
  "forfeits": [],
  "revealedAt": "…" }
```

每个结果组中 `order` 为该组全量洗牌顺序，`winners` 为其前 `quota` 名（quota 为 0 时 `winners` 为空数组）；`effectiveWinners` 为放弃递补后的当前有效中奖名单（刚揭示时与 `winners` 相同），`forfeits` 为放弃递补事件日志（刚揭示时为空）。重复揭示返回 `409`。

### 3. 查询状态

```bash
curl http://localhost:3000/draws/<drawId>
```

v3 响应始终包含 `version: "v3"`、`snapshotDigest` 与有序 `groups`（含 `name`/`quota`/`candidates`/`candidateCount`），以及 `groupCount`/`totalQuota`/`candidateCount`；揭示后额外包含 `seed`、`nonce` 与 `results`（每组 `order`/`winners`/`effectiveWinners`——最后一个为放弃递补后的当前有效中奖名单，按名额槽位对齐，`null` 表示空缺），以及按序号排列的放弃递补事件 `forfeits`（未揭示或无人放弃时为空数组）。多人抽签还包含 `participants`（每人 `status: pending|committed|revealed`、承诺与时间戳；secret 在整体揭示前不返回）及 `committedCount` / `revealedCount`。

v1/v2 旧记录的响应保持原样：扁平 `candidates` + `count` + `order`/`winners`，`version` 为 `v1` 或 `v2`（v1 的 `snapshotDigest` 为 `null`），不含 `forfeits`/`effectiveWinners` 字段。

### 3a. 多人模式：创建 + 承诺 + 揭示

```bash
# 1) 创建时声明分组与参与者（参与者顺序固定，即 nonce 拼接顺序）
DRAW=$(curl -s -X POST http://localhost:3000/draws \
  -H 'content-type: application/json' \
  -d '{"groups":[
        {"name":"red","quota":2,"candidates":["alice","bob","carol"]},
        {"name":"blue","quota":1,"candidates":["dave","erin"]}
      ],
       "participants":["alice","bob","carol"]}')
ID=$(echo "$DRAW" | sed -E 's/.*"drawId":"([^"]+)".*/\1/')

# 2) 每人本地生成 secret，只提交其 SHA-256 承诺
for name in alice bob carol; do
  read -s secret"?$name secret: "   # 或自行生成：openssl rand -hex 32
  curl -s -X POST http://localhost:3000/draws/$ID/participants/$name/commitment \
    -H 'content-type: application/json' \
    -d "{\"commitment\":\"$(printf %s "$secret" | sha256sum | cut -d' ' -f1)\"}"
done

# 3) 全部承诺后再揭示 secret（可乱序；最后一个揭示触发开奖）
curl -s -X POST http://localhost:3000/draws/$ID/participants/carol/reveal \
  -H 'content-type: application/json' -d '{"secret":"carol-secret"}'
curl -s -X POST http://localhost:3000/draws/$ID/participants/alice/reveal \
  -H 'content-type: application/json' -d '{"secret":"alice-secret"}'
curl -s -X POST http://localhost:3000/draws/$ID/participants/bob/reveal \
  -H 'content-type: application/json' -d '{"secret":"bob-secret"}'
```

最后一个揭示的响应与单 nonce 模式结构一致（`seed` / `nonce` / 分组 `results`），并额外给出：

```json
{ "mode": "multiparty", "status": "revealed", "version": "v3", "snapshotDigest": "3e93e0a1…",
  "nonce": "<sha256(alice-secret)><sha256(bob-secret)><sha256(carol-secret)>",
  "participants": [ { "name": "alice", "position": 0, "status": "revealed",
                      "commitment": "…", "secret": "alice-secret", "secretHash": "…" } ],
  "contributions": [ { "name": "alice", "position": 0, "commitment": "…",
                       "secret": "…", "secretHash": "…",
                       "committedAt": "…", "revealedAt": "…" } ] }
```

阶段/顺序错误码：

| 场景 | 状态码 |
|---|---|
| 缺少 `groups` 或分组约束不合法（组名重复、候选空/重复、quota 超员、总名额 0 等） | `400` |
| 未声明的参与者名字提交承诺/揭示 | `400` |
| 承诺不是 64 位小写 hex | `400` |
| 同一参与者重复承诺 / 重复揭示 | `409` |
| 尚有参与者未承诺就揭示（附 `waitingFor`） | `409` |
| secret 与其承诺不一致 | `409` |
| 开奖后再提交承诺/揭示（附最终 `draw`） | `409` |
| 对多人抽签调 `/reveal`，或对单人抽签调参与者接口 | `409` |

### 4. 放弃与递补（仅已揭示的 v3 抽签）

按「抽签 + 组名 + 候选名」提交放弃；服务端在同一事务中校验放弃者确为该组**当前有效中奖者**、追加带连续序号的事件，并按该组洗牌顺序选首位未中奖且未放弃者递补：

```bash
curl -X POST http://localhost:3000/draws/<drawId>/forfeits \
  -H 'content-type: application/json' \
  -d '{"group":"red","candidate":"carol"}'
```

```json
{ "drawId": "…",
  "event": { "seq": 1, "group": "red", "candidate": "carol",
             "replacement": "alice", "createdAt": "…" },
  "effectiveWinners": { "red": ["alice", "bob"], "blue": ["erin"] },
  "forfeits": [ { "seq": 1, "group": "red", "candidate": "carol",
                  "replacement": "alice", "createdAt": "…" } ] }
```

- `event.replacement` 为本次递补者；候补耗尽时为 `null`，该名额空缺（`effectiveWinners` 中对应槽位为 `null`）。
- 递补上任者也是当前有效中奖者，之后同样可以放弃（事件序号连续递增）。
- 响应中的 `effectiveWinners` 按组名给出各组当前有效中奖名单（槽位对齐）；完整事件日志见 `forfeits`，与 `GET /draws/:id` 返回的一致。

错误码：

| 场景 | 状态码 |
|---|---|
| 抽签不存在 | `404` |
| 缺少 `group`/`candidate` 或字段为空 | `400` |
| 组名未在该抽签中声明 | `400` |
| 抽签尚未揭示（`pending`/`committed`） | `409` |
| v1/v2 旧记录（开奖即终态，不支持放弃） | `409` |
| 候选不是该组当前有效中奖者（未中奖/已放弃/他组候选；响应附当前 `effectiveWinners`） | `409` |

### 5. 独立校验（核心）

提交版本、承诺、seed、nonce 与快照（v3 为 `groups`；旧版为 `candidates`/`count`），服务端按版本重算承诺与结果，并逐项指出篡改：

```bash
curl -X POST http://localhost:3000/verify \
  -H 'content-type: application/json' \
  -d '{"version":"v3","snapshotDigest":"3e93e0a1…","commitment":"9a34e8f9…",
       "seed":"bf723339…","nonce":"public-input-2026-09-27",
       "groups":[
         {"name":"red","quota":2,"candidates":["alice","bob","carol"]},
         {"name":"blue","quota":1,"candidates":["dave","erin"]}],
       "results":[
         {"name":"red","quota":2,"order":["carol","bob","alice"],"winners":["carol","bob"]},
         {"name":"blue","quota":1,"order":["erin","dave"],"winners":["erin"]}]}'
```

```json
{ "valid": true, "version": "v3", "snapshotDigest": "3e93e0a1…",
  "checks": {
    "groupsValid": true, "snapshotDigestMatch": true, "commitmentMatch": true,
    "resultsCountMatch": true, "groupNamesMatch": true, "membershipMatch": true,
    "quotasMatch": true, "ordersMatch": true, "winnersMatch": true },
  "expected": { "results": [ { "name": "red",  "quota": 2, "order": ["…"], "winners": ["…"] },
                             { "name": "blue", "quota": 1, "order": ["…"], "winners": ["…"] } ] },
  "problems": [] }
```

任一字段被篡改时 `valid=false`，`problems` 会**指明是哪一类、哪一组**不一致：

- `snapshot digest mismatch` / `commitment mismatch`——**组名、组顺序、归属候选或 quota** 已被篡改；
- `group name mismatch`——结果中的组名/位置与快照不符；
- `membership mismatch`——某组 `order` 不是该组候选的排列（归属被改）；
- `quota mismatch`——结果携带的 quota 与快照不符（名额被改）；
- `order mismatch` / `winners mismatch`——某组顺序或前 `quota` 名中奖者与重算结果不符（结果被改）；
- `resultsCountMatch` / `groupsValid`——结果组数不一致或分组结构本身非法。

`results` 为可选：不传时只校验快照承诺并重算 `expected.results`。`snapshotDigest` 也可选（传入时额外做 `snapshotDigestMatch`；不传仍能通过承诺校验发现快照篡改）。

多人抽签可在请求体追加 `contributions`（按参与者顺序的 `{position, commitment, secret}` 列表），服务端额外校验：

- `positionsComplete`：`position` 为从 0 开始的连续序号；
- `commitmentsOpen`：每条都满足 `SHA-256(secret) == commitment`；
- `nonceDerived`：按位置顺序拼接 `SHA-256(secret)` 恰好等于 `nonce`，并用重导出的 nonce 复算各组 `order`。

另外 `GET http://localhost:3000/draws/:id/verify` 可对服务端存储的记录做一致性重算：按记录持久化的 `version` 选择算法（v3 重算分组承诺与各组结果并核对存储的 `snapshotDigest`；v1/v2 走各自旧算法），多人模式自动带上 `contributions` 并检查贡献链。对已揭示的 v3 抽签，还会**按事件顺序重放** `forfeit_events` 日志（响应附带 `forfeits` 与 `expected.effectiveWinners`），新增校验项：

- `forfeitsConsistent`：事件序号从 1 连续；每条事件的放弃者都是该组当时的当前有效中奖者；递补者恰为该组洗牌顺序中首位未中奖且未放弃者（候补耗尽为空缺）。发现**非当前中奖者放弃**、**跳过更靠前候补**、**重复递补**或序号断裂时，该校验项为 `false`，`problems` 指明是哪一个事件、哪一类不一致。

## 算法规范（第三方可独立复算）

- **seed**：32 字节加密随机数，hex 编码（64 字符）；揭示前只公开承诺。
- **分组快照（v3）**：数值一律用**十进制**，字符串一律以 **UTF-8 字节数** 作长度前缀。精确拼接为

  ```
  "v3\n" + "<组数>\n"
  ```

  之后**按组序**对每组拼接（组间无额外分隔符）：

  ```
  "<组名 UTF-8 字节数>:<组名>" + "<quota>" + "\n" + "<候选数>\n"
  "<候选 UTF-8 字节数>:<候选原文>"  × 候选数（无分隔符）
  ```

  长度前缀与各计数值使拼接无歧义（多字节字符按字节数计）。例：单组 `红组`、quota 1、候选 `alice`/`bob` 的快照为

  ```
  "v3\n1\n6:红组1\n2\n5:alice3:bob"
  ```

  `snapshotDigest = SHA-256(snapshot)`（对快照字符串的 UTF-8 字节求哈希）。
- **承诺（按版本）**：
  - `v3`（新建抽签）：`commitment = SHA-256("v3:" + seed + ":" + snapshotDigest)`——绑定 seed 与**整份分组快照**（组名、组顺序、各组归属候选、quota）；
  - `v2`（旧记录）：`commitment = SHA-256("v2:" + seed + ":" + snapshotDigest)`，快照为 `"<count>\n" + 每项 "<字节数>:<候选>"`；
  - `v1`（更早的记录，无版本标记）：`commitment = SHA-256(seed)`。
- **参与者承诺**：`commitment_i = SHA-256(secret_i)`，64 字符 hex；揭示时必须精确匹配。
- **熵汇聚 nonce（多人模式）**：按创建时声明的固定参与者顺序（position 0…n−1）拼接
  `nonce = SHA-256(secret_0) ‖ SHA-256(secret_1) ‖ … ‖ SHA-256(secret_(n−1))`，每段固定 64 hex（无分隔符）。单 nonce 模式直接使用调用方提交的 nonce。
- **v3 随机块（每组独立）**：对组序号 `g`（从 0 开始，按创建组序）、块序号 `b`（每组各自从 0 开始）：

  ```
  block(g, b) = SHA-256(seed + ":" + nonce + ":" + g + ":" + b)
  ```

  每个 32 字节块按大端序切成 8 个 uint32，依次消费；不同组的块序号互不影响（每组都是独立随机流）。
- **拒绝采样**：取 `[0, n)` 均匀整数时，令 `limit = floor(2^32 / n) * n`，丢弃 `x >= limit` 的样本，返回 `x % n`，消除模偏差。
- **Fisher-Yates（每组）**：对该组候选副本从末尾向前，`j = uniform(i + 1)` 交换，得到该组全量顺序；前 `quota` 个为该组中奖者。所有组合并即抽签最终结果。
- **放弃/递补重放（v3 揭示后）**：每组有 `quota` 个名额槽位，初始持有者为该组洗牌顺序的前 `quota` 名。放弃事件按序号（每抽签从 1 连续递增）逐条重放：放弃者必须是某槽位的**当前持有者**（原始中奖者或已递补上任者）；其槽位由该组洗牌顺序中**首位从未中奖且未放弃**的候选接任，无合格候补时槽位空缺（`null`）。递补者上位后同样可放弃。重放全部事件即得当前有效中奖名单——规则完全确定，任何人拿到事件日志都能独立复算并核对。
- **旧版随机流（v1/v2 复算用）**：`block(b) = SHA-256(seed + ":" + nonce + ":" + b)`（无组序号），对扁平候选列表单次洗牌，前 `count` 个为中奖者。

## 本地开发（可选）

需要 Node.js ≥ 22.13（内置 `node:sqlite`）：

```bash
npm ci
npm start     # http://localhost:3000
npm test      # node:test 测试套件（含 v3 分组、多人贡献链、放弃/递补、旧版兼容/迁移与无偏性统计检验）
```

## 项目结构

```
src/lottery.js          v3 分组快照/承诺、各组独立 SHA-256 随机流、拒绝采样、分组 Fisher-Yates、放弃/递补事件重放；保留 v1/v2 扁平算法与多人 secret 哈希汇聚
src/db.js               SQLite 连接、自动建表与旧版 schema 迁移（v0 → v1 → v2 → v3 → v4；v3 增加 groups 列，v4 增加 forfeit_events 事件表）
src/app.js              Fastify 路由（v3 分组创建 / 单人揭示 / 多人承诺·揭示 / 放弃·递补 / 查询 / 按版本校验 v3·v2·v1）
src/index.js            入口：配置、启动、优雅退出
test/api.test.js        v3 单 nonce 端到端、分组输入校验与篡改检测
test/groups.test.js     v3 快照格式、分组承诺、每组结果、各类篡改检测与 v2→v4 迁移
test/multiparty.test.js v3 多人承诺模式阶段锁定、越序拒绝、贡献链汇聚与分组结果审计
test/forfeits.test.js   v3 放弃/递补：候补顺位、名额空缺、事件序号、仅当前中奖者可放弃、已存校验重放篡改检测、v1/v2 不受影响
test/snapshot.test.js   v1/v2 旧记录独立校验、旧库逐级迁移到 v4 后仍可查可验
```
