import type {
  RunLease,
  RunLeaseAcquire,
  RunLeaseRelease,
  RunLeaseRenew,
  RunLeaseToken
} from "@lecoding/contracts";

/**
 * 与 @lecoding/run-events 中 PostgresExecutor 结构兼容的最小查询接口。
 * 不直接引用 run-events 包以避免循环依赖。
 */
export interface PostgresExecutor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[]
  ): Promise<{ rows: Row[] }>;
}

/**
 * 基于 PostgreSQL 行锁 + generation 乐观锁的持久化租约实现。
 *
 * 设计要点:
 * - run_id 主键保证每个 Run 只有一条租约记录
 * - generation 世代号:acquire/renew/release/invalidate 都自增,
 *   作为乐观锁版本号。调用方持有的 token 带自己的 generation,
 *   后续操作必须匹配才能成功——这是"顺序约束"的核心:
 *   任何导致租约所有权变更的事件都会让旧 token 失效,
 *   哪怕 owner 还没换(如 invalidate 同 owner 作废)。
 * - lease_until 过期时间:作为 acquire 时的补充判定
 *   (已过期的租约视同未持有,允许新 owner 接管)。
 * - 幂等:release/invalidate 多次调用均安全(generation 每次自增,
 *   但结果一致:下一次 renew 必失败)。
 *
 * 跨进程 invalidate 延迟问题的解:
 * - invalidate 自增 generation,当前 owner 持旧 token,下一次 renew
 *   因版本不匹配立即失败——不需要等 lease_until 过期,
 *   也不需要等失败 Worker 的下一次心跳。
 * - 与 heartbeat.withHeartbeat 配合:心跳续约失败时主动 invalidate,
 *   保证失效信号立即落库。
 */
export async function createPostgresRunLease(
  executor: PostgresExecutor
): Promise<RunLease> {
  await ensureSchema(executor);

  return {
    async acquire(input: RunLeaseAcquire): Promise<RunLeaseToken | undefined> {
      /*
       * INSERT ... ON CONFLICT DO UPDATE:原子地"接管或新建"。
       * WHERE 子句限定只有在"原租约已过期或就是我自己"时才允许覆盖。
       * 若被其他 owner 持有且未过期,DO UPDATE 不更新行,返回 0 行。
       */
      const { rows } = await executor.query<{
        run_id: string;
        owner_id: string;
        generation: number;
      }>(
        `
        INSERT INTO run_engine_leases (run_id, owner_id, lease_until, generation)
        VALUES ($1::text, $2::text, $3::timestamptz, 1)
        ON CONFLICT (run_id) DO UPDATE
          SET owner_id = EXCLUDED.owner_id,
              lease_until = EXCLUDED.lease_until,
              generation = run_engine_leases.generation + 1
          WHERE run_engine_leases.lease_until < transaction_timestamp()
             OR run_engine_leases.owner_id = EXCLUDED.owner_id
        RETURNING run_id, owner_id, generation;
        `,
        [input.runId, input.ownerId, input.leaseUntil]
      );

      if (rows.length === 0) {
        return undefined;
      }
      const row = rows[0]!;
      return {
        runId: row.run_id,
        ownerId: row.owner_id,
        generation: Number(row.generation)
      };
    },

    async renew(input: RunLeaseRenew): Promise<boolean> {
      /*
       * 续约:只更新 lease_until,不改变 generation。
       * 校验 owner + generation(若提供):generation 不匹配意味着
       * 期间发生过 invalidate/新 owner 接管,旧 token 必须立即失效。
       * 注意 generation 不自增——同一 token 持有期间版本号不变,
       * 避免 token 里的 generation 过时导致后续 renew 失败。
       */
      const whereGeneration =
        input.generation !== undefined ? "AND generation = $4::bigint" : "";
      const params: unknown[] = [input.runId, input.ownerId, input.leaseUntil];
      if (input.generation !== undefined) {
        params.push(input.generation);
      }
      const { rows } = await executor.query<{ ok: boolean }>(
        `
        UPDATE run_engine_leases
           SET lease_until = $3::timestamptz
         WHERE run_id = $1::text
           AND owner_id = $2::text
           ${whereGeneration}
        RETURNING true AS ok;
        `,
        params
      );
      return rows.length > 0;
    },

    async release(input: RunLeaseRelease): Promise<void> {
      /*
       * 释放:把 lease_until 设为 -infinity。
       * 只校验 owner,不校验 generation——主动放弃无需版本判定。
       * 不自增 generation:新 owner acquire 时会自增,不需要 release 做。
       * 若 owner 已被替换,release 不改动任何行(静默成功)。
       */
      await executor.query(
        `
        UPDATE run_engine_leases
           SET lease_until = '-infinity'::timestamptz
         WHERE run_id = $1::text
           AND owner_id = $2::text;
        `,
        [input.runId, input.ownerId]
      );
    },

    async invalidate(input: RunLeaseRelease): Promise<void> {
      /*
       * 强制作废:把 lease_until 推到 -infinity 并自增 generation。
       * 只校验 owner,不校验 generation——只要是当前 owner 就能作废。
       * generation 自增后,当前 owner 持有的旧 token 下次 renew 必失败
       * (因为 renew 校验 generation)。
       * 这是跨进程旁路的核心:失效信号落地即生效,无需等待自然过期。
       */
      await executor.query(
        `
        UPDATE run_engine_leases
           SET lease_until = '-infinity'::timestamptz,
               generation = generation + 1
         WHERE run_id = $1::text
           AND owner_id = $2::text;
        `,
        [input.runId, input.ownerId]
      );
    }
  };
}

async function ensureSchema(executor: PostgresExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS run_engine_leases (
      run_id      TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      lease_until TIMESTAMPTZ NOT NULL,
      generation  BIGINT NOT NULL DEFAULT 0
    );
  `);
}
