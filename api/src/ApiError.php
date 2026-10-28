<?php

declare(strict_types=1);

namespace Weave\Api;

// ApiMiddleware turns it into the `{statusCode, message}` body the web client reads.
final class ApiError extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
