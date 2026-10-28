<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

// The client streams bodies, which can be read only once; tests read them freely.
final readonly class TestResponse
{
    /** @param array<string, list<string>> $headers Lower-cased names. */
    public function __construct(public int $status, private array $headers, public string $body)
    {
    }

    public function header(string $name): string
    {
        return $this->headers[$name][0] ?? '';
    }
}
