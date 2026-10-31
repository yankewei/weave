# 默认图片存储是部署自带的 S3

工作空间没有配置自己的 S3 时，图片存到部署级别的 S3 兼容存储，用 `S3_ENDPOINT`、`S3_BUCKET` 等环境变量配置。`docker compose` 自带一个 RustFS 作为这份默认存储，生产环境也可以把这些变量指向 AWS S3、Cloudflare R2 等外部服务。这样 PHP 只需要实现一种存储协议：工作空间 S3 和默认存储走同一个客户端，区别只在凭据来自哪里。

原来的默认存储 Vercel Blob 一并去掉。ADR 0002 之后应用不再部署在 Vercel，继续依赖它需要照着非公开的 API 手写客户端；而且 Vercel Blob 里没有真实数据，所以直接删除 `backend = 'blob'` 的记录，不做迁移。

## Considered Options

- 本地卷：最简单，但默认存储和工作空间 S3 成了两套实现，api 以后也没法多实例运行。
- 继续用 Vercel Blob：行为不变，但离开 Vercel 之后还要为它保留令牌和一套手写客户端。
- compose 里不带对象存储：本地开发和测试都要另外准备 S3，上手成本高。
- MinIO：开源仓库已归档，不再发布安全修复。Garage 和 SeaweedFS 更成熟，但首次启动需要额外的初始化命令。RustFS 用法最接近 MinIO，1.0 已发布稳定版。

## Consequences

- `uploads.backend` 的取值从 `blob`、`s3` 改为 `default`、`s3`。`default` 的图片按当前部署的默认存储读取，换了默认存储的桶，已有图片就读不到。
- api 启动时创建默认存储的桶（已存在则不变），compose、CI 和测试都不需要单独的初始化步骤。
- 没有配置 `S3_ENDPOINT` 时，没有自定义 S3 的工作空间上传图片返回 503。
- 本地运行 API 测试除了 Postgres，还需要 RustFS：`pnpm db:up` 会同时启动两者。
