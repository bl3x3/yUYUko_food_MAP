# 用户行为采集与用户向量

启动后自动迁移，使用现有 SQLite 和地点向量，不需要新增依赖或模型调用。
用户向量已接入“随机美食”；具体范围和抽取概率见 [随机美食说明](services/randomRecommendation.md)。语义搜索仍按当前搜索需求检索。

## 采集口径

- 仅登录用户在已入库地点上的主动操作；用户身份来自现有 `requireAuth`。
- 收藏/取消收藏：复用 `/api/favorites/:placeId`，状态发生变化时在同一个事务中写入事件。重复请求不重复记录。
- 导航：用户选定具体地图应用时记录 `navigation`，表示点击意图，不表示已打开应用或到店。
- 原生分享：`navigator.share()` 成功返回后记录 `share`，表示内容交给系统/应用，不表示收件人收到。
- 复制分享链接/地点信息：剪贴板操作成功后记录 `share_copy`。取消分享、复制失败、仅打开面板不计入。
- 接收分享链接、分享预览爬虫和自动导航跳转不归入主动操作；不会归因给分享者。
- 前端以带 Bearer token 的 `fetch(..., { keepalive: true })` 尽力上报，不阻塞导航/分享，也不因采集失败弹出登录或错误提示。离线、浏览器终止请求时可能丢失这些事件；不保存跨账号的待发送队列。

`UserBehaviorEvent` 保存服务端毫秒时间、用户、地点、事件 ID、类型、渠道及 `contributes`。
同一用户与事件 ID 幂等；相同 ID 用于不同操作返回 409。不同 ID 的同一用户/地点/类型在 30 分钟内仍保留原始事件，但 `contributes = 0`，不再影响偏好。导航渠道共用冷却期，冷却期以最近一次有效事件为起点。每用户每分钟最多接受 60 个客户端事件（收藏事件也占用该统计窗口）。

## API

`POST /api/preferences/events`，需要登录：

```json
{
  "event_id": "a-unique-client-event-id",
  "place_id": 123,
  "event_type": "navigation",
  "channel": "amap"
}
```

允许的类型与渠道：

| 类型 | 渠道 |
| --- | --- |
| `navigation` | `system-default`, `apple-maps`, `amap`, `tencent`, `google` |
| `share` | `place`, `amap` |
| `share_copy` | `place`, `amap`, `place_info` |

事件 ID 为 16–80 个字母、数字、下划线或连字符。客户端不能提交收藏事件、指定用户、权重或时间。
新事件返回 201 和 `{ recorded: true, counted: true/false }`；冷却期内含 `reason: "cooldown"`；重复 ID 返回 200 和 `{ recorded: false, reason: "duplicate" }`。

`GET /api/preferences/me` 仅返回当前登录用户的向量和计算信息，响应不缓存。

- `status`: `ready`（至少一个有效地点向量）、`empty`（没有有效兴趣来源）、`pending`（有来源但没有可用合成向量）、`unavailable`（sqlite-vec 未加载）。
- `vector`: 1024 维归一化数组，尚不可用时为 `null`，不以全零向量冒充画像。
- `model`, `dimensions`, `algorithm_version`: 向量模型与计算版本。
- `source_place_count`, `vector_place_count`: 有兴趣的地点数与实际参与计算的地点数；两者不同表示地点向量覆盖不完整。
- `total_weight`: 实际参与合成的地点权重之和。
- `updated_at`: 服务端 Unix 毫秒时间。

## 算法 v1

只使用最近 180 天 `contributes = 1` 的导航/分享/复制事件。每个事件先按 30 天半衰期衰减，然后按店铺和行为类型求和：

```text
有效次数(type, place) = Σ 2 ^ (-事件距今天数 / 30)
店铺权重 = min(12,
    5 × 当前是否收藏
    + 3 × ln(1 + 有效导航次数)
    + 2 × ln(1 + 有效分享次数)
    + 1 × ln(1 + 有效复制次数))
用户向量 = normalize(Σ 店铺权重 × normalize(地点向量))
```

收藏依赖当前 `Favorite` 状态；历史收藏增删事件只留作记录，不重复加权。既有收藏会直接参与计算，不补造历史事件。取消收藏撤销该店的收藏权重，其他有效行为仍然保留。
仅使用仍存在且 `has_vector = 1` 的地点向量；缺失、待更新、零或无效向量跳过。
模型沿用现有地点索引的配置，默认 `Qwen/Qwen3-Embedding-4B`。现有地点索引没有逐条模型版本标记，因此更换 Embedding 模型时必须先全量重建地点索引，再重算用户向量，不能仅凭维度相同混用。

## 更新与维护

`UserPreference` 保存 Float32 BLOB、计算信息和 `dirty` 标记。
行为/收藏变化后在后续事件循环中自动重算。数据库触发器也会在相关地点向量或语义字段更新、地点删除时将用户向量标记为待更新。
后台每分钟处理最多 20 个待更新或超过 6 小时的画像，启动后会处理既有收藏。读取自己的画像时也会检查版本、时效与待更新标记。时间衰减因此不要求用户再发生新操作。
sqlite-vec 不可用时仍可采集；地点向量补齐后自动重新参与计算。删除用户会级联删除其行为和向量；删除地点会删除相关行为并使画像失效。

验证：在 `backend/` 执行 `npm run test:preferences`，使用独立临时数据库、合成地点向量及本地 HTTP 服务，不访问模型服务、生产数据库或真实 Redis。
