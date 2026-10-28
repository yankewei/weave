<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Cancellation;
use Amp\Parallel\Worker\Task;
use Amp\Sync\Channel;

/**
 * Runs scrypt in a worker so a login never stalls the event loop (~30 ms).
 *
 * @implements Task<string, never, never>
 */
final readonly class DeriveKey implements Task
{
    // libsodium derives N = 2^14, r = 8, p = 1 from these limits: the parameters
    // of Node's scrypt default, so hashes written by the legacy API still verify.
    private const OPS_LIMIT = 524288;
    private const MEM_LIMIT = 33554432;

    /** @param string $salt 32 hex characters, used as bytes like the legacy API did. */
    public function __construct(private string $password, private string $salt)
    {
    }

    public function run(Channel $channel, Cancellation $cancellation): string
    {
        return bin2hex(sodium_crypto_pwhash_scryptsalsa208sha256(
            64,
            $this->password,
            $this->salt,
            self::OPS_LIMIT,
            self::MEM_LIMIT,
        ));
    }
}
