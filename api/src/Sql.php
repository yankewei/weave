<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

final class Sql
{
    /**
     * @template T
     * @param \Closure(PostgresExecutor): T $run
     * @return T
     */
    public static function transaction(PostgresConnectionPool $database, \Closure $run): mixed
    {
        $transaction = $database->beginTransaction();
        try {
            $result = $run($transaction);
            $transaction->commit();

            return $result;
        } finally {
            if ($transaction->isActive()) {
                $transaction->rollback();
            }
        }
    }

    // node-pg handed timestamps to JSON.stringify as Date, so clients read this shape.
    public static function iso(string $column): string
    {
        return "to_char({$column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
    }

    /** @param array<string, mixed>|null $row */
    public static function string(?array $row, string $column): string
    {
        $value = $row[$column] ?? null;
        if (!is_string($value)) {
            throw new \UnexpectedValueException("Expected a string in column {$column}");
        }

        return $value;
    }
}
